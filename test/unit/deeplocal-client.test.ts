import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepLocalClient } from '../../src/deeplocal-client';
import { DeepLocalConfig } from '../../src/config';
import { ChatCompletionRequest } from '../../src/protocol';
import { startFakeServer, FakeServer } from './fake-server';

const config = (baseUrl: string, requestTimeout = 1000): DeepLocalConfig => ({
  backend: 'local', baseUrl, apiKey: 'test-key', model: '', requestTimeout, maxInputTokens: 4096, maxOutputTokens: 1024,
  enableToolCalling: true, injectSystemPrompt: true, agentMaxTurns: 8, logLevel: 'off',
});
const logger = { info: vi.fn(), warning: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;
const request: ChatCompletionRequest = {
  model: 'local-model', stream: true, messages: [{ role: 'user', content: 'hello' }],
};

describe('DeepLocalClient', () => {
  let server: FakeServer | undefined;
  afterEach(async () => { await server?.close(); server = undefined; vi.restoreAllMocks(); });

  it('discovers models and sends authorization', async () => {
    server = await startFakeServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'local-model' }, { name: 'invalid' }, { id: '' }] }));
    });
    const client = new DeepLocalClient(logger, () => config(server!.baseUrl));
    await expect(client.listModels()).resolves.toEqual([{ id: 'local-model' }]);
    expect(server.requests[0]).toMatchObject({ method: 'GET', path: '/v1/models' });
  });

  it('streams text and joins fragmented tool calls into a valid call', async () => {
    server = await startFakeServer((_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read', arguments: '{"file":' } }] } }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] } }] })}\n\ndata: [DONE]\n\n`);
    });
    const client = new DeepLocalClient(logger, () => config(server!.baseUrl));
    const events = [];
    for await (const event of client.streamChat('request', request)) events.push(event);
    expect(events).toEqual([
      { kind: 'text', value: 'hi' },
      { kind: 'toolCall', value: { id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"file":"a"}' } } },
    ]);
    expect(JSON.parse(server.requests[0].body!)).toEqual(request);
  });

  it('reports server errors with status and body', async () => {
    server = await startFakeServer((_req, res) => { res.statusCode = 503; res.end('temporarily unavailable'); });
    const client = new DeepLocalClient(logger, () => config(server!.baseUrl));
    await expect(client.listModels()).rejects.toThrow('HTTP 503');
  });

  it('shows safe provider validation details for HTTP 400 without leaking credentials', async () => {
    server = await startFakeServer((_req, res) => {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'Unsupported parameter max_tokens. key=test-secret and Bearer test-secret' } }));
    });
    const remoteConfig = { ...config(server.baseUrl), backend: 'remote' as const };
    const client = new DeepLocalClient(logger, () => remoteConfig);
    client.setRemoteApiKey('test-secret');
    await expect(async () => {
      for await (const _event of client.streamChat('request', request)) { /* consume */ }
    }).rejects.toThrow('Unsupported parameter max_tokens. key=[redacted] and Bearer [redacted]');
  });

  it('sends max_completion_tokens to remote APIs while keeping local request vocabulary unchanged', async () => {
    server = await startFakeServer((_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.end('data: [DONE]\n\n');
    });
    const remoteConfig = { ...config(server.baseUrl), backend: 'remote' as const };
    const client = new DeepLocalClient(logger, () => remoteConfig);
    client.setRemoteApiKey('test-secret');
    const remoteRequest = { ...request, max_tokens: 8 };
    for await (const _event of client.streamChat('remote-request', remoteRequest)) { /* consume */ }
    const sent = JSON.parse(server.requests[0].body!);
    expect(sent.max_completion_tokens).toBe(8);
    expect(sent.max_tokens).toBeUndefined();
  });

  it('uses remote SecretStorage credentials and does not expose error response bodies', async () => {
    server = await startFakeServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'remote-model' }, { id: 'remote-model-2' }] }));
    });
    const remoteConfig = { ...config(server.baseUrl), backend: 'remote' as const, model: 'remote-model' };
    const client = new DeepLocalClient(logger, () => remoteConfig);
    client.setRemoteApiKey('stale-empty-cache');
    client.setRemoteApiKeyProvider(async () => 'secret-storage-key');
    await expect(client.listModels()).resolves.toEqual([{ id: 'remote-model' }, { id: 'remote-model-2' }]);
    expect(server.requests[0]?.authorization).toBe('Bearer secret-storage-key');
  });

  it('retains a key after checking whether one is configured', async () => {
    server = await startFakeServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'remote-model' }] }));
    });
    const remoteConfig = { ...config(server.baseUrl), backend: 'remote' as const };
    const secrets = new Map<string, string>();
    const client = new DeepLocalClient(logger, () => remoteConfig);
    client.setRemoteApiKeyProvider(async () => secrets.get('remote-key'));
    const keyControl = {
      get: async () => secrets.get('remote-key'),
      set: async (key: string) => { secrets.set('remote-key', key); },
      clear: async () => { secrets.delete('remote-key'); },
    };
    await keyControl.set('stored-key');
    expect(await keyControl.get()).toBe('stored-key');
    await expect(client.listModels()).resolves.toEqual([{ id: 'remote-model' }]);
    expect(server.requests[0]?.authorization).toBe('Bearer stored-key');
    expect(await keyControl.get()).toBe('stored-key');
  });

  it('ignores malformed model payloads and returns an empty model list', async () => {
    server = await startFakeServer((_req, res) => { res.end('{"data":"not-an-array"}'); });
    const client = new DeepLocalClient(logger, () => config(server!.baseUrl));
    await expect(client.listModels()).resolves.toEqual([]);
  });

  it('times out requests without a server response', async () => {
    server = await startFakeServer(() => {});
    const client = new DeepLocalClient(logger, () => config(server!.baseUrl, 30));
    await expect(client.listModels()).rejects.toThrow();
  });
});
