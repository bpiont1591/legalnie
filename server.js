import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 4173);
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-please';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function parseCookies(req) {
  const source = req.headers.cookie || '';
  return Object.fromEntries(
    source
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf('=');
        return [part.slice(0, idx), decodeURIComponent(part.slice(idx + 1))];
      })
  );
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function serializeSession(user) {
  const payload = Buffer.from(JSON.stringify(user)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readSession(req) {
  const cookies = parseCookies(req);
  const raw = cookies.legitcheck_session;
  if (!raw || !raw.includes('.')) return null;
  const [payload, signature] = raw.split('.');
  if (sign(payload) !== signature) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function json(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), { 'Content-Type': MIME['.json'], ...headers });
}

function getBaseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers.host;
  return `${proto}://${host}`;
}

function randomState() {
  return crypto.randomBytes(16).toString('hex');
}

async function handleDiscordStart(req, res) {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
    return json(res, 500, { error: 'missing_discord_env' });
  }

  const state = randomState();
  const redirectUri = `${getBaseUrl(req)}/auth/discord/callback`;
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify',
    state
  });

  res.writeHead(302, {
    Location: `https://discord.com/oauth2/authorize?${params.toString()}`,
    'Set-Cookie': `legitcheck_oauth_state=${state}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax`
  });
  res.end();
}

async function handleDiscordCallback(req, res, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookies = parseCookies(req);
  const storedState = cookies.legitcheck_oauth_state;

  if (!code || !state || !storedState || state !== storedState) {
    return send(res, 400, 'OAuth state mismatch', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  const redirectUri = `${getBaseUrl(req)}/auth/discord/callback`;
  const tokenResp = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri
    })
  });

  if (!tokenResp.ok) {
    return send(res, 502, 'Discord token exchange failed', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  const tokenData = await tokenResp.json();
  const meResp = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` }
  });

  if (!meResp.ok) {
    return send(res, 502, 'Discord profile request failed', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  const me = await meResp.json();
  const account = `dc_${me.id}`;
  const display = `${me.username}${me.discriminator && me.discriminator !== '0' ? `#${me.discriminator}` : ''}`;
  const session = serializeSession({ account, display, provider: 'discord', discordId: me.id });

  res.writeHead(302, {
    Location: '/',
    'Set-Cookie': [
      `legitcheck_session=${session}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`,
      'legitcheck_oauth_state=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax'
    ]
  });
  res.end();
}

async function serveStatic(res, urlPath) {
  const safePath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(process.cwd(), safePath);
  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    send(res, 200, body, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=60' });
  } catch {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', getBaseUrl(req));

  if (url.pathname === '/auth/me' && req.method === 'GET') {
    const user = readSession(req);
    return json(res, 200, { user });
  }

  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    return json(
      res,
      200,
      { ok: true },
      { 'Set-Cookie': 'legitcheck_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' }
    );
  }

  if (url.pathname === '/auth/discord/start' && req.method === 'GET') {
    return handleDiscordStart(req, res);
  }

  if (url.pathname === '/auth/discord/callback' && req.method === 'GET') {
    return handleDiscordCallback(req, res, url);
  }

  return serveStatic(res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`LegitCheck server running on http://0.0.0.0:${PORT}`);
});
