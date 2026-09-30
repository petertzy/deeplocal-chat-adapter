import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export interface FakeServer {
  baseUrl: string;
  requests: Array<{ method: string; path: string; body?: string }>;
  close(): Promise<void>;
}

export async function startFakeServer(
  handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
): Promise<FakeServer> {
  const requests: FakeServer['requests'] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: request.method ?? 'GET', path: request.url ?? '/', body });
      handler(request, response, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
