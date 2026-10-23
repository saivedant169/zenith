// Private-CA HTTPS edge for a disposable stack's API (the plugin-platform lane only).
// Pass-through: the Host header reaches the API unchanged, so its configured-origin check still decides.
// No credential decisions or response rewriting occur here.
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
const port = Number(process.env.ZENITH_API_EDGE_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('api-edge: invalid port');
https.createServer({ cert: fs.readFileSync('/run/edge.crt'), key: fs.readFileSync('/run/edge.key'), minVersion: 'TLSv1.2' }, (request, response) => {
  // MCP answers may stream; bound idle time, not total time.
  const proxy = http.request({ host: 'api', port: 3400, path: request.url, method: request.method,
    headers: { ...request.headers, 'x-forwarded-proto': 'https' }, timeout: 60_000 }, reply => {
    response.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(response);
  });
  proxy.on('timeout', () => proxy.destroy());
  proxy.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  request.on('aborted', () => proxy.destroy());
  request.pipe(proxy);
}).listen(port, '0.0.0.0');
