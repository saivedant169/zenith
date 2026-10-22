/** LOCAL GitHub wire emulator. No upstream forwarding, source execution, request/credential logs. */
import fs from 'node:fs';
import https from 'node:https';
import { createHash, verify } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

export function sourceArchive(dockerfile, prefix = '', app, sourceFixture) {
  const blocks = [];
  let files;
  if (sourceFixture !== undefined) {
    if (app !== undefined && app !== null) throw new TypeError('source fixture cannot include the legacy executable');
    if (!sourceFixture || typeof sourceFixture !== 'object' || Array.isArray(sourceFixture)
      || Object.keys(sourceFixture).sort().join(',') !== 'appC,migrationSql'
      || typeof dockerfile !== 'string' || typeof sourceFixture.appC !== 'string' || typeof sourceFixture.migrationSql !== 'string'
      || !['', 'fixture-/'].includes(prefix)) throw new TypeError('invalid bounded source fixture');
    const named = [['Dockerfile', dockerfile], ['app.c', sourceFixture.appC], ['migration.sql', sourceFixture.migrationSql]];
    if (named.some(([, text]) => text.length > 64 * 1024)) throw new TypeError('source fixture exceeds archive bounds');
    const sizes = named.map(([, text]) => Buffer.byteLength(text, 'utf8'));
    if (named.some(([, text]) => text.length === 0 || text.includes('\0'))
      || sizes.some(size => size > 64 * 1024) || sizes.reduce((sum, size) => sum + size, 0) > 128 * 1024
      || named.some(([name]) => Buffer.byteLength(prefix + name, 'utf8') > 100))
      throw new TypeError('source fixture exceeds archive bounds');
    files = named.map(([name, text]) => [name, Buffer.from(text, 'utf8')]);
  } else files = [['Dockerfile', Buffer.from(dockerfile)], ...(app ? [['app', Buffer.from(app, 'base64')]] : [])];
  for (const [name, bytes] of files) {
  const header = Buffer.alloc(512);
  header.write(prefix + name);
  for (const [at, width, value] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, bytes.length], [136, 12, 0]])
    header.write(value.toString(8).padStart(width - 1, '0') + '\0', at, width, 'ascii');
  header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  const result = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]), { level: 9 });
  result.fill(0, 4, 8); result[9] = 255; return result;
}
export function fixtureResponse(config, state, req) {
  const url = new URL(req.url, 'https://' + req.host);
  const reply = (status, data, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)) });
  const redirect = location => reply(303, '', { location });
  const bearer = req.authorization?.replace(/^Bearer /, '');
  const app = () => {
    try {
      const [head, body, signature, extra] = (bearer ?? '').split('.');
      const header = JSON.parse(Buffer.from(head, 'base64url')), payload = JSON.parse(Buffer.from(body, 'base64url'));
      return !extra && header.alg === 'RS256' && payload.iss === config.appId && payload.iat <= Date.now() / 1000
        && payload.exp > Date.now() / 1000 && payload.exp - payload.iat <= 600
        && verify('RSA-SHA256', Buffer.from(head + '.' + body), config.publicKey, Buffer.from(signature, 'base64url'));
    } catch { return false; }
  };
  if (!['api.github.com', 'github.com', 'codeload.github.com'].includes(req.host)) return reply(404, {});
  if (req.host === 'github.com') {
    if (url.pathname === '/apps/zenith-local-drv1/installations/new' && req.method === 'GET') {
      const value = url.searchParams.get('state');
      if (!/^[A-Za-z0-9_-]{43}$/.test(value ?? '')) return reply(400, {});
      return redirect(config.callback + '?state=' + encodeURIComponent(value) + '&installation_id=' + config.installationId + '&setup_action=install');
    }
    if (url.pathname === '/login/oauth/authorize' && req.method === 'GET') {
      if (url.searchParams.get('redirect_uri') !== config.callback || url.searchParams.get('client_id') !== config.clientId
        || url.searchParams.get('code_challenge_method') !== 'S256') return reply(400, {});
      state.challenge = url.searchParams.get('code_challenge'); state.codeUsed = false;
      return redirect(config.callback + '?state=' + encodeURIComponent(url.searchParams.get('state')) + '&code=' + config.code);
    }
    if (url.pathname === '/login/oauth/access_token' && req.method === 'POST') {
      const body = req.body;
      if (state.codeUsed || body.client_id !== config.clientId || body.client_secret !== config.clientSecret || body.code !== config.code
        || body.redirect_uri !== config.callback || createHash('sha256').update(body.code_verifier ?? '').digest('base64url') !== state.challenge) return reply(403, {});
      state.codeUsed = true; return reply(200, { token_type: 'bearer', access_token: config.userToken });
    }
    return reply(404, {});
  }
  if (req.host === 'api.github.com' && url.pathname === '/app' && req.method === 'GET')
    return app() ? reply(200, { id: Number(config.appId), slug: 'zenith-local-drv1' }) : reply(401, {});
  if (req.host === 'api.github.com' && url.pathname === '/user/installations/' + config.installationId + '/repositories' && req.method === 'GET')
    return bearer === config.userToken ? reply(200, { repositories: [{ id: config.repositoryId, full_name: config.repository }] }) : reply(401, {});
  if (req.host === 'api.github.com' && url.pathname === '/repos/' + config.repository + '/installation' && req.method === 'GET')
    return app() ? reply(200, { id: config.installationId, app_id: Number(config.appId), suspended_at: null }) : reply(401, {});
  if (req.host === 'api.github.com' && url.pathname === '/app/installations/' + config.installationId + '/access_tokens' && req.method === 'POST') {
    if (!app() || JSON.stringify(req.body) !== JSON.stringify({ repository_ids: [config.repositoryId], permissions: { contents: 'read' } })) return reply(403, {});
    state.minted++;
    return reply(201, { token: config.installationToken, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { contents: 'read' },
      repositories: [{ id: config.repositoryId, full_name: config.repository }] });
  }
  // Private reads never become public or proxy to GitHub, even after injection.
  if (bearer !== config.installationToken || state.revoked) { state.refused++; return reply(403, {}); }
  state.authenticated++;
  if (req.host === 'api.github.com' && url.pathname === '/repos/' + config.repository && req.method === 'GET')
    return reply(200, { id: config.repositoryId, private: true, name: config.repository.split('/')[1], owner: { login: config.repository.split('/')[0] } });
  const commits = '/repos/' + config.repository + '/commits/';
  if (req.host === 'api.github.com' && url.pathname.startsWith(commits) && req.method === 'GET') {
    const ref = decodeURIComponent(url.pathname.slice(commits.length));
    if (ref === 'main') return reply(200, state.moved ? config.movedCommit : config.commit, { 'content-type': 'text/plain' });
    if ([config.commit, config.movedCommit].includes(ref)) return reply(200, ref, { 'content-type': 'text/plain' });
  }
  const archive = '/' + config.repository + '/tar.gz/';
  if (req.host === 'codeload.github.com' && url.pathname.startsWith(archive) && req.method === 'GET') {
    const ref = url.pathname.slice(archive.length);
    if (ref !== config.commit && ref !== config.movedCommit) return reply(404, {});
    state.archiveReads++; if (ref === config.movedCommit) state.movedArchiveReads++;
    return { status: 200, headers: { 'content-type': 'application/gzip' }, body: sourceArchive(config.dockerfile, 'fixture-/', config.app, config.sourceFixture) };
  }
  return reply(404, {});
}

export function serve(directory) {
  const config = JSON.parse(fs.readFileSync(directory + '/fixture.json'));
  let state = { minted: 0, authenticated: 0, refused: 0, archiveReads: 0, movedArchiveReads: 0, moved: false, revoked: false };
  const server = https.createServer({ key: fs.readFileSync(directory + '/tls.key'), cert: fs.readFileSync(directory + '/tls.crt') }, async (request, response) => {
    try {
      let input = Buffer.alloc(0);
      for await (const bytes of request) { input = Buffer.concat([input, bytes]); if (input.length > 64 * 1024) { response.writeHead(413).end(); return; } }
      const control = JSON.parse(fs.readFileSync(directory + '/control.json'));
      // The browser may reach /login/oauth/authorize here directly; keep that challenge unless the driver recorded one.
      state = { ...state, challenge: control.challenge ?? state.challenge, moved: control.moved === true, revoked: control.revoked === true };
      const result = fixtureResponse(config, state, { url: request.url, host: request.headers.host?.split(':')[0], method: request.method,
        authorization: request.headers.authorization, body: input.length ? JSON.parse(input) : undefined });
      // Counters and flags only. No request bodies, URLs, JWTs or source bytes.
      fs.writeFileSync(directory + '/stats.json', JSON.stringify({ minted: state.minted, authenticated: state.authenticated, refused: state.refused,
        archiveReads: state.archiveReads, movedArchiveReads: state.movedArchiveReads }), { mode: 0o600 });
      response.writeHead(result.status, result.headers).end(result.body);
    } catch { response.writeHead(400).end(); }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.listen(443, '0.0.0.0');
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) serve('/fixture');
