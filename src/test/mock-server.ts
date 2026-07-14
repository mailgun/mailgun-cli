import { createServer, type IncomingMessage, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AddressInfo } from 'node:net';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface MockRoute {
  // Match by method + pathname prefix. First matching route wins.
  method: string;
  path: string;
  status?: number;
  // JSON body to return, or a function of the recorded request.
  json?: unknown | ((req: RecordedRequest) => unknown);
  // Raw response support for download-oriented subprocess tests.
  body?: string | Buffer;
  headers?: Record<string, string>;
}

export interface MockServerHandle {
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

export async function startMockServer(routes: MockRoute[]): Promise<MockServerHandle> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8')
      };
      requests.push(recorded);

      const route = routes.find((r) => r.method === recorded.method && url.pathname.startsWith(r.path));
      if (!route) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'no mock route' }));
        return;
      }
      if (route.body !== undefined) {
        res.writeHead(route.status ?? 200, route.headers ?? {});
        res.end(route.body);
        return;
      }
      const payload = typeof route.json === 'function' ? (route.json as (r: RecordedRequest) => unknown)(recorded) : route.json;
      res.writeHead(route.status ?? 200, { 'Content-Type': 'application/json', ...(route.headers ?? {}) });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Run the built CLI as a subprocess with a clean, deterministic environment.
// `baseUrl`, when provided, redirects API calls at a local mock server.
export async function runCli(
  args: string[],
  env: Record<string, string | undefined> = {},
  baseUrl?: string
): Promise<RunResult> {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        CI: '1',
        NODE_ENV: 'test',
        MAILGUN_API_KEY: undefined,
        MAILGUN_DOMAIN: undefined,
        MAILGUN_API_REGION: undefined,
        MAILGUN_TEST_BASE_URL: baseUrl,
        ...env
      }
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}
