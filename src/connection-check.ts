export interface ConnectionResult {
  ok: boolean;
  category: 'ok' | 'configuration' | 'network' | 'timeout' | 'http' | 'json' | 'schema' | 'empty';
  endpoint: string;
  message: string;
}

export function modelsEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP(S) base URL without credentials, query parameters, or fragments.');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
  return url.toString();
}

export async function checkModelsEndpoint(baseUrl: string, apiKey: string, timeoutMs: number): Promise<ConnectionResult> {
  let endpoint: string;
  try { endpoint = modelsEndpoint(baseUrl); } catch {
    return { ok: false, category: 'configuration', endpoint: '(invalid base URL)',
      message: 'Use an HTTP(S) base URL without credentials, query parameters, or fragments. Open settings to correct it.' };
  }
  const safeEndpoint = apiKey ? endpoint.split(apiKey).join('[redacted]') : endpoint;
  const result = (category: ConnectionResult['category'], message: string): ConnectionResult => ({
    ok: category === 'ok', category, endpoint: safeEndpoint, message,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(timeoutMs, 1000));
  let response: Response | undefined;
  try {
    response = await fetch(endpoint, {
      signal: controller.signal, redirect: 'error',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!response.ok) {
      return result('http', `HTTP ${response.status}. ${[401, 403].includes(response.status)
        ? 'Check the configured API key.' : 'Check the base URL and server status in settings.'}`);
    }
    // Read the body within the timeout too, so a server that stalls after
    // sending headers cannot leave the connection check hanging.
    const text = await response.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch {
      return result('json', 'The models endpoint returned invalid JSON. Check that the base URL points to the API, not a web page.');
    }
    if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data)) {
      return result('schema', 'Expected a models response with a data array. Check OpenAI-compatible API support and the base URL.');
    }
    if (!body.data.length) return result('empty', 'The server returned no models. Load a model on the server and retry.');
    if (body.data.some(model => !model || typeof model !== 'object' || typeof model.id !== 'string' || !model.id.trim())) {
      return result('schema', 'Every model must have a non-empty string ID. Check the server model configuration or update the server.');
    }
    return result('ok', `Valid models response: ${body.data.length} model(s).`);
  } catch {
    return controller.signal.aborted
      ? result('timeout', 'The models request timed out. Check the server or increase the request timeout in settings.')
      : result('network', 'Could not read the models endpoint. Check the URL, server, network, and TLS configuration.');
  } finally {
    clearTimeout(timeout);
    await response?.body?.cancel().catch(() => undefined);
  }
}
