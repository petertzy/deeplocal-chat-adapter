import { DeepLocalConfig, getConfig } from './config';
import { Logger } from './logger';
import {
  ChatCompletionChunk,
  ChatCompletionRequest,
  DeepLocalModel,
  ModelsResponse,
  StreamEvent,
  ToolCall,
} from './protocol';

interface PendingToolCall {
  id?: string;
  name?: string;
  arguments: string;
}

export class DeepLocalClient {
  private readonly controllers = new Map<string, AbortController>();
  private remoteApiKey = '';
  private remoteApiKeyProvider: (() => Promise<string | undefined>) | undefined;

  constructor(
    private readonly logger: Logger,
    private readonly configuration: () => DeepLocalConfig = getConfig,
  ) {}

  setRemoteApiKey(apiKey: string): void { this.remoteApiKey = apiKey; }
  setRemoteApiKeyProvider(provider: () => PromiseLike<string | undefined>): void { this.remoteApiKeyProvider = async () => provider(); }
  activeBackend(): 'local' | 'remote' { return this.configuration().backend; }

  async listModels(): Promise<DeepLocalModel[]> {
    const config = this.configuration();
    if (config.backend === 'remote') {
      try {
        const response = await this.request('/models', { method: 'GET' });
        const body = await response.json() as ModelsResponse;
        const models = Array.isArray(body.data) ? body.data.filter((model) => Boolean(model.id)) : [];
        if (models.length) {
          return config.model && !models.some((model) => model.id === config.model)
            ? [{ id: config.model }, ...models]
            : models;
        }
      } catch (error) {
        this.logger.warning(`Remote model discovery failed: ${messageOf(error)}`);
      }
      return config.model ? [{ id: config.model }] : [];
    }
    const response = await this.request('/models', { method: 'GET' });
    const body = await response.json() as ModelsResponse;
    return Array.isArray(body.data) ? body.data.filter((model) => Boolean(model.id)) : [];
  }

  async checkConnection(): Promise<boolean> {
    try {
      const models = await this.listModels();
      this.logger.info(`${this.activeBackend()} connection OK. Found ${models.length} model(s).`);
      return true;
    } catch (error) {
      this.logger.warning(`${this.activeBackend()} connection check failed: ${messageOf(error)}`);
      return false;
    }
  }

  cancel(requestId: string): void {
    this.controllers.get(requestId)?.abort();
    this.controllers.delete(requestId);
  }

  async *streamChat(requestId: string, body: ChatCompletionRequest): AsyncGenerator<StreamEvent> {
    const controller = new AbortController();
    this.controllers.set(requestId, controller);

    try {
      const response = await this.request('/chat/completions', {
        method: 'POST',
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.body) {
        throw new Error('DeepLocal returned an empty response body.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const toolBuffer = new Map<number, PendingToolCall>();
      let bufferedText = '';

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }

          bufferedText += decoder.decode(value, { stream: true });
          const lines = bufferedText.split(/\r?\n/);
          bufferedText = lines.pop() ?? '';

          for (const line of lines) {
            const event = this.readStreamLine(line, toolBuffer);
            if (event) {
              yield event;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      for (const call of finishToolCalls(toolBuffer)) {
        yield { kind: 'toolCall', value: call };
      }
    } finally {
      this.controllers.delete(requestId);
    }
  }

  private readStreamLine(line: string, toolBuffer: Map<number, PendingToolCall>): StreamEvent | undefined {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) {
      return undefined;
    }

    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') {
      return undefined;
    }

    let chunk: ChatCompletionChunk;
    try {
      chunk = JSON.parse(data) as ChatCompletionChunk;
    } catch (error) {
      this.logger.warning(`Ignored malformed DeepLocal stream event: ${messageOf(error)}`);
      return undefined;
    }

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) {
      return undefined;
    }

    if (delta.tool_calls?.length) {
      for (const part of delta.tool_calls) {
        const index = part.index ?? 0;
        const pending = toolBuffer.get(index) ?? { arguments: '' };
        pending.id = part.id ?? pending.id;
        pending.name = part.function?.name ?? pending.name;
        pending.arguments += part.function?.arguments ?? '';
        toolBuffer.set(index, pending);
      }
      return undefined;
    }

    return delta.content ? { kind: 'text', value: delta.content } : undefined;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const config = this.configuration();
    const apiKey = config.backend === 'remote'
      ? (await this.remoteApiKeyProvider?.() ?? this.remoteApiKey)
      : config.apiKey;
    if (config.backend === 'remote' && !apiKey) {
      throw new Error('Remote API key is missing. Use the remote API key control in the chat panel or run “deeplocal-chat-adapter: Set Remote API Key”.');
    }
    const url = `${config.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(config.requestTimeout, 1000));
    const upstreamSignal = init.signal;

    if (upstreamSignal) {
      if (upstreamSignal.aborted) {
        controller.abort();
      } else {
        upstreamSignal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }

    try {
      this.logger.debug(`${init.method ?? 'GET'} ${url}`);
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...init.headers,
        },
      });

      if (!response.ok) {
        const backend = config.backend === 'remote' ? 'Remote API' : 'DeepLocal';
        const body = await response.text().catch(() => '');
        const safeDetail = safeErrorDetail(body, apiKey);
        const detail = response.status === 401 || response.status === 403
          ? 'Authentication failed. Check the API key.'
          : response.status === 404
            ? `Endpoint or model not found.${safeDetail ? ` ${safeDetail}` : ''}`
            : `HTTP ${response.status} ${response.statusText}${safeDetail ? `: ${safeDetail}` : ''}`;
        throw new Error(`${backend} request failed: ${detail}`);
      }

      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function safeErrorDetail(body: string, apiKey: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message !== 'string') return '';
    let message = parsed.error.message.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    message = message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
    if (apiKey) message = message.split(apiKey).join('[redacted]');
    return message.slice(0, 240);
  } catch {
    return '';
  }
}

function finishToolCalls(buffer: Map<number, PendingToolCall>): ToolCall[] {
  return Array.from(buffer.entries())
    .sort(([left], [right]) => left - right)
    .filter(([, call]) => Boolean(call.id && call.name))
    .map(([, call]) => ({
      id: call.id as string,
      type: 'function',
      function: {
        name: call.name as string,
        arguments: call.arguments || '{}',
      },
    }));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
