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
const ADMIN_DISCORD_ID = '1418289596457812088';

let DB = { profiles: {}, blockedAccounts: {} };


const RATE_LIMITS = new Map();

function getClientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

function isRateLimited(req, user, action, limit = 20, windowMs = 60_000) {
  const key = `${action}:${user?.account || 'anon'}:${getClientIp(req)}`;
  const now = Date.now();
  const entry = RATE_LIMITS.get(key);
  if (!entry || now > entry.resetAt) {
    RATE_LIMITS.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count += 1;
  if (entry.count > limit) return true;
  RATE_LIMITS.set(key, entry);
  return false;
}

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

function isAdmin(user) {
  return Boolean(user?.account === `dc_${ADMIN_DISCORD_ID}`);
}

function isBlockedAccount(account) {
  return Boolean(DB.blockedAccounts?.[account]);
}


function requireNotBlocked(user, res) {
  if (isBlockedAccount(user.account)) {
    json(res, 403, { error: 'blocked_user' });
    return false;
  }
  return true;
}

function collectOpenReports() {
  const out = [];
  for (const [slug, profile] of Object.entries(DB.profiles || {})) {
    for (const report of profile.reports || []) {
      if (report.status !== 'open') continue;
      const review = (profile.reviews || []).find((r) => r.id === report.reviewId);
      out.push({
        profileSlug: slug,
        reportId: report.id,
        reviewId: report.reviewId,
        reportedBy: report.reportedBy,
        reviewerAccount: review?.reviewerAccount || '',
        reviewerDisplay: review?.reviewerDisplay || '',
        reason: review?.reason || '',
        rating: review?.rating || '',
        createdAt: report.createdAt,
        blocked: review?.reviewerAccount ? isBlockedAccount(review.reviewerAccount) : false
      });
    }
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function collectPlatformStats() {
  const owners = new Set(Object.values(DB.profiles || {}).map((p) => p.owner).filter(Boolean));
  return {
    profilesCount: Object.keys(DB.profiles || {}).length,
    ownersCount: owners.size,
    openReportsCount: collectOpenReports().length,
    blockedAccountsCount: Object.keys(DB.blockedAccounts || {}).length,
  };
}


async function loadDb() {
  try {
    const raw = await readFile(DB_FILE, 'utf8');
    DB = JSON.parse(raw);
    if (!DB?.profiles) DB.profiles = {};
    if (!DB?.blockedAccounts) DB.blockedAccounts = {};
  } catch {
    DB = { profiles: {}, blockedAccounts: {} };
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

function sanitizeReturnPath(value) {
  const v = String(value || '/');
  if (!v.startsWith('/')) return '/';
  if (v.startsWith('//')) return '/';
  if (v.startsWith('/auth/discord/callback')) return '/';
  return v;
}

function redirectWithError(res, req, code) {
  const url = new URL('/', getBaseUrl(req));
  url.searchParams.set('auth_error', code);
  res.writeHead(302, { Location: url.toString() });
  res.end();
}


function discordDefaultAvatarUrl(discordId, discriminator) {
  const id = String(discordId || '0');
  const disc = String(discriminator || '0');
  const index = disc !== '0'
    ? Number.parseInt(disc, 10) % 5
    : Number((BigInt(id || '0') >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${Number.isFinite(index) ? index : 0}.png`;
}

function resolveDiscordAvatarUrl(me) {
  if (me?.avatar) {
    const ext = String(me.avatar).startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.${ext}?size=128`;
  }
  return discordDefaultAvatarUrl(me?.id, me?.discriminator);
}

function isDiscordConfigured() {
  return Boolean(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET && SESSION_SECRET && SESSION_SECRET !== 'change-me-please');
}

function ensureProfile(slug) {
  if (!DB.profiles[slug]) {
    DB.profiles[slug] = {
      owner: null,
      ownerDisplay: '',
      ownerAvatar: '',
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
    ownerDisplay: profile.ownerDisplay || '',
    ownerAvatar: profile.ownerAvatar || '',
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
  const returnTo = sanitizeReturnPath(new URL(req.url || '/', getBaseUrl(req)).searchParams.get('returnTo') || '/');
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
    'Set-Cookie': [
      `legitcheck_oauth_state=${state}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax`,
      `legitcheck_oauth_return=${encodeURIComponent(returnTo)}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax`
    ]
  });
  res.end();
}

async function handleDiscordCallback(req, res, url) {
  if (url.searchParams.get('error')) return redirectWithError(res, req, 'discord_denied_or_failed');

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookies = parseCookies(req);
  const storedState = cookies.legitcheck_oauth_state;
  const returnTo = sanitizeReturnPath(cookies.legitcheck_oauth_return || '/');
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
  const avatarUrl = resolveDiscordAvatarUrl(me);
  const session = serializeSession({ account, display, avatarUrl, provider: 'discord', discordId: me.id });

  res.writeHead(302, {
    Location: returnTo,
    'Set-Cookie': [
      `legitcheck_session=${session}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`,
      'legitcheck_oauth_state=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax',
      'legitcheck_oauth_return=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax'
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

    const profile = DB.profiles[slug];
    const sessionUser = readSession(req);
    if (profile.owner && sessionUser?.account === profile.owner) {
      const nextDisplay = sessionUser.display || '';
      const nextAvatar = sessionUser.avatarUrl || '';
      if ((nextDisplay && !profile.ownerDisplay) || (nextAvatar && !profile.ownerAvatar)) {
        profile.ownerDisplay = nextDisplay || profile.ownerDisplay || '';
        profile.ownerAvatar = nextAvatar || profile.ownerAvatar || '';
        await persistDb();
      }
    }

    return json(res, 200, { profile: sanitizeProfile(profile) });
  }

  if (url.pathname === '/api/profile/create' && req.method === 'POST') {
    const user = requireSession(req, res);
    if (!user) return;
    if (!requireNotBlocked(user, res)) return;
    if (isRateLimited(req, user, 'profile_create', 6)) return json(res, 429, { error: 'rate_limited' });
    const body = await readJsonBody(req);
    const slug = slugify(body.slug);
    if (!isValidSlug(slug)) return json(res, 400, { error: 'invalid_slug' });
    const ownedSlug = findOwnedProfile(user.account);
    if (ownedSlug) return json(res, 409, { error: 'already_has_profile', slug: ownedSlug });
    if (DB.profiles[slug]) return json(res, 409, { error: 'slug_taken' });

    DB.profiles[slug] = {
      owner: user.account,
      ownerDisplay: user.display || '',
      ownerAvatar: user.avatarUrl || '',
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
    if (!requireNotBlocked(user, res)) return;
    if (isRateLimited(req, user, 'profile_claim', 10)) return json(res, 429, { error: 'rate_limited' });
    const body = await readJsonBody(req);
    const slug = slugify(body.user);
    if (!isValidSlug(slug)) return json(res, 400, { error: 'invalid_slug' });

    const profile = ensureProfile(slug);
    if (profile.owner && profile.owner !== user.account) return json(res, 409, { error: 'already_owned' });
    profile.owner = user.account;
    profile.ownerDisplay = user.display || profile.ownerDisplay || '';
    profile.ownerAvatar = user.avatarUrl || profile.ownerAvatar || '';
    await persistDb();
    return json(res, 200, { ok: true, profile: sanitizeProfile(profile) });
  }


  if (url.pathname === '/api/profile/delete' && req.method === 'POST') {
    const user = requireSession(req, res);
    if (!user) return;
    if (!requireNotBlocked(user, res)) return;
    if (isRateLimited(req, user, 'profile_delete', 10)) return json(res, 429, { error: 'rate_limited' });
    const body = await readJsonBody(req);
    const slug = slugify(body.user);
    if (!isValidSlug(slug)) return json(res, 400, { error: 'invalid_slug' });

    const profile = DB.profiles[slug];
    if (!profile) return json(res, 404, { error: 'profile_not_found' });
    if (profile.owner !== user.account) return json(res, 403, { error: 'forbidden' });

    delete DB.profiles[slug];
    await persistDb();
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/profile/settings' && req.method === 'POST') {
    const user = requireSession(req, res);
    if (!user) return;
    if (!requireNotBlocked(user, res)) return;
    if (isRateLimited(req, user, 'profile_settings', 20)) return json(res, 429, { error: 'rate_limited' });
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
    if (!requireNotBlocked(user, res)) return;
    if (isRateLimited(req, user, 'review_write', 12)) return json(res, 429, { error: 'rate_limited' });
    const body = await readJsonBody(req);
    const slug = slugify(body.user);
    const rating = body.rating;
    const reason = String(body.reason || '').trim().slice(0, 140);
    if (!isValidSlug(slug) || !['legit', 'sold', 'scam'].includes(rating) || !reason) return json(res, 400, { error: 'invalid_input' });

    const profile = DB.profiles[slug];
    if (!profile) return json(res, 404, { error: 'profile_not_found' });
    if (profile.owner === user.account) return json(res, 409, { error: 'self_review_blocked' });

    const existing = profile.reviews.find((r) => r.reviewerAccount === user.account);
    if (existing) {
      existing.rating = rating;
      existing.reason = reason;
      existing.reviewerDisplay = user.display || existing.reviewerDisplay || '';
      existing.reviewerAvatar = user.avatarUrl || existing.reviewerAvatar || '';
      existing.updatedAt = new Date().toISOString();
    } else {
      profile.reviews.push({
        id: `rvw_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
        rating,
        reason,
        reviewerAccount: user.account,
        reviewerDisplay: user.display || '',
        reviewerAvatar: user.avatarUrl || '',
        createdAt: new Date().toISOString()
      });
    }
    await persistDb();
    return json(res, 200, { ok: true, profile: sanitizeProfile(profile) });
  }

  if (url.pathname === '/api/report' && req.method === 'POST') {
    const user = requireSession(req, res);
    if (!user) return;
    if (!requireNotBlocked(user, res)) return;
    if (isRateLimited(req, user, 'report_write', 12)) return json(res, 429, { error: 'rate_limited' });
    const body = await readJsonBody(req);
    const slug = slugify(body.user);
    const reviewId = String(body.reviewId || '');
    if (!isValidSlug(slug) || !reviewId) return json(res, 400, { error: 'invalid_input' });

    const profile = DB.profiles[slug];
    if (!profile) return json(res, 404, { error: 'profile_not_found' });
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
    if (isRateLimited(req, user, 'report_resolve', 20)) return json(res, 429, { error: 'rate_limited' });
    const body = await readJsonBody(req);
    const slug = slugify(body.user);
    const reportId = String(body.reportId || '');
    if (!isValidSlug(slug) || !reportId) return json(res, 400, { error: 'invalid_input' });

    const profile = DB.profiles[slug];
    if (!profile) return json(res, 404, { error: 'profile_not_found' });
    if (profile.owner !== user.account) return json(res, 403, { error: 'forbidden' });
    const report = profile.reports.find((r) => r.id === reportId);
    if (report) {
      report.status = 'resolved';
      report.resolvedAt = new Date().toISOString();
      await persistDb();
    }

    return json(res, 200, { ok: true, profile: sanitizeProfile(profile) });
  }

  if (url.pathname === '/api/admin/reports' && req.method === 'GET') {
    const user = requireSession(req, res);
    if (!user) return;
    if (!isAdmin(user)) return json(res, 403, { error: 'forbidden' });
    return json(res, 200, { reports: collectOpenReports() });
  }

  if (url.pathname === '/api/admin/stats' && req.method === 'GET') {
    const user = requireSession(req, res);
    if (!user) return;
    if (!isAdmin(user)) return json(res, 403, { error: 'forbidden' });
    return json(res, 200, { stats: collectPlatformStats() });
  }


  if (url.pathname === '/api/admin/report/action' && req.method === 'POST') {
    const user = requireSession(req, res);
    if (!user) return;
    if (!isAdmin(user)) return json(res, 403, { error: 'forbidden' });
    if (isRateLimited(req, user, 'admin_report_action', 60)) return json(res, 429, { error: 'rate_limited' });

    const body = await readJsonBody(req);
    const profileSlug = slugify(body.profileSlug);
    const reportId = String(body.reportId || '');
    const action = String(body.action || '');
    if (!isValidSlug(profileSlug) || !reportId || !['keep', 'delete_review', 'dismiss'].includes(action)) {
      return json(res, 400, { error: 'invalid_input' });
    }

    const profile = DB.profiles[profileSlug];
    if (!profile) return json(res, 404, { error: 'profile_not_found' });
    const report = (profile.reports || []).find((r) => r.id === reportId);
    if (!report) return json(res, 404, { error: 'report_not_found' });

    if (action === 'delete_review') {
      profile.reviews = (profile.reviews || []).filter((r) => r.id !== report.reviewId);
      profile.reports = (profile.reports || []).filter((r) => r.reviewId !== report.reviewId);
    } else if (action === 'dismiss') {
      profile.reports = (profile.reports || []).filter((r) => r.id !== reportId);
    } else {
      report.status = 'resolved';
      report.resolvedAt = new Date().toISOString();
    }

    await persistDb();
    return json(res, 200, { ok: true, reports: collectOpenReports() });
  }

  if (url.pathname === '/api/admin/block' && req.method === 'POST') {
    const user = requireSession(req, res);
    if (!user) return;
    if (!isAdmin(user)) return json(res, 403, { error: 'forbidden' });
    if (isRateLimited(req, user, 'admin_block_action', 60)) return json(res, 429, { error: 'rate_limited' });

    const body = await readJsonBody(req);
    const account = String(body.account || '');
    const blocked = Boolean(body.blocked);
    if (!/^dc_[0-9]+$/.test(account)) return json(res, 400, { error: 'invalid_input' });
    if (!DB.blockedAccounts) DB.blockedAccounts = {};
    if (blocked) DB.blockedAccounts[account] = { blockedAt: new Date().toISOString(), blockedBy: user.account };
    else delete DB.blockedAccounts[account];
    await persistDb();
    return json(res, 200, { ok: true, blockedAccounts: Object.keys(DB.blockedAccounts) });
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
  try {
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
  } catch {
    return json(res, 500, { error: 'internal_error' });
  }
});

loadDb().then(() => {
  server.listen(PORT, () => {
    console.log(`LegitCheck server running on http://0.0.0.0:${PORT}`);
    console.log(`Database file: ${DB_FILE}`);
  });
});
