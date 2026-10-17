import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type Behavior =
  | number // reply with this status code
  | { status: number; headers?: Record<string, string>; body?: string }
  | 'hang'; // accept the request and never answer (to test timeouts)

/**
 * A tiny HTTP server for testing failure handling. Queue up behaviors with `respond(...)`;
 * each request consumes one, and when the queue is empty the default (200) is used.
 * Every request is recorded so tests can inspect headers, bodies and counts.
 */
export async function startMockServer() {
  const requests: RecordedRequest[] = [];
  const queue: Behavior[] = [];
  let fallback: Behavior = 200;
  const hanging = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      const b = queue.shift() ?? fallback;
      if (b === 'hang') {
        hanging.add(res);
        return;
      }
      const spec = typeof b === 'number' ? { status: b } : b;
      res.writeHead(spec.status, { 'Content-Type': 'application/json', ...spec.headers });
      res.end(spec.body ?? '{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    respond: (...behaviors: Behavior[]) => queue.push(...behaviors),
    setDefault: (b: Behavior) => (fallback = b),
    reset() {
      requests.length = 0;
      queue.length = 0;
      fallback = 200;
    },
    async close() {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
export type MockServer = Awaited<ReturnType<typeof startMockServer>>;
