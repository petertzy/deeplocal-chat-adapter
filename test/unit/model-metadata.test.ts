import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelInformation } from '../../src/model-metadata';
import { DeepLocalConfig } from '../../src/config';
import { DeepLocalClient } from '../../src/deeplocal-client';

const config: DeepLocalConfig = {
  backend: 'local', baseUrl: 'http://localhost/v1', apiKey: '', model: '', requestTimeout: 1000,
  maxInputTokens: 131072, maxOutputTokens: 16384, enableToolCalling: true,
  injectSystemPrompt: true, agentMaxTurns: 8, logLevel: 'off',
};
const logger = { info: vi.fn(), warning: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

afterEach(() => vi.unstubAllGlobals());

describe('per-model metadata', () => {
  it('resolves distinct limits and tool capabilities for mixed models', () => {
    expect(modelInformation({ id: 'small', context_length: 4096, max_output_tokens: 512,
      capabilities: { tool_calling: false } }, config)).toMatchObject({
      maxInputTokens: 4096, maxOutputTokens: 512, toolCalling: false, compatible: true,
    });
    expect(modelInformation({ id: 'large', max_input_tokens: 32768, supports_tool_calls: true }, config))
      .toMatchObject({ maxInputTokens: 32768, maxOutputTokens: 16384, toolCalling: true });
  });

  it('falls back for missing and malformed fields without coercing values', () => {
    for (const model of [undefined, { id: 'bad', context_length: -1, max_input_tokens: '8192',
      max_output_tokens: Infinity, capabilities: { tool_calling: 'false' }, protocol: 42 }]) {
      expect(modelInformation(model, config)).toMatchObject({
        maxInputTokens: 131072, maxOutputTokens: 16384, toolCalling: true, compatible: true,
      });
    }
    expect(modelInformation({ id: 'model', supports_tool_calls: true }, { ...config, enableToolCalling: false }).toolCalling)
      .toBe(false);
  });

  it('preserves endpoint ownership and refuses incompatible protocols', () => {
    expect(modelInformation({ id: 'chat', protocol: 'openai', endpoint: '/v1/chat/completions' }, config).compatible).toBe(true);
    expect(modelInformation({ id: 'responses', endpoint: '/v1/responses' }, config).compatible).toBe(false);
    expect(modelInformation({ id: 'other', protocol: 'anthropic' }, config).toolCalling).toBe(false);
  });

  it('retains discovery hints, gates tools, caps output, and still permits plain chat', async () => {
    const model = { id: 'text', max_output_tokens: 64, capabilities: { tool_calling: false }, protocol: 'openai' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [model] })))
      .mockResolvedValueOnce(new Response('data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    let currentConfig = config;
    const client = new DeepLocalClient(logger, () => currentConfig);
    expect(await client.listModels()).toEqual([model]);
    const request = { model: 'text', messages: [], stream: true, max_tokens: 1024 };
    await expect(client.streamChat('tools', { ...request,
      tools: [{ type: 'function', function: { name: 'read' } }] }).next()).rejects.toThrow('Plain chat');
    for await (const event of client.streamChat('plain', request)) void event;
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).max_tokens).toBe(64);
    currentConfig = { ...config, baseUrl: 'http://other/v1' };
    expect(client.modelInformation('text').toolCalling).toBe(true);
    currentConfig = config;
    expect(client.modelInformation('text').toolCalling).toBe(false);
  });
});
