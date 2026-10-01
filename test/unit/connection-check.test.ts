import { afterEach, expect, it, vi } from 'vitest';
import { checkModelsEndpoint } from '../../src/connection-check';
import { DeepLocalClient } from '../../src/deeplocal-client';
import { DeepLocalConfig } from '../../src/config';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('does not mistake a configured remote fallback model for a healthy connection', async () => {
  const config: DeepLocalConfig = {
    backend: 'remote', baseUrl: 'https://host/v1', apiKey: '', model: 'fallback', requestTimeout: 1000,
    maxInputTokens: 4096, maxOutputTokens: 1024, enableToolCalling: true,
    injectSystemPrompt: true, agentMaxTurns: 8, logLevel: 'off',
  };
  const warning = vi.fn();
  const client = new DeepLocalClient({ warning, info: vi.fn() } as never, () => config);
  client.setRemoteApiKey('secret-key');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret-key invalid json')));
  expect(await client.checkConnection()).toBe(false);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('[json] https://host/v1/models'));
  expect(JSON.stringify(warning.mock.calls)).not.toContain('secret-key');
});

it.each([
  ['{"data":[{"id":"model"}]}', 'ok'],
  ['<html>private-key</html>', 'json'],
  ['null', 'schema'], ['{}', 'schema'], ['{"data":{}}', 'schema'],
  ['{"data":[]}', 'empty'], ['{"data":[{}]}', 'schema'],
  ['{"data":[{"id":" "}]}', 'schema'], ['{"data":[{"id":1}]}', 'schema'],
  ['{"data":[{"id":"ok"},null]}', 'schema'],
])('validates response %s as %s', async (body, category) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
  const result = await checkModelsEndpoint('http://localhost:14567/v1/', 'private-key', 1000);
  expect(result.category).toBe(category);
  expect(result.ok).toBe(category === 'ok');
  expect(result.endpoint).toBe('http://localhost:14567/v1/models');
  expect(JSON.stringify(result)).not.toContain('private-key');
});

it.each([401, 403, 404, 500])('reports HTTP %s without response bodies or headers', async status => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret-body', { status })));
  const result = await checkModelsEndpoint('https://example.com/v1', 'secret-key', 1000);
  expect(result).toMatchObject({ ok: false, category: 'http' });
  expect(result.message).toContain(String(status));
  expect(JSON.stringify(result)).not.toMatch(/secret|Authorization/);
});

it.each(['invalid', 'file:///tmp/api', 'https://user:password@host/v1', 'https://host/v1?key=secret', 'https://host/v1#secret'])
  ('rejects unsafe or invalid base URL %s without sending a request', async url => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await checkModelsEndpoint(url, '', 1000)).toMatchObject({ category: 'configuration', ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

it('does not expose transport exception details', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Authorization: Bearer secret')));
  const result = await checkModelsEndpoint('https://host/v1', 'secret', 1000);
  expect(result.category).toBe('network');
  expect(JSON.stringify(result)).not.toMatch(/secret|Bearer|Authorization/);
});

it.each([false, true])('times out stalled requests, including after headers (%s)', async afterHeaders => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, init: RequestInit) => {
    if (afterHeaders) return Promise.resolve(new Response(new ReadableStream({
      start(controller) { init.signal?.addEventListener('abort', () => controller.error(new Error('secret'))); },
    })));
    return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('secret'))));
  }));
  const pending = checkModelsEndpoint('https://host/v1', 'secret', 1000);
  await vi.advanceTimersByTimeAsync(1001);
  expect(await pending).toMatchObject({ ok: false, category: 'timeout' });
});
