import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 4173);
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-please';
const BASE_URL = process.env.BASE_URL || '';
const DB_FILE = path.join(process.cwd(), 'data', 'profiles-db.json');

let DB = { profiles: {} };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function slugify(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
}

function isValidSlug(value) {
  return /^[a-z0-9_-]{3,30}$/.test(value);
}

async function loadDb() {
  try {
    const raw = await readFile(DB_FILE, 'utf8');
    DB = JSON.parse(raw);
    if (!DB?.profiles) DB = { profiles: {} };
  } catch {
    DB = { profiles: {} };
  }
}

async function persistDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  await writeFile(DB_FILE, JSON.stringify(DB, null, 2));
}

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
  if (BASE_URL) return BASE_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers.host;
  return `${proto}://${host}`;
}

function randomState() {
  return crypto.randomBytes(16).toString('hex');
}

function redirectWithError(res, req, code) {
  const url = new URL('/', getBaseUrl(req));
  url.searchParams.set('auth_error', code);
  res.writeHead(302, { Location: url.toString() });
  res.end();
}

function isDiscordConfigured() {
  return Boolean(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET && SESSION_SECRET && SESSION_SECRET !== 'change-me-please');
}

function ensureProfile(slug) {
  if (!DB.profiles[slug]) {
    DB.profiles[slug] = {
      owner: null,
      ownerBio: '',
      createdAt: new Date().toISOString(),
      reviews: [],
      reports: []
    };
  }
  return DB.profiles[slug];
}

function findOwnedProfile(account) {
  return Object.entries(DB.profiles).find(([, profile]) => profile.owner === account)?.[0] || '';
}

function sanitizeProfile(profile) {
  return {
    owner: profile.owner,
    ownerBio: profile.ownerBio,
    createdAt: profile.createdAt,
    reviews: profile.reviews,
    reports: profile.reports
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function requireSession(req, res) {
  const user = readSession(req);
  if (!user?.account) {
    json(res, 401, { error: 'unauthorized' });
    return null;
  }
  return user;
}

async function handleDiscordStart(req, res) {
  if (!isDiscordConfigured()) return redirectWithError(res, req, 'missing_server_oauth_config');

  const state = randomState();
  const redirectUri = `${getBaseUrl(req)}/auth/discord/callback`;
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify',
    prompt: 'consent',
    state
  });

  res.writeHead(302, {
    Location: `https://discord.com/oauth2/authorize?${params.toString()}`,
    'Set-Cookie': `legitcheck_oauth_state=${state}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax`
  });
  res.end();
}

async function handleDiscordCallback(req, res, url) {
  if (url.searchParams.get('error')) return redirectWithError(res, req, 'discord_denied_or_failed');

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const storedState = parseCookies(req).legitcheck_oauth_state;
  if (!code || !state || !storedState || state !== storedState) return redirectWithError(res, req, 'oauth_state_mismatch');

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

  if (!tokenResp.ok) return redirectWithError(res, req, 'discord_token_exchange_failed');

  const tokenData = await tokenResp.json();
  const meResp = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` }
  });
  if (!meResp.ok) return redirectWithError(res, req, 'discord_profile_failed');

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

async function handleApi(req, res, url) {
  if (url.pathname === '/api/my-profile' && req.method === 'GET') {
    const user = requireSession(req, res);
    if (!user) return;
    return json(res, 200, { slug: findOwnedProfile(user.account) || null });
  }

  if (url.pathname === '/api/profile' && req.method === 'GET') {
    const slug = slugify(url.searchParams.get('user'));
    if (!slug || !DB.profiles[slug]) return json(res, 200, { profile: null });
    return json(res, 200, { profile: sanitizeProfile(DB.profiles[slug]) });
  }

  if (url.pathname === '/api/profile/create' && req.method === 'POST') {
    const user = requireSession(req, res);
    if (!user) return;
    const body = await readJsonBody(req);
    const slug = slugify(body.slug);
    if (!isValidSlug(slug)) return json(res, 400, { error: 'invalid_slug' });
    const ownedSlug = findOwnedProfile(user.account);
    if (ownedSlug) return json(res, 409, { error: 'already_has_profile', slug: ownedSlug });
    if (DB.profiles[slug]) return json(res, 409, { error: 'slug_taken' });

    DB.profiles[slug] = {
      owner: user.account,
      ownerBio: '',
      createdAt: new Date().toISOString(),
      reviews: [],
      reports: []
    };
    await persistDb();
    return json(res, 200, { slug, profile: sanitizeProfile(DB.profiles[slug]) });
  }

  if (url.pathname === '/api/profile/claim' && req.method === 'POST') {
    const user = requireSession(req, res);
    if (!user) return;
    const body = await readJsonBody(req);
    const slug = slugify(body.user);
    if (!isValidSlug(slug)) return json(res, 400, { error: 'invalid_slug' });

    const profile = ensureProfile(slug);
    if (profile.owner && profile.owner !== user.account) return json(res, 409, { error: 'already_owned' });
    profile.owner = user.account;
    await persistDb();
    return json(res, 200, { ok: true, profile: sanitizeProfile(profile) });
  }

  if (url.pathname === '/api/profile/settings' && req.method === 'POST') {
    const user = requireSession(req, res);
    if (!user) return;
    const body = await readJsonBody(req);
    const currentSlug = slugify(body.user);
    const nextSlug = slugify(body.nextSlug);
    const ownerBio = String(body.ownerBio || '').trim().slice(0, 80);

    if (!isValidSlug(currentSlug) || !isValidSlug(nextSlug)) return json(res, 400, { error: 'invalid_slug' });
    const profile = DB.profiles[currentSlug];
    if (!profile) return json(res, 404, { error: 'profile_not_found' });
    if (profile.owner !== user.account) return json(res, 403, { error: 'forbidden' });
    if (nextSlug !== currentSlug && DB.profiles[nextSlug]) return json(res, 409, { error: 'slug_taken' });

    profile.ownerBio = ownerBio;
    if (nextSlug !== currentSlug) {
      DB.profiles[nextSlug] = profile;
      delete DB.profiles[currentSlug];
    }

    await persistDb();
    return json(res, 200, { slug: nextSlug, profile: sanitizeProfile(profile) });
  }

  if (url.pathname === '/api/review' && req.method === 'POST') {
    const user = requireSession(req, res);
    if (!user) return;
    const body = await readJsonBody(req);
    const slug = slugify(body.user);
    const rating = body.rating;
    const reason = String(body.reason || '').trim().slice(0, 140);
    if (!isValidSlug(slug) || !['legit', 'sold', 'scam'].includes(rating) || !reason) return json(res, 400, { error: 'invalid_input' });

    const profile = ensureProfile(slug);
    if (profile.owner === user.account) return json(res, 409, { error: 'self_review_blocked' });

    const existing = profile.reviews.find((r) => r.reviewerAccount === user.account);
    if (existing) {
      existing.rating = rating;
      existing.reason = reason;
      existing.updatedAt = new Date().toISOString();
    } else {
      profile.reviews.push({
        id: `rvw_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
        rating,
        reason,
        reviewerAccount: user.account,
        createdAt: new Date().toISOString()
      });
    }
    await persistDb();
    return json(res, 200, { ok: true, profile: sanitizeProfile(profile) });
  }

  if (url.pathname === '/api/report' && req.method === 'POST') {
    const user = requireSession(req, res);
    if (!user) return;
    const body = await readJsonBody(req);
    const slug = slugify(body.user);
    const reviewId = String(body.reviewId || '');
    if (!isValidSlug(slug) || !reviewId) return json(res, 400, { error: 'invalid_input' });

    const profile = ensureProfile(slug);
    const already = profile.reports.find((r) => r.reviewId === reviewId && r.reportedBy === user.account && r.status === 'open');
    if (!already) {
      profile.reports.push({
        id: `rep_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
        reviewId,
        reportedBy: user.account,
        status: 'open',
        createdAt: new Date().toISOString()
      });
      await persistDb();
    }

    return json(res, 200, { ok: true, profile: sanitizeProfile(profile) });
  }

  if (url.pathname === '/api/report/resolve' && req.method === 'POST') {
    const user = requireSession(req, res);
    if (!user) return;
    const body = await readJsonBody(req);
    const slug = slugify(body.user);
    const reportId = String(body.reportId || '');
    if (!isValidSlug(slug) || !reportId) return json(res, 400, { error: 'invalid_input' });

    const profile = ensureProfile(slug);
    if (profile.owner !== user.account) return json(res, 403, { error: 'forbidden' });
    const report = profile.reports.find((r) => r.id === reportId);
    if (report) {
      report.status = 'resolved';
      report.resolvedAt = new Date().toISOString();
      await persistDb();
    }

    return json(res, 200, { ok: true, profile: sanitizeProfile(profile) });
  }

  return false;
}

async function serveStatic(res, urlPath) {
  const safePath = urlPath === '/' || urlPath.startsWith('/u/') ? '/index.html' : urlPath;
  const filePath = path.join(process.cwd(), safePath);
  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    const cacheControl = ext === '.html' ? 'no-store' : 'public, max-age=60';
    send(res, 200, body, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheControl });
  } catch {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', getBaseUrl(req));

  if (url.pathname.startsWith('/api/')) {
    const handled = await handleApi(req, res, url);
    if (handled !== false) return;
  }

  if (url.pathname === '/auth/config' && req.method === 'GET') return json(res, 200, { discordConfigured: isDiscordConfigured() });
  if (url.pathname === '/auth/me' && req.method === 'GET') return json(res, 200, { user: readSession(req) });
  if (url.pathname === '/auth/logout' && req.method === 'POST') return json(res, 200, { ok: true }, { 'Set-Cookie': 'legitcheck_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' });
  if (url.pathname === '/auth/discord/start' && req.method === 'GET') return handleDiscordStart(req, res);
  if (url.pathname === '/auth/discord/callback' && req.method === 'GET') return handleDiscordCallback(req, res, url);

  return serveStatic(res, url.pathname);
});

loadDb().then(() => {
  server.listen(PORT, () => {
    console.log(`LegitCheck server running on http://0.0.0.0:${PORT}`);
    console.log(`Database file: ${DB_FILE}`);
  });
});
