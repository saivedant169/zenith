// Private-CA HTTPS edge for the genuine CLI Auth/PostgREST gateway.
// No credential decisions or response rewriting occur here.
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
const upstream = process.env.ZENITH_SUPABASE_UPSTREAM;
if (!/^supabase_kong_zenith-local-[a-f0-9]{24}$/.test(upstream ?? '')) throw new Error('gateway:upstream');
const port = Number(process.env.ZENITH_SUPABASE_EDGE_PORT ?? '54321');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('gateway:port');
https.createServer({ cert: fs.readFileSync('/run/edge.crt'), key: fs.readFileSync('/run/edge.key'), minVersion: 'TLSv1.2' }, (request, response) => {
  const proxy = http.request({ host: upstream, port: 8000, path: request.url, method: request.method,
    headers: { ...request.headers, 'x-forwarded-proto': 'https' }, timeout: 10_000 }, reply => {
    response.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(response);
  });
  proxy.on('timeout', () => proxy.destroy());
  proxy.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  request.on('aborted', () => proxy.destroy());
  request.pipe(proxy);
}).listen(port, '0.0.0.0');
