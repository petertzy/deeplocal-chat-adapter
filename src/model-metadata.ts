import { DeepLocalConfig } from './config';
import { DeepLocalModel } from './protocol';

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Only validated hints override settings; unknown protocols are never guessed. */
export function modelInformation(model: DeepLocalModel | undefined, config: DeepLocalConfig) {
  const capabilities = model?.capabilities && typeof model.capabilities === 'object'
    ? model.capabilities as Record<string, unknown> : {};
  const hint = typeof capabilities.tool_calling === 'boolean' ? capabilities.tool_calling : model?.supports_tool_calls;
  const protocol = typeof model?.protocol === 'string' && model.protocol.trim() ? model.protocol.trim() : undefined;
  const endpoint = typeof model?.endpoint === 'string' && model.endpoint.trim() ? model.endpoint.trim() : undefined;
  const compatible = (!protocol || ['openai', 'openai-compatible', 'chat-completions'].includes(protocol))
    && (!endpoint || ['/chat/completions', '/v1/chat/completions'].includes(endpoint));
  const toolCalling = config.enableToolCalling && compatible && (typeof hint === 'boolean' ? hint : true);
  const reason = !compatible ? `Unsupported model protocol/endpoint: ${protocol ?? 'unspecified'} / ${endpoint ?? 'unspecified'}.`
    : !config.enableToolCalling ? 'Tool calling is disabled in settings.'
      : hint === false ? 'The server reports that this model does not support tool calling.'
        : typeof hint !== 'boolean' ? 'Tool capability metadata is unavailable; using deeplocal.enableToolCalling.' : '';
  return {
    maxInputTokens: positiveInteger(model?.max_input_tokens) ?? positiveInteger(model?.context_length) ?? config.maxInputTokens,
    maxOutputTokens: positiveInteger(model?.max_output_tokens) ?? config.maxOutputTokens,
    toolCalling, compatible, reason,
  };
}
