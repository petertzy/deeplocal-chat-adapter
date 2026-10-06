import { afterEach, expect, it, vi } from 'vitest';
import { DeepLocalClient } from '../../src/deeplocal-client';
import { DeepLocalConfig } from '../../src/config';
import { StreamEvent } from '../../src/protocol';
import { parseToolInput } from '../../src/tool-input';

const config: DeepLocalConfig = {
  backend: 'local', baseUrl: 'http://localhost/v1', apiKey: '', model: '', requestTimeout: 1000,
  maxInputTokens: 4096, maxOutputTokens: 1024, enableToolCalling: true,
  injectSystemPrompt: true, agentMaxTurns: 8, logLevel: 'off',
};
const logger = { info: vi.fn(), warning: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;
const request = { model: 'model', messages: [], stream: true };
const line = (delta: object, finish_reason?: string) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;

function clientFor(chunks: Uint8Array[]) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }))));
  return new DeepLocalClient(logger, () => config);
}
async function collect(client: DeepLocalClient, events: StreamEvent[] = []) {
  for await (const event of client.streamChat('request', request)) events.push(event);
  return events;
}
const bytes = (text: string) => new TextEncoder().encode(text);
afterEach(() => vi.unstubAllGlobals());

it('preserves mixed text, fragmented names and parallel calls at every byte boundary', async () => {
  const stream = line({ content: 'hello', tool_calls: [
    { index: 1, id: 'second', function: { name: 'wri', arguments: '{"x":' } },
    { index: 0, id: 'first', function: { name: 're', arguments: '{"path":"' } },
  ] }) + line({ content: 'done', tool_calls: [
    { index: 0, function: { name: 'ad', arguments: 'a"}' } },
    { index: 1, function: { name: 'te', arguments: '1}' } },
  ] }, 'tool_calls') + 'data: [DONE]';
  const encoded = bytes(stream);
  const expected = await collect(clientFor([encoded]));
  expect(expected).toEqual([
    { kind: 'text', value: 'hello' }, { kind: 'text', value: 'done' },
    { kind: 'toolCall', value: { id: 'first', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } } },
    { kind: 'toolCall', value: { id: 'second', type: 'function', function: { name: 'write', arguments: '{"x":1}' } } },
  ]);
  for (let boundary = 1; boundary < encoded.length; boundary += 1) {
    expect(await collect(clientFor([encoded.slice(0, boundary), encoded.slice(boundary)]))).toEqual(expected);
  }
  expect(await collect(clientFor([...encoded].map(value => new Uint8Array([value]))))).toEqual(expected);
});

it('accepts omitted indices for a single call and ID-identified parallel continuations', async () => {
  const single = line({ tool_calls: [{ id: 'a', function: { name: 'read', arguments: '{' } }] })
    + line({ tool_calls: [{ function: { arguments: '}' } }] }) + 'data: [DONE]';
  expect((await collect(clientFor([bytes(single)])))[0]).toMatchObject({ kind: 'toolCall', value: { id: 'a' } });
  const parallel = line({ tool_calls: [
    { index: 0, id: 'a', function: { name: 'read', arguments: '{' } },
    { index: 1, id: 'b', function: { name: 'write', arguments: '{' } },
  ] }) + line({ tool_calls: [{ id: 'b', function: { arguments: '}' } }, { id: 'a', function: { arguments: '}' } }] }) + 'data: [DONE]';
  expect((await collect(clientFor([bytes(parallel)]))).map(event => event.kind === 'toolCall' && event.value.id)).toEqual(['a', 'b']);
});

it.each(['{"secret":"private-value"', '[]', 'null', '', 'not-json'])('rejects invalid arguments safely (%s)', async argumentsValue => {
  const stream = line({ content: 'partial', tool_calls: [{ index: 0, id: 'a', function: { name: 'read', arguments: argumentsValue } }] }) + 'data: [DONE]';
  const events: StreamEvent[] = [];
  await expect(collect(clientFor([bytes(stream)]), events)).rejects.toThrow('tool arguments');
  expect(events).toEqual([{ kind: 'text', value: 'partial' }]);
  try { parseToolInput(argumentsValue); } catch (error) { expect(String(error)).not.toContain('private-value'); }
});

it('validates every call before delivering any tool invocation', async () => {
  const stream = line({ tool_calls: [
    { index: 0, id: 'a', function: { name: 'read', arguments: '{}' } },
    { index: 1, id: 'b', function: { name: 'write', arguments: '{' } },
  ] }) + 'data: [DONE]';
  const events: StreamEvent[] = [];
  await expect(collect(clientFor([bytes(stream)]), events)).rejects.toThrow('tool arguments');
  expect(events).toEqual([]);
});

it.each(['length', 'content_filter'])('rejects incomplete completion with finish reason %s', async reason => {
  const stream = line({ tool_calls: [{ index: 0, id: 'a', function: { name: 'read', arguments: '{}' } }] })
    + line({}, reason) + 'data: [DONE]';
  await expect(collect(clientFor([bytes(stream)]))).rejects.toThrow('before completing tool calls');
});

it('reports missing IDs, ambiguous indices, and premature EOF', async () => {
  const missing = line({ tool_calls: [{ index: 0, function: { name: 'read', arguments: '{}' } }] }) + 'data: [DONE]';
  await expect(collect(clientFor([bytes(missing)]))).rejects.toThrow('missing ID or name');
  const ambiguous = line({ tool_calls: [
    { index: 0, id: 'a', function: { name: 'read', arguments: '{' } },
    { index: 1, id: 'b', function: { name: 'read', arguments: '{' } },
  ] }) + line({ tool_calls: [{ function: { arguments: '}' } }] });
  await expect(collect(clientFor([bytes(ambiguous)]))).rejects.toThrow('Ambiguous');
  const eof = line({ tool_calls: [{ index: 0, id: 'a', function: { name: 'read', arguments: '{' } }] });
  await expect(collect(clientFor([bytes(eof)]))).rejects.toThrow('tool calls are incomplete');
});
