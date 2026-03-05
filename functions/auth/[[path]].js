import {
  clearCookie,
  getBaseUrl,
  isDiscordConfigured,
  parseCookies,
  randomState,
  readSession,
  redirectWithError,
  serializeSession,
  setCookie
} from '../_lib/auth.js';

const MEM_DB = globalThis.__legitcheckDb || (globalThis.__legitcheckDb = { profiles: {} });

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(init.headers || {})
    }
  });

function slugify(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
}

function isValidSlug(value) {
  return /^[a-z0-9_-]{3,30}$/.test(value);
}

async function ensureSchema(env) {
  if (!env.DB) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS profiles (
      slug TEXT PRIMARY KEY,
      owner TEXT,
      owner_display TEXT NOT NULL DEFAULT '',
      owner_avatar TEXT NOT NULL DEFAULT '',
      owner_bio TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      profile_slug TEXT NOT NULL,
      rating TEXT NOT NULL,
      reason TEXT NOT NULL,
      reviewer_account TEXT NOT NULL,
      reviewer_display TEXT NOT NULL DEFAULT '',
      reviewer_avatar TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      profile_slug TEXT NOT NULL,
      review_id TEXT NOT NULL,
      reported_by TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )`)
  ]);

  const alterStatements = [
    "ALTER TABLE profiles ADD COLUMN owner_display TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE profiles ADD COLUMN owner_avatar TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE reviews ADD COLUMN reviewer_display TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE reviews ADD COLUMN reviewer_avatar TEXT NOT NULL DEFAULT ''"
  ];

  for (const stmt of alterStatements) {
    try {
      await env.DB.prepare(stmt).run();
    } catch {
      // column may already exist
    }
  }
}

async function getProfile(env, slug) {
  if (!env.DB) return MEM_DB.profiles[slug] || null;
  const p = await env.DB.prepare('SELECT slug, owner, owner_display, owner_avatar, owner_bio, created_at FROM profiles WHERE slug = ?').bind(slug).first();
  if (!p) return null;
  const reviews = (await env.DB.prepare('SELECT id, rating, reason, reviewer_account, reviewer_display, reviewer_avatar, created_at, updated_at FROM reviews WHERE profile_slug = ?').bind(slug).all()).results;
  const reports = (await env.DB.prepare('SELECT id, review_id, reported_by, status, created_at, resolved_at FROM reports WHERE profile_slug = ?').bind(slug).all()).results;
  return {
    owner: p.owner,
    ownerDisplay: p.owner_display || '',
    ownerAvatar: p.owner_avatar || '',
    ownerBio: p.owner_bio,
    createdAt: p.created_at,
    reviews: reviews.map((r) => ({ id: r.id, rating: r.rating, reason: r.reason, reviewerAccount: r.reviewer_account, reviewerDisplay: r.reviewer_display || '', reviewerAvatar: r.reviewer_avatar || '', createdAt: r.created_at, updatedAt: r.updated_at || undefined })),
    reports: reports.map((r) => ({ id: r.id, reviewId: r.review_id, reportedBy: r.reported_by, status: r.status, createdAt: r.created_at, resolvedAt: r.resolved_at || undefined }))
  };
}

async function saveProfile(env, slug, profile, previousSlug = null) {
  if (!env.DB) {
    if (previousSlug && previousSlug !== slug) delete MEM_DB.profiles[previousSlug];
    MEM_DB.profiles[slug] = profile;
    return;
  }

  const createdAt = profile.createdAt || new Date().toISOString();
  const fromSlug = previousSlug || slug;

  if (previousSlug && previousSlug !== slug) {
    await env.DB.prepare('DELETE FROM profiles WHERE slug = ?').bind(previousSlug).run();
  }

  await env.DB.prepare('INSERT OR REPLACE INTO profiles (slug, owner, owner_display, owner_avatar, owner_bio, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(slug, profile.owner, profile.ownerDisplay || '', profile.ownerAvatar || '', profile.ownerBio || '', createdAt)
    .run();

  await env.DB.prepare('DELETE FROM reviews WHERE profile_slug = ?').bind(fromSlug).run();
  await env.DB.prepare('DELETE FROM reports WHERE profile_slug = ?').bind(fromSlug).run();

  for (const r of profile.reviews || []) {
    await env.DB.prepare('INSERT INTO reviews (id, profile_slug, rating, reason, reviewer_account, reviewer_display, reviewer_avatar, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(r.id, slug, r.rating, r.reason, r.reviewerAccount, r.reviewerDisplay || '', r.reviewerAvatar || '', r.createdAt, r.updatedAt || null)
      .run();
  }

  for (const rp of profile.reports || []) {
    await env.DB.prepare('INSERT INTO reports (id, profile_slug, review_id, reported_by, status, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(rp.id, slug, rp.reviewId, rp.reportedBy, rp.status, rp.createdAt, rp.resolvedAt || null)
      .run();
  }
}

async function findOwnedProfile(env, account) {
  if (!env.DB) return Object.entries(MEM_DB.profiles).find(([, p]) => p.owner === account)?.[0] || '';
  const row = await env.DB.prepare('SELECT slug FROM profiles WHERE owner = ? LIMIT 1').bind(account).first();
  return row?.slug || '';
}

async function requireSession(request, env) {
  const user = await readSession(env.SESSION_SECRET || '', request);
  return user?.account ? user : null;
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

async function bodyJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function handleStart(request, env) {
  if (!isDiscordConfigured(env)) return redirectWithError(request, env, 'missing_server_oauth_config');
  const state = randomState();
  const redirectUri = `${getBaseUrl(request, env)}/auth/discord/callback`;
  const params = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: 'identify', prompt: 'consent', state });
  return new Response(null, { status: 302, headers: { Location: `https://discord.com/oauth2/authorize?${params.toString()}`, 'Set-Cookie': setCookie('legitcheck_oauth_state', state, 600) } });
}

async function handleCallback(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.get('error')) return redirectWithError(request, env, 'discord_denied_or_failed');

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const storedState = parseCookies(request).legitcheck_oauth_state;
  if (!code || !state || !storedState || state !== storedState) return redirectWithError(request, env, 'oauth_state_mismatch');

  const redirectUri = `${getBaseUrl(request, env)}/auth/discord/callback`;
  const tokenResp = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: redirectUri })
  });
  if (!tokenResp.ok) return redirectWithError(request, env, 'discord_token_exchange_failed');

  const tokenData = await tokenResp.json();
  const meResp = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
  if (!meResp.ok) return redirectWithError(request, env, 'discord_profile_failed');

  const me = await meResp.json();
  const account = `dc_${me.id}`;
  const display = `${me.username}${me.discriminator && me.discriminator !== '0' ? `#${me.discriminator}` : ''}`;
  const avatarUrl = me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128` : '';
  const session = await serializeSession(env.SESSION_SECRET, { account, display, avatarUrl, provider: 'discord', discordId: me.id });

  const headers = new Headers({ Location: `${getBaseUrl(request, env)}/` });
  headers.append('Set-Cookie', setCookie('legitcheck_session', session, 2592000));
  headers.append('Set-Cookie', clearCookie('legitcheck_oauth_state'));
  return new Response(null, { status: 302, headers });
}

async function handleApi(request, env, pathname, url) {
  if (pathname === '/api/my-profile' && request.method === 'GET') {
    const user = await requireSession(request, env);
    if (!user) return json({ error: 'unauthorized' }, { status: 401 });
    return json({ slug: (await findOwnedProfile(env, user.account)) || null });
  }

  if (pathname === '/api/profile' && request.method === 'GET') {
    const slug = slugify(url.searchParams.get('user'));
    if (!slug) return json({ profile: null });
    const profile = await getProfile(env, slug);
    return json({ profile: profile ? sanitizeProfile(profile) : null });
  }

  if (pathname === '/api/profile/create' && request.method === 'POST') {
    const user = await requireSession(request, env);
    if (!user) return json({ error: 'unauthorized' }, { status: 401 });
    const slug = slugify((await bodyJson(request)).slug);
    if (!isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
    const ownedSlug = await findOwnedProfile(env, user.account);
    if (ownedSlug) return json({ error: 'already_has_profile', slug: ownedSlug }, { status: 409 });
    if (await getProfile(env, slug)) return json({ error: 'slug_taken' }, { status: 409 });

    const profile = { owner: user.account, ownerDisplay: user.display || '', ownerAvatar: user.avatarUrl || '', ownerBio: '', createdAt: new Date().toISOString(), reviews: [], reports: [] };
    await saveProfile(env, slug, profile);
    return json({ slug, profile: sanitizeProfile(profile) });
  }

  if (pathname === '/api/profile/claim' && request.method === 'POST') {
    const user = await requireSession(request, env);
    if (!user) return json({ error: 'unauthorized' }, { status: 401 });
    const slug = slugify((await bodyJson(request)).user);
    if (!isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
    const profile =
      (await getProfile(env, slug)) || { owner: null, ownerDisplay: '', ownerAvatar: '', ownerBio: '', createdAt: new Date().toISOString(), reviews: [], reports: [] };
    if (profile.owner && profile.owner !== user.account) return json({ error: 'already_owned' }, { status: 409 });
    profile.owner = user.account;
    profile.ownerDisplay = user.display || profile.ownerDisplay || "";
    profile.ownerAvatar = user.avatarUrl || profile.ownerAvatar || "";
    await saveProfile(env, slug, profile);
    return json({ ok: true, profile: sanitizeProfile(profile) });
  }

  if (pathname === '/api/profile/settings' && request.method === 'POST') {
    const user = await requireSession(request, env);
    if (!user) return json({ error: 'unauthorized' }, { status: 401 });
    const body = await bodyJson(request);
    const currentSlug = slugify(body.user);
    const nextSlug = slugify(body.nextSlug);
    const ownerBio = String(body.ownerBio || '').trim().slice(0, 80);
    if (!isValidSlug(currentSlug) || !isValidSlug(nextSlug)) return json({ error: 'invalid_slug' }, { status: 400 });

    const profile = await getProfile(env, currentSlug);
    if (!profile) return json({ error: 'profile_not_found' }, { status: 404 });
    if (profile.owner !== user.account) return json({ error: 'forbidden' }, { status: 403 });
    if (nextSlug !== currentSlug && (await getProfile(env, nextSlug))) return json({ error: 'slug_taken' }, { status: 409 });

    profile.ownerBio = ownerBio;
    await saveProfile(env, nextSlug, profile, currentSlug);
    return json({ slug: nextSlug, profile: sanitizeProfile(profile) });
  }

  if (pathname === '/api/review' && request.method === 'POST') {
    const user = await requireSession(request, env);
    if (!user) return json({ error: 'unauthorized' }, { status: 401 });
    const body = await bodyJson(request);
    const slug = slugify(body.user);
    const rating = body.rating;
    const reason = String(body.reason || '').trim().slice(0, 140);
    if (!isValidSlug(slug) || !['legit', 'sold', 'scam'].includes(rating) || !reason) return json({ error: 'invalid_input' }, { status: 400 });

    const profile = (await getProfile(env, slug)) || { owner: null, ownerDisplay: '', ownerAvatar: '', ownerBio: '', createdAt: new Date().toISOString(), reviews: [], reports: [] };
    if (profile.owner === user.account) return json({ error: 'self_review_blocked' }, { status: 409 });

    const existing = profile.reviews.find((r) => r.reviewerAccount === user.account);
    if (existing) {
      existing.rating = rating;
      existing.reason = reason;
      existing.reviewerDisplay = user.display || existing.reviewerDisplay || '';
      existing.reviewerAvatar = user.avatarUrl || existing.reviewerAvatar || '';
      existing.updatedAt = new Date().toISOString();
    } else {
      profile.reviews.push({ id: `rvw_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`, rating, reason, reviewerAccount: user.account, reviewerDisplay: user.display || '', reviewerAvatar: user.avatarUrl || '', createdAt: new Date().toISOString() });
    }
    await saveProfile(env, slug, profile);
    return json({ ok: true, profile: sanitizeProfile(profile) });
  }

  if (pathname === '/api/report' && request.method === 'POST') {
    const user = await requireSession(request, env);
    if (!user) return json({ error: 'unauthorized' }, { status: 401 });
    const body = await bodyJson(request);
    const slug = slugify(body.user);
    const reviewId = String(body.reviewId || '');
    if (!isValidSlug(slug) || !reviewId) return json({ error: 'invalid_input' }, { status: 400 });

    const profile = (await getProfile(env, slug)) || { owner: null, ownerDisplay: '', ownerAvatar: '', ownerBio: '', createdAt: new Date().toISOString(), reviews: [], reports: [] };
    const already = profile.reports.find((r) => r.reviewId === reviewId && r.reportedBy === user.account && r.status === 'open');
    if (!already) {
      profile.reports.push({ id: `rep_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`, reviewId, reportedBy: user.account, status: 'open', createdAt: new Date().toISOString() });
      await saveProfile(env, slug, profile);
    }
    return json({ ok: true, profile: sanitizeProfile(profile) });
  }

  if (pathname === '/api/report/resolve' && request.method === 'POST') {
    const user = await requireSession(request, env);
    if (!user) return json({ error: 'unauthorized' }, { status: 401 });
    const body = await bodyJson(request);
    const slug = slugify(body.user);
    const reportId = String(body.reportId || '');
    if (!isValidSlug(slug) || !reportId) return json({ error: 'invalid_input' }, { status: 400 });

    const profile = await getProfile(env, slug);
    if (!profile) return json({ error: 'profile_not_found' }, { status: 404 });
    if (profile.owner !== user.account) return json({ error: 'forbidden' }, { status: 403 });
    const report = profile.reports.find((r) => r.id === reportId);
    if (report) {
      report.status = 'resolved';
      report.resolvedAt = new Date().toISOString();
      await saveProfile(env, slug, profile);
    }
    return json({ ok: true, profile: sanitizeProfile(profile) });
  }

  return null;
}

export async function onRequest({ request, env }) {
  await ensureSchema(env);
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    const response = await handleApi(request, env, pathname, url);
    if (response) return response;
  }

  if (pathname === '/auth/config' && request.method === 'GET') return json({ discordConfigured: isDiscordConfigured(env) });
  if (pathname === '/auth/me' && request.method === 'GET') return json({ user: await readSession(env.SESSION_SECRET || '', request) });
  if (pathname === '/auth/logout' && request.method === 'POST') return json({ ok: true }, { headers: { 'Set-Cookie': clearCookie('legitcheck_session') } });
  if (pathname === '/auth/discord/start' && request.method === 'GET') return handleStart(request, env);
  if (pathname === '/auth/discord/callback' && request.method === 'GET') return handleCallback(request, env);

  return new Response('Not found', { status: 404 });
}
