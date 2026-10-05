import { ChatCompletionRequest, StreamEvent, ToolCall } from './protocol';
import { parseToolInput } from './tool-input';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Replay the full, opaque output only to its original provider and model. */
export function responsesBody(request: ChatCompletionRequest, source: string, summary: boolean) {
  const input: Array<Record<string, unknown>> = [];
  for (const message of request.messages) {
    const context = message.responseContext;
    if (message.role === 'assistant' && context?.source === source && context.model === request.model) {
      input.push(...context.items);
      continue;
    }
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content ?? '' });
      continue;
    }
    if (message.content) input.push({ role: message.role, content: message.content });
    for (const call of message.tool_calls ?? []) {
      input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  return {
    model: request.model, input, stream: true, store: false,
    include: ['reasoning.encrypted_content'],
    max_output_tokens: request.max_completion_tokens ?? request.max_tokens,
    ...(summary ? { reasoning: { summary: 'auto' } } : {}),
    ...(request.tools?.length ? {
      tools: request.tools.map(({ function: tool }) => ({ type: 'function', ...tool, strict: false })),
      tool_choice: request.tool_choice ?? 'auto',
    } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  };
}

/** Parse SSE records (including multiline data and a final record without a newline). */
async function* records(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', data: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const trailingCR = !done && buffer.endsWith('\r');
      if (trailingCR) buffer = buffer.slice(0, -1);
      const lines = buffer.split(/\r\n|\n|\r/);
      buffer = lines.pop()!;
      if (trailingCR) buffer += '\r';
      if (done && buffer) { lines.push(buffer); buffer = ''; }
      for (const line of lines) {
        if (!line) {
          if (data.length) { yield data.join('\n'); data = []; }
        } else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (done) break;
    }
    if (data.length) yield data.join('\n');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function* readResponses(
  body: ReadableStream<Uint8Array>, source: string, model: string, showSummary: boolean,
): AsyncGenerator<StreamEvent> {
  const text = new Map<string, string>();
  const summaries = new Map<string, string>();
  for await (const record of records(body)) {
    if (record === '[DONE]') continue;
    let event: unknown;
    try { event = JSON.parse(record); } catch { throw new Error('Responses stream contained malformed JSON; no tools were executed.'); }
    if (!isObject(event) || typeof event.type !== 'string') throw new Error('Invalid Responses stream event.');
    if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) {
      throw new Error('Responses request failed or was incomplete; no tools were executed. Check model support and output limits.');
    }
    if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      if (typeof event.delta !== 'string' || typeof event.item_id !== 'string') throw new Error('Invalid Responses text delta.');
      text.set(event.item_id, (text.get(event.item_id) ?? '') + event.delta);
      yield { kind: 'text', value: event.delta };
    }
    if (showSummary && event.type === 'response.reasoning_summary_text.delta') {
      if (typeof event.delta !== 'string' || typeof event.item_id !== 'string' || !Number.isInteger(event.summary_index)) {
        throw new Error('Invalid reasoning summary delta.');
      }
      const id = `${event.item_id}:${event.summary_index}`;
      summaries.set(id, (summaries.get(id) ?? '') + event.delta);
      yield { kind: 'summary', id, value: event.delta };
    }
    // Deliberately ignore raw reasoning events. Only provider summary events are UI text.
    if (event.type !== 'response.completed') continue;
    const response = event.response;
    if (!isObject(response) || response.status !== 'completed' || !Array.isArray(response.output)) throw new Error('Invalid completed Responses output.');
    const output: Array<Record<string, unknown>> = [];
    for (const item of response.output) {
      if (!isObject(item) || typeof item.type !== 'string' || typeof item.id !== 'string') throw new Error('Invalid Responses output item.');
      output.push(item);
    }
    const calls: ToolCall[] = [];
    const ids = new Set<string>();
    for (const item of output) {
      if (item.type === 'function_call') {
        if (typeof item.call_id !== 'string' || !item.call_id || ids.has(item.call_id)
          || typeof item.name !== 'string' || !item.name || typeof item.arguments !== 'string'
          || (item.status && item.status !== 'completed')) throw new Error('Incomplete or duplicate Responses tool call; no tools were executed.');
        parseToolInput(item.arguments);
        ids.add(item.call_id);
        calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
      } else if (item.type === 'message') {
        if (!Array.isArray(item.content)) throw new Error('Invalid Responses message content.');
        let full = '';
        for (const part of item.content) {
          if (!isObject(part)) throw new Error('Invalid Responses message part.');
          const value = part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : '';
          if (typeof value !== 'string') throw new Error('Invalid Responses message text.');
          full += value;
        }
        const seen = text.get(String(item.id)) ?? '';
        if (!full.startsWith(seen)) throw new Error('Responses text did not match the completed output.');
        if (full.length > seen.length) yield { kind: 'text', value: full.slice(seen.length) };
      } else if (item.type === 'reasoning' && showSummary) {
        if (!Array.isArray(item.summary)) throw new Error('Invalid Responses reasoning summary.');
        for (const [index, part] of item.summary.entries()) {
          if (!isObject(part) || part.type !== 'summary_text' || typeof part.text !== 'string') continue;
          const id = `${item.id}:${index}`, seen = summaries.get(id) ?? '';
          if (!part.text.startsWith(seen)) throw new Error('Reasoning summary did not match the completed output.');
          if (part.text.length > seen.length) yield { kind: 'summary', id, value: part.text.slice(seen.length) };
        }
      }
    }
    yield { kind: 'responseContext', value: { source, model, items: output } };
    for (const call of calls) yield { kind: 'toolCall', value: call };
    return;
  }
  throw new Error('Responses stream ended before completion; no tools were executed.');
}
