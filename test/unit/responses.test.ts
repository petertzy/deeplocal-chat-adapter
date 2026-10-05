import { afterEach, expect, it, vi } from 'vitest';
import { readResponses, responsesBody } from '../../src/responses';
import { DeepLocalClient } from '../../src/deeplocal-client';
import { DeepLocalConfig } from '../../src/config';
import { ChatCompletionRequest, StreamEvent } from '../../src/protocol';

const config: DeepLocalConfig = {
  backend: 'remote', baseUrl: 'https://provider.test/v1', apiKey: '', model: '', requestTimeout: 1000,
  maxInputTokens: 4096, maxOutputTokens: 1000, enableToolCalling: true, injectSystemPrompt: true,
  agentMaxTurns: 3, logLevel: 'off', apiMode: 'responses', reasoningSummary: 'auto',
};
const source = `remote:${config.baseUrl}`;
const request: ChatCompletionRequest = {
  model: 'reasoning-model', messages: [{ role: 'user', content: 'Check the file' }], stream: true,
  max_tokens: 800, tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
};
const output = [
  { id: 'r1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Checking the file.' }], encrypted_content: 'opaque-state' },
  { id: 'm1', type: 'message', role: 'assistant', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text: 'I will read it.' }] },
  { id: 'fc1', type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}', status: 'completed' },
];
const completed = (items: unknown[] = output) => ({ type: 'response.completed', response: { status: 'completed', output: items } });
const sse = (events: unknown[]) => events.map(event => `event: ignored\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join('');
async function collect(stream: AsyncGenerator<StreamEvent>) {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
function client() {
  const result = new DeepLocalClient({ info: vi.fn(), warning: vi.fn(), debug: vi.fn(), error: vi.fn() } as never, () => config);
  result.setRemoteApiKey('test-key');
  return result;
}
afterEach(() => { vi.unstubAllGlobals(); config.apiMode = 'responses'; config.reasoningSummary = 'auto'; });

it('streams summaries separately, replays opaque state and maps tools to the Responses schema', async () => {
  const fetchMock = vi.fn().mockImplementation(async () => new Response(sse([
    { type: 'response.reasoning_text.delta', delta: 'RAW MUST NOT BE SHOWN' },
    { type: 'response.reasoning_summary_text.delta', item_id: 'r1', summary_index: 0, delta: 'Checking ' },
    { type: 'response.reasoning_summary_text.delta', item_id: 'r1', summary_index: 0, delta: 'the file.' },
    { type: 'response.output_text.delta', item_id: 'm1', delta: 'I will read it.' }, completed(),
  ])));
  vi.stubGlobal('fetch', fetchMock);
  const events = await collect(client().streamChat('one', request));
  expect(events.map(event => event.kind)).toEqual(['summary', 'summary', 'text', 'responseContext', 'toolCall']);
  expect(JSON.stringify(events.filter(event => event.kind !== 'responseContext'))).not.toContain('opaque-state');
  expect(JSON.stringify(events)).not.toContain('RAW MUST');
  expect(fetchMock.mock.calls[0][0]).toBe(`${config.baseUrl}/responses`);
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body).toMatchObject({ store: false, include: ['reasoning.encrypted_content'], reasoning: { summary: 'auto' }, max_output_tokens: 800 });
  expect(body.tools[0]).toMatchObject({ type: 'function', name: 'read_file', strict: false });
  expect(body.max_completion_tokens).toBeUndefined();
  const context = events.find(event => event.kind === 'responseContext')!;
  expect(context.kind).toBe('responseContext');
  if (context.kind !== 'responseContext') throw new Error('Missing context');
  const followup = responsesBody({ ...request, messages: [...request.messages,
    { role: 'assistant', content: 'I will read it.', responseContext: context.value },
    { role: 'tool', tool_call_id: 'c1', content: 'File contents' },
  ] }, source, true);
  expect(followup.input).toEqual([...request.messages, ...output, { type: 'function_call_output', call_id: 'c1', output: 'File contents' }]);
});

it('handles byte-split UTF-8, CRLF and a completion without a trailing newline', async () => {
  const encoded = new TextEncoder().encode(sse([
    { type: 'response.reasoning_summary_text.delta', item_id: 'r1', summary_index: 0, delta: '检查文件' },
    completed([{ ...output[0], summary: [{ type: 'summary_text', text: '检查文件' }] }]),
  ]).trimEnd());
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of encoded) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } });
  const events = await collect(readResponses(body, source, request.model, true));
  expect(events.filter(event => event.kind === 'summary')).toEqual([{ kind: 'summary', id: 'r1:0', value: '检查文件' }]);
});

it('accepts multiline SSE data and recovers summaries/text from completed output without deltas', async () => {
  const raw = JSON.stringify(completed(), null, 2).split('\n').map(line => `data: ${line}`).join('\n') + '\n\n';
  const events = await collect(readResponses(new Response(raw).body!, source, request.model, true));
  expect(events.map(event => event.kind)).toEqual(['summary', 'text', 'responseContext', 'toolCall']);
});

it.each(['response.failed', 'response.incomplete', 'error', 'truncated', 'malformed'])('does not emit executable tools on %s', async (failure) => {
  const events: StreamEvent[] = [];
  const start = sse([{ type: 'response.output_item.done', item: output[2] }]);
  const end = failure === 'truncated' ? '' : failure === 'malformed' ? 'data: {broken' : sse([{ type: failure }]);
  await expect(async () => {
    for await (const event of readResponses(new Response(start + end).body!, source, request.model, true)) events.push(event);
  }).rejects.toThrow();
  expect(events.some(event => event.kind === 'toolCall')).toBe(false);
});

it('validates all parallel tools before exposing any executable call', async () => {
  const events: StreamEvent[] = [];
  const stream = new Response(sse([completed([output[2], { ...output[2], call_id: 'c2', arguments: '{broken' }])])).body!;
  await expect(async () => { for await (const event of readResponses(stream, source, request.model, true)) events.push(event); }).rejects.toThrow();
  expect(events.some(event => event.kind === 'toolCall')).toBe(false);
});

it('disables summaries without disabling tools or replaying context to a different provider/model', async () => {
  const body = responsesBody({ ...request, messages: [{ role: 'assistant', content: 'Hello',
    responseContext: { source: 'remote:https://other.test/v1', model: request.model, items: output },
  }] }, source, false);
  expect(body.reasoning).toBeUndefined();
  expect(body.input).toEqual([{ role: 'assistant', content: 'Hello' }]);
  expect(responsesBody({ ...request, messages: [{ role: 'assistant', content: 'Hello',
    responseContext: { source, model: 'different-model', items: output },
  }] }, source, false).input).toEqual([{ role: 'assistant', content: 'Hello' }]);
  const events = await collect(readResponses(new Response(sse([completed()])).body!, source, request.model, false));
  expect(events.some(event => event.kind === 'summary')).toBe(false);
  expect(events.some(event => event.kind === 'toolCall')).toBe(true);
});

it('keeps Chat Completions compatible and strips internal Responses context', async () => {
  config.apiMode = 'chat-completions';
  const fetchMock = vi.fn().mockResolvedValue(new Response('data: [DONE]\n\n'));
  vi.stubGlobal('fetch', fetchMock);
  await collect(client().streamChat('chat', { ...request, messages: [{ role: 'assistant', content: 'Hello', responseContext: { source, model: request.model, items: output } }] }));
  expect(fetchMock.mock.calls[0][0]).toBe(`${config.baseUrl}/chat/completions`);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages).toEqual([{ role: 'assistant', content: 'Hello' }]);
});

it('reports unsupported summaries with an actionable hint and does not silently retry', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":{"message":"summary not supported"}}', { status: 400 }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(collect(client().streamChat('unsupported', request))).rejects.toThrow('deeplocal.reasoningSummary');
  expect(fetchMock).toHaveBeenCalledOnce();
});

it.each(['cancel', 'timeout'])('cleans up a stalled Responses stream on %s', async (mode) => {
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => new Response(new ReadableStream({ start(controller) {
    init.signal.addEventListener('abort', () => controller.error(new Error('Aborted')), { once: true });
  } }))));
  const api = client();
  const pending = collect(api.streamChat('stalled', request));
  if (mode === 'cancel') { await Promise.resolve(); api.cancel('stalled'); }
  await expect(pending).rejects.toThrow(mode === 'cancel' ? 'cancelled' : 'timed out');
});
