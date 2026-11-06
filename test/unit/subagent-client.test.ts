import type { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepLocalClient } from '../../src/deeplocal-client';
import type { DeepLocalConfig } from '../../src/config';
import type { ChatCompletionRequest, StreamEvent } from '../../src/protocol';
import { startFakeServer, type FakeServer } from './fake-server';

const children = ['batch-1:child-1', 'batch-1:child-2'] as const;
const logger = { info: vi.fn(), warning: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const request = (child: string): ChatCompletionRequest => ({
  model: 'research-model', stream: true, messages: [{ role: 'user', content: child }],
  tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
});

describe.each(['chat-completions', 'responses'] as const)('parallel child transport: %s', (apiMode) => {
  let server: FakeServer | undefined;
  const connections = new Set<ServerResponse>();
  afterEach(async () => {
    for (const response of connections) response.destroy();
    connections.clear();
    await server?.close(); server = undefined;
  });
  const makeClient = () => {
    const config: DeepLocalConfig = {
      backend: 'local', baseUrl: server!.baseUrl, apiKey: '', model: '', requestTimeout: 5000,
      maxInputTokens: 4096, maxOutputTokens: 1024, enableToolCalling: true,
      injectSystemPrompt: true, agentMaxTurns: 8, logLevel: 'off', apiMode,
    };
    return new DeepLocalClient(logger, () => config);
  };
  const text = (value: string) => apiMode === 'responses'
    ? sse({ type: 'response.output_text.delta', item_id: 'message', delta: value })
    : sse({ choices: [{ delta: { content: value } }] });
  const end = () => apiMode === 'responses'
    ? sse({ type: 'response.completed', response: { status: 'completed', output: [] } })
    : 'data: [DONE]\n\n';
  async function stalledStreams() {
    const responses = new Map<string, ServerResponse>();
    server = await startFakeServer((_req, res, body) => {
      const data = JSON.parse(body);
      const child = (data.messages ?? data.input)[0].content as string;
      connections.add(res); responses.set(child, res);
      res.setHeader('content-type', 'text/event-stream');
      res.write(text('started ' + child));
    });
    const client = makeClient();
    const events = new Map<string, StreamEvent[]>();
    const pending = children.map(child => {
      const seen: StreamEvent[] = []; events.set(child, seen);
      // Attach the rejection handler immediately so intentionally cancelled
      // streams never become unhandled promise rejections.
      return (async () => {
        try {
          for await (const event of client.streamChat(child, request(child))) seen.push(event);
          return { error: undefined };
        } catch (error) { return { error }; }
      })();
    });
    await vi.waitFor(() => {
      for (const child of children) expect(events.get(child)).toContainEqual({ kind: 'text', value: 'started ' + child });
    });
    expect(server.requests.map(item => item.path)).toEqual(Array(2).fill(apiMode === 'responses' ? '/v1/responses' : '/v1/chat/completions'));
    return { client, responses, events, pending };
  }

  it('cancels both active unique child request IDs and closes both HTTP streams', async () => {
    const { client, responses, pending } = await stalledStreams();
    for (const child of children) client.cancel(child);
    const outcomes = await Promise.all(pending);
    for (const outcome of outcomes) expect(outcome.error).toMatchObject({ message: expect.stringMatching(/cancelled/i) });
    await vi.waitFor(() => {
      for (const response of responses.values()) expect(response.destroyed).toBe(true);
    });
  });

  it('cancelling one child leaves its sibling streaming to successful completion', async () => {
    const { client, responses, events, pending } = await stalledStreams();
    client.cancel(children[0]);
    expect((await pending[0]).error).toMatchObject({ message: expect.stringMatching(/cancelled/i) });
    expect(responses.get(children[1])!.destroyed).toBe(false);
    responses.get(children[1])!.end(text('sibling completed') + end());
    expect((await pending[1]).error).toBeUndefined();
    expect(events.get(children[1])).toContainEqual({ kind: 'text', value: 'sibling completed' });
    expect(events.get(children[0])).not.toContainEqual({ kind: 'text', value: 'sibling completed' });
  });

  it('keeps concurrent child tool continuations and provider context isolated', async () => {
    const firstResponses = new Map<string, ServerResponse>();
    const followups = new Map<string, Record<string, unknown>>();
    server = await startFakeServer((_req, res, body) => {
      const data = JSON.parse(body);
      const input = data.messages ?? data.input;
      const child = input[0].content as string;
      connections.add(res); res.setHeader('content-type', 'text/event-stream');
      const continuation = input.some((item: { role?: string; type?: string }) => item.role === 'tool' || item.type === 'function_call_output');
      if (continuation) {
        followups.set(child, data);
        res.end(text('finding for ' + child) + end());
        return;
      }
      firstResponses.set(child, res);
      // Hold both first turns until both requests reach the HTTP server.
      if (firstResponses.size !== children.length) return;
      for (const [id, response] of firstResponses) {
        const call = { id: 'call-' + id, type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify({ path: id + '.ts' }) } };
        response.end(apiMode === 'responses'
          ? sse({ type: 'response.completed', response: { status: 'completed', output: [
            { type: 'reasoning', id: 'reason-' + id, summary: [], encrypted_content: 'opaque-' + id },
            { type: 'function_call', id: 'function-' + id, call_id: call.id, name: call.function.name, arguments: call.function.arguments, status: 'completed' },
          ] } })
          : sse({ choices: [{ delta: { tool_calls: [{ ...call, index: 0 }] }, finish_reason: 'tool_calls' }] }) + end());
      }
    });
    const client = makeClient();
    const outputs = await Promise.all(children.map(async child => {
      const initial: StreamEvent[] = [];
      for await (const event of client.streamChat(child, request(child))) initial.push(event);
      const tool = initial.find(event => event.kind === 'toolCall');
      if (tool?.kind !== 'toolCall') throw new Error('Missing child tool call');
      expect(tool.value.id).toBe('call-' + child);
      const context = initial.find(event => event.kind === 'responseContext');
      const followup: ChatCompletionRequest = { ...request(child), messages: [
        ...request(child).messages,
        { role: 'assistant', content: '', tool_calls: [tool.value], ...(context?.kind === 'responseContext' ? { responseContext: context.value } : {}) },
        { role: 'tool', tool_call_id: tool.value.id, content: 'observed ' + child },
      ] };
      const final: StreamEvent[] = [];
      for await (const event of client.streamChat(child, followup)) final.push(event);
      return final;
    }));
    expect(server.requests).toHaveLength(4);
    for (const [index, child] of children.entries()) {
      expect(outputs[index]).toContainEqual({ kind: 'text', value: 'finding for ' + child });
      const sent = JSON.stringify(followups.get(child));
      expect(sent).toContain('observed ' + child);
      expect(sent).toContain('call-' + child);
      expect(sent).not.toContain(children[1 - index]);
      if (apiMode === 'responses') expect(sent).toContain('opaque-' + child);
    }
  });
});
