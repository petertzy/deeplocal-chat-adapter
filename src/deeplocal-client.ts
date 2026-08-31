import { getConfig } from './config';
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

  constructor(private readonly logger: Logger) {}

  async listModels(): Promise<DeepLocalModel[]> {
    const response = await this.request('/models', { method: 'GET' });
    const body = await response.json() as ModelsResponse;
    return Array.isArray(body.data) ? body.data.filter((model) => Boolean(model.id)) : [];
  }

  async checkConnection(): Promise<boolean> {
    try {
      const models = await this.listModels();
      this.logger.info(`DeepLocal connection OK. Found ${models.length} model(s).`);
      return true;
    } catch (error) {
      this.logger.warning(`DeepLocal connection check failed: ${messageOf(error)}`);
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
    const config = getConfig();
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
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          ...init.headers,
        },
      });

      if (!response.ok) {
        const details = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} ${response.statusText}${details ? `: ${details}` : ''}`);
      }

      return response;
    } finally {
      clearTimeout(timeout);
    }
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
