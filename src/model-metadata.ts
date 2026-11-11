import { DeepLocalConfig } from './config';
import { DeepLocalModel } from './protocol';

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Only validated hints override settings; unknown protocols are never guessed. */
export function modelInformation(model: DeepLocalModel | undefined, config: DeepLocalConfig) {
  const capabilities = model?.capabilities && typeof model.capabilities === 'object'
    ? model.capabilities as Record<string, unknown> : {};
  // The deepLocal desktop API currently exposes chat completions but does not
  // implement OpenAI tool-call requests. Do not infer tool support from a GGUF
  // model's capabilities when the server cannot transport tool calls.
  const desktopApi = config.backend === 'local' && model?.owned_by === 'deeplocal';
  const hint = desktopApi ? false
    : typeof capabilities.tool_calling === 'boolean' ? capabilities.tool_calling : model?.supports_tool_calls;
  const protocol = typeof model?.protocol === 'string' && model.protocol.trim() ? model.protocol.trim() : undefined;
  const endpoint = typeof model?.endpoint === 'string' && model.endpoint.trim() ? model.endpoint.trim() : undefined;
  const apiMode = config.apiMode ?? 'chat-completions';
  const endpoints = apiMode === 'responses' ? ['/responses', '/v1/responses'] : ['/chat/completions', '/v1/chat/completions'];
  const compatible = (!protocol || ['openai', 'openai-compatible', apiMode].includes(protocol))
    && (!endpoint || endpoints.includes(endpoint));
  const toolCalling = config.enableToolCalling && compatible && (typeof hint === 'boolean' ? hint : true);
  const reason = !compatible ? `Unsupported model protocol/endpoint: ${protocol ?? 'unspecified'} / ${endpoint ?? 'unspecified'}.`
    : !config.enableToolCalling ? 'Tool calling is disabled in settings.'
      : desktopApi ? 'The deepLocal desktop API does not support tool calls yet. Switch to Chat mode to send messages.'
        : hint === false ? 'The server reports that this model does not support tool calling.'
        : typeof hint !== 'boolean' ? 'Tool capability metadata is unavailable; using deeplocal.enableToolCalling.' : '';
  return {
    maxInputTokens: positiveInteger(model?.max_input_tokens) ?? positiveInteger(model?.context_length) ?? config.maxInputTokens,
    maxOutputTokens: positiveInteger(model?.max_output_tokens) ?? config.maxOutputTokens,
    toolCalling, compatible, reason,
  };
}
