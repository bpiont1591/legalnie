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

const DB = globalThis.__legitcheckDb || (globalThis.__legitcheckDb = { profiles: {} });

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
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '');
}

function isValidSlug(value) {
  return /^[a-z0-9_-]{3,30}$/.test(value);
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

function sanitizeProfile(profile) {
  return {
    owner: profile.owner,
    ownerBio: profile.ownerBio,
    createdAt: profile.createdAt,
    reviews: profile.reviews,
    reports: profile.reports
  };
}

function findOwnedProfile(account) {
  return Object.entries(DB.profiles).find(([, profile]) => profile.owner === account)?.[0] || '';
}

async function bodyJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function requireSession(request, env) {
  const user = await readSession(env.SESSION_SECRET || '', request);
  return user?.account ? user : null;
}

async function handleStart(request, env) {
  if (!isDiscordConfigured(env)) return redirectWithError(request, env, 'missing_server_oauth_config');

  const state = randomState();
  const redirectUri = `${getBaseUrl(request, env)}/auth/discord/callback`;
  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify',
    prompt: 'consent',
    state
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://discord.com/oauth2/authorize?${params.toString()}`,
      'Set-Cookie': setCookie('legitcheck_oauth_state', state, 600)
    }
  });
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
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri
    })
  });

  if (!tokenResp.ok) return redirectWithError(request, env, 'discord_token_exchange_failed');
  const tokenData = await tokenResp.json();

  const meResp = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` }
  });
  if (!meResp.ok) return redirectWithError(request, env, 'discord_profile_failed');

  const me = await meResp.json();
  const account = `dc_${me.id}`;
  const display = `${me.username}${me.discriminator && me.discriminator !== '0' ? `#${me.discriminator}` : ''}`;
  const session = await serializeSession(env.SESSION_SECRET, {
    account,
    display,
    provider: 'discord',
    discordId: me.id
  });

  const headers = new Headers({ Location: `${getBaseUrl(request, env)}/` });
  headers.append('Set-Cookie', setCookie('legitcheck_session', session, 2592000));
  headers.append('Set-Cookie', clearCookie('legitcheck_oauth_state'));

  return new Response(null, { status: 302, headers });
}

async function handleApi(request, env, pathname, url) {
  if (pathname === '/api/my-profile' && request.method === 'GET') {
    const user = await requireSession(request, env);
    if (!user) return json({ error: 'unauthorized' }, { status: 401 });
    return json({ slug: findOwnedProfile(user.account) || null });
  }

  if (pathname === '/api/profile' && request.method === 'GET') {
    const slug = slugify(url.searchParams.get('user'));
    if (!slug || !DB.profiles[slug]) return json({ profile: null });
    return json({ profile: sanitizeProfile(DB.profiles[slug]) });
  }

  if (pathname === '/api/profile/create' && request.method === 'POST') {
    const user = await requireSession(request, env);
    if (!user) return json({ error: 'unauthorized' }, { status: 401 });

    const body = await bodyJson(request);
    const slug = slugify(body.slug);
    if (!isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
    if (DB.profiles[slug]) return json({ error: 'slug_taken' }, { status: 409 });

    DB.profiles[slug] = {
      owner: user.account,
      ownerBio: '',
      createdAt: new Date().toISOString(),
      reviews: [],
      reports: []
    };

    return json({ slug, profile: sanitizeProfile(DB.profiles[slug]) });
  }

  if (pathname === '/api/profile/claim' && request.method === 'POST') {
    const user = await requireSession(request, env);
    if (!user) return json({ error: 'unauthorized' }, { status: 401 });

    const body = await bodyJson(request);
    const slug = slugify(body.user);
    if (!isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
    const profile = ensureProfile(slug);
    if (profile.owner && profile.owner !== user.account) return json({ error: 'already_owned' }, { status: 409 });
    profile.owner = user.account;
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
    const profile = DB.profiles[currentSlug];
    if (!profile) return json({ error: 'profile_not_found' }, { status: 404 });
    if (profile.owner !== user.account) return json({ error: 'forbidden' }, { status: 403 });
    if (nextSlug !== currentSlug && DB.profiles[nextSlug]) return json({ error: 'slug_taken' }, { status: 409 });

    profile.ownerBio = ownerBio;
    if (nextSlug !== currentSlug) {
      DB.profiles[nextSlug] = profile;
      delete DB.profiles[currentSlug];
    }

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

    const profile = ensureProfile(slug);
    if (profile.owner === user.account) return json({ error: 'self_review_blocked' }, { status: 409 });

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

    return json({ ok: true, profile: sanitizeProfile(profile) });
  }

  if (pathname === '/api/report' && request.method === 'POST') {
    const user = await requireSession(request, env);
    if (!user) return json({ error: 'unauthorized' }, { status: 401 });

    const body = await bodyJson(request);
    const slug = slugify(body.user);
    const reviewId = String(body.reviewId || '');
    if (!isValidSlug(slug) || !reviewId) return json({ error: 'invalid_input' }, { status: 400 });

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

    const profile = ensureProfile(slug);
    if (profile.owner !== user.account) return json({ error: 'forbidden' }, { status: 403 });
    const report = profile.reports.find((r) => r.id === reportId);
    if (report) {
      report.status = 'resolved';
      report.resolvedAt = new Date().toISOString();
    }

    return json({ ok: true, profile: sanitizeProfile(profile) });
  }

  return null;
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    const response = await handleApi(request, env, pathname, url);
    if (response) return response;
  }

  if (pathname === '/auth/config' && request.method === 'GET') {
    return json({ discordConfigured: isDiscordConfigured(env) });
  }

  if (pathname === '/auth/me' && request.method === 'GET') {
    const user = await readSession(env.SESSION_SECRET || '', request);
    return json({ user });
  }

  if (pathname === '/auth/logout' && request.method === 'POST') {
    return json({ ok: true }, { headers: { 'Set-Cookie': clearCookie('legitcheck_session') } });
  }

  if (pathname === '/auth/discord/start' && request.method === 'GET') return handleStart(request, env);
  if (pathname === '/auth/discord/callback' && request.method === 'GET') return handleCallback(request, env);

  return new Response('Not found', { status: 404 });
}
