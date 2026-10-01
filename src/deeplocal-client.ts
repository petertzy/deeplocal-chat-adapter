import { DeepLocalConfig, getConfig } from './config';
import { Logger } from './logger';
import { modelInformation } from './model-metadata';
import { parseToolInput } from './tool-input';
import { checkModelsEndpoint, ConnectionResult } from './connection-check';
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

interface RequestContext {
  response: Response;
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
}

export class DeepLocalClient {
  private readonly controllers = new Map<string, AbortController>();
  private remoteApiKey = '';
  private readonly modelMetadata = new Map<string, DeepLocalModel>();

  modelInformation(id: string) {
    const config = this.configuration();
    return modelInformation(this.modelMetadata.get(`${config.backend}:${config.baseUrl}:${id}`), config);
  }

  private rememberModels(models: DeepLocalModel[], config: DeepLocalConfig): DeepLocalModel[] {
    const prefix = `${config.backend}:${config.baseUrl}:`;
    for (const key of this.modelMetadata.keys()) {
      if (key.startsWith(prefix)) this.modelMetadata.delete(key);
    }
    for (const model of models) this.modelMetadata.set(`${prefix}${model.id}`, model);
    return models;
  }
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
        const request = await this.request('/models', { method: 'GET' });
        let body: ModelsResponse;
        try {
          body = await request.response.json() as ModelsResponse;
        } finally {
          request.cleanup();
        }
        const models = Array.isArray(body.data) ? body.data.filter((model) => Boolean(model?.id) && typeof model.id === 'string') : [];
        if (models.length) {
          return this.rememberModels(config.model && !models.some((model) => model.id === config.model)
            ? [{ id: config.model }, ...models]
            : models, config);
        }
      } catch (error) {
        this.logger.warning(`Remote model discovery failed: ${messageOf(error)}`);
      }
      return this.rememberModels(config.model ? [{ id: config.model }] : [], config);
    }
    const request = await this.request('/models', { method: 'GET' });
    let body: ModelsResponse;
    try {
      body = await request.response.json() as ModelsResponse;
    } finally {
      request.cleanup();
    }
    return this.rememberModels(Array.isArray(body.data) ? body.data.filter((model) => Boolean(model?.id) && typeof model.id === 'string') : [], config);
  }

  async checkConnection(): Promise<boolean> {
    return (await this.checkConnectionDetails()).ok;
  }

  async checkConnectionDetails(): Promise<ConnectionResult> {
    const config = this.configuration();
    let result: ConnectionResult;
    try {
      const key = config.backend === 'remote' ? (await this.remoteApiKeyProvider?.() ?? this.remoteApiKey) : config.apiKey;
      result = await checkModelsEndpoint(config.baseUrl, key, config.requestTimeout);
    } catch {
      result = { ok: false, category: 'configuration', endpoint: '(not checked)', message: 'Could not load API credentials. Configure the API key and retry.' };
    }
    const message = `[${result.category}] ${result.endpoint}: ${result.message}`;
    if (result.ok) this.logger.info(message);
    else this.logger.warning(message);
    return result;
  }

  cancel(requestId: string): void {
    this.controllers.get(requestId)?.abort();
    this.controllers.delete(requestId);
  }

  async *streamChat(requestId: string, body: ChatCompletionRequest): AsyncGenerator<StreamEvent> {
    const information = this.modelInformation(body.model);
    if (!information.compatible) throw new Error(information.reason);
    if (body.tools?.length && !information.toolCalling) {
      throw new Error(`${information.reason} Plain chat remains available.`);
    }
    body = body.max_completion_tokens !== undefined
      ? { ...body, max_completion_tokens: Math.min(body.max_completion_tokens, information.maxOutputTokens) }
      : { ...body, max_tokens: Math.min(body.max_tokens ?? information.maxOutputTokens, information.maxOutputTokens) };
    const controller = new AbortController();
    this.controllers.set(requestId, controller);

    try {
      const request = await this.request('/chat/completions', {
        method: 'POST',
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!request.response.body) {
        try {
          throw new Error('DeepLocal returned an empty response body.');
        } finally {
          request.cleanup();
        }
      }

      const reader = request.response.body.getReader();
      const decoder = new TextDecoder();
      const toolBuffer = new Map<number, PendingToolCall>();
      const completion: { finishReason?: string } = {};
      let bufferedText = '';
      let sawDone = false;

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }

          bufferedText += decoder.decode(value, { stream: true });
          const split = splitSseLines(bufferedText);
          bufferedText = split.remainder;

          for (const line of split.lines) {
            if (this.isDoneLine(line)) {
              sawDone = true;
              continue;
            }
            const event = this.readStreamLine(line, toolBuffer, completion);
            if (event) {
              yield event;
            }
          }
        }

        // A provider may close immediately after the final SSE line. SSE does
        // not require that line to end in a newline, so process it after the
        // reader reports EOF. TextDecoder() flushes a split UTF-8 sequence.
        bufferedText += decoder.decode();
        if (bufferedText.trim()) {
          if (this.isDoneLine(bufferedText)) {
            sawDone = true;
          } else {
            const event = this.readStreamLine(bufferedText, toolBuffer, completion);
            if (event) {
              yield event;
            }
          }
        }
        if (!sawDone) {
          throw new Error(`DeepLocal stream ended unexpectedly before [DONE]; ${toolBuffer.size ? 'tool calls are incomplete and were not executed.' : 'the response may be incomplete.'}`);
        }
      } catch (error) {
        throw this.requestError(request, error);
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
        request.cleanup();
      }

      if (toolBuffer.size && completion.finishReason && completion.finishReason !== 'tool_calls' && completion.finishReason !== 'stop') {
        throw new Error('DeepLocal terminated before completing tool calls; no tools were executed. Retry with a larger output limit or another model.');
      }
      for (const call of finishToolCalls(toolBuffer)) {
        yield { kind: 'toolCall', value: call };
      }
    } finally {
      this.controllers.delete(requestId);
    }
  }

  private isDoneLine(line: string): boolean {
    return line.trim() === 'data: [DONE]';
  }

  private readStreamLine(line: string, toolBuffer: Map<number, PendingToolCall>, completion: { finishReason?: string }): StreamEvent | undefined {
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
    } catch {
      throw new Error('DeepLocal stream contained malformed JSON; the response may be incomplete. Retry the request.');
    }

    const finishReason = chunk.choices?.[0]?.finish_reason;
    if (finishReason) completion.finishReason = finishReason;
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) {
      return undefined;
    }

    if (delta.tool_calls?.length) {
      for (const part of delta.tool_calls) {
        let index = part.index;
        if (index === undefined) {
          const matching = [...toolBuffer.entries()].find(([, call]) => part.id && call.id === part.id);
          if (matching) index = matching[0];
          else if (!toolBuffer.size && delta.tool_calls.length === 1) index = 0;
          else if (toolBuffer.size === 1 && delta.tool_calls.length === 1 && !part.id) index = toolBuffer.keys().next().value;
          else throw new Error('Ambiguous tool delta without an index; retry with a server that identifies each parallel call.');
        }
        if (index === undefined || !Number.isSafeInteger(index) || index < 0) throw new Error('Invalid tool-call index. Retry the request.');
        const pending = toolBuffer.get(index) ?? { arguments: '' };
        if (part.id && pending.id && part.id !== pending.id) throw new Error('Conflicting tool-call IDs for one index. Retry the request.');
        pending.id = part.id ?? pending.id;
        pending.name = (pending.name ?? '') + (part.function?.name ?? '');
        pending.arguments += part.function?.arguments ?? '';
        toolBuffer.set(index, pending);
      }
    }

    return delta.content ? { kind: 'text', value: delta.content } : undefined;
  }

  private requestError(request: RequestContext, error: unknown): Error {
    if (request.timedOut()) {
      this.logger.warning('DeepLocal request timed out while waiting for the response or stream body.');
      return new Error('DeepLocal request timed out while waiting for the response or stream body.');
    }
    if (request.signal.aborted) {
      this.logger.info('DeepLocal request cancelled by the user.');
      return new Error('DeepLocal request was cancelled.');
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private async request(path: string, init: RequestInit): Promise<RequestContext> {
    const config = this.configuration();
    const apiKey = config.backend === 'remote'
      ? (await this.remoteApiKeyProvider?.() ?? this.remoteApiKey)
      : config.apiKey;
    if (config.backend === 'remote' && !apiKey) {
      throw new Error('Remote API key is missing. Use the remote API key control in the chat panel or run “deeplocal-chat-adapter: Set Remote API Key”.');
    }
    const url = `${config.baseUrl}${path}`;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(config.requestTimeout, 1000));
    const upstreamSignal = init.signal;
    const onAbort = () => controller.abort();

    if (upstreamSignal) {
      if (upstreamSignal.aborted) {
        controller.abort();
      } else {
        upstreamSignal.addEventListener('abort', onAbort, { once: true });
      }
    }

    try {
      this.logger.debug(`${init.method ?? 'GET'} ${url}`);
      const requestBody = init.body && config.backend === 'remote' ? remoteCompatibleBody(init.body) : init.body;
      const requestInit: RequestInit = {
        ...init,
        ...(requestBody !== undefined ? { body: requestBody } : {}),
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...init.headers,
        },
      };
      let response = await fetch(url, requestInit);
      let responseBody = '';

      if (!response.ok) {
        responseBody = await response.text().catch(() => '');
        const retryBody = config.backend === 'remote'
          ? retryWithNoReasoningEffort(requestBody, responseBody)
          : undefined;
        if (response.status === 400 && retryBody) {
          this.logger.info('Remote API requested reasoning_effort=none for function tools; retrying once with tools preserved.');
          response = await fetch(url, { ...requestInit, body: retryBody });
          responseBody = response.ok ? '' : await response.text().catch(() => '');
        }
      }

      if (!response.ok) {
        const backend = config.backend === 'remote' ? 'Remote API' : 'DeepLocal';
        const safeDetail = safeErrorDetail(responseBody, apiKey);
        const detail = response.status === 401 || response.status === 403
          ? 'Authentication failed. Check the API key.'
          : response.status === 404
            ? `Endpoint or model not found.${safeDetail ? ` ${safeDetail}` : ''}`
            : `HTTP ${response.status} ${response.statusText}${safeDetail ? `: ${safeDetail}` : ''}`;
        throw new Error(`${backend} request failed: ${detail}`);
      }

      return {
        response,
        signal: controller.signal,
        timedOut: () => timedOut,
        cleanup: () => {
          clearTimeout(timeout);
          upstreamSignal?.removeEventListener('abort', onAbort);
        },
      };
    } catch (error) {
      const context = { response: undefined as never, signal: controller.signal, timedOut: () => timedOut, cleanup: () => {
        clearTimeout(timeout);
        upstreamSignal?.removeEventListener('abort', onAbort);
      } };
      throw this.requestError(context, error);
    }
  }
}

function splitSseLines(input: string): { lines: string[]; remainder: string } {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character !== '\r' && character !== '\n') continue;
    lines.push(input.slice(start, index));
    if (character === '\r' && input[index + 1] === '\n') index += 1;
    start = index + 1;
  }
  return { lines, remainder: input.slice(start) };
}

function remoteCompatibleBody(body: BodyInit): BodyInit {
  if (typeof body !== 'string') return body;
  try {
    const request = JSON.parse(body) as Record<string, unknown>;
    if (typeof request.max_tokens === 'number' && request.max_completion_tokens === undefined) {
      request.max_completion_tokens = request.max_tokens;
      delete request.max_tokens;
    }
    return JSON.stringify(request);
  } catch {
    return body;
  }
}

function retryWithNoReasoningEffort(body: BodyInit | null | undefined, errorBody: string): BodyInit | undefined {
  if (typeof body !== 'string') return undefined;
  try {
    const parsedError = JSON.parse(errorBody) as { error?: { message?: unknown } };
    const message = typeof parsedError.error?.message === 'string'
      ? parsedError.error.message.replace(/\\_/g, '_').toLowerCase()
      : '';
    if (!message.includes('function tools') || !message.includes('reasoning_effort') || !message.includes("'none'")) {
      return undefined;
    }
    const request = JSON.parse(body) as Record<string, unknown>;
    if (!Array.isArray(request.tools) || request.tools.length === 0) return undefined;
    request.reasoning_effort = 'none';
    return JSON.stringify(request);
  } catch {
    return undefined;
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
    .map(([index, call]) => {
      if (!call.id || !call.name) throw new Error(`Incomplete tool call at index ${index}: missing ID or name. Retry the request.`);
      parseToolInput(call.arguments);
      return {
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: call.arguments,
        },
      };
    });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
