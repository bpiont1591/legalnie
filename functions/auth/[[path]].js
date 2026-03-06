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

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(init.headers || {})
    }
  });

function sanitizeReturnPath(value) {
  const v = String(value || '/');
  if (!v.startsWith('/')) return '/';
  if (v.startsWith('//')) return '/';
  if (v.startsWith('/auth/discord/callback')) return '/';
  return v;
}

async function handleStart(request, env) {
  if (!isDiscordConfigured(env)) return redirectWithError(request, env, 'missing_server_oauth_config');
  const state = randomState();
  const returnTo = sanitizeReturnPath(new URL(request.url).searchParams.get('returnTo') || '/');
  const redirectUri = `${getBaseUrl(request, env)}/auth/discord/callback`;
  const params = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: 'identify', prompt: 'consent', state });
  const headers = new Headers({ Location: `https://discord.com/oauth2/authorize?${params.toString()}` });
  headers.append('Set-Cookie', setCookie('legitcheck_oauth_state', state, 600));
  headers.append('Set-Cookie', setCookie('legitcheck_oauth_return', returnTo, 600));
  return new Response(null, { status: 302, headers });
}

async function handleCallback(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.get('error')) return redirectWithError(request, env, 'discord_denied_or_failed');

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookies = parseCookies(request);
  const storedState = cookies.legitcheck_oauth_state;
  const returnTo = sanitizeReturnPath(cookies.legitcheck_oauth_return || '/');
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
  const avatarUrl = resolveDiscordAvatarUrl(me);
  const session = await serializeSession(env.SESSION_SECRET, { account, display, avatarUrl, provider: 'discord', discordId: me.id });

  const headers = new Headers({ Location: `${getBaseUrl(request, env)}${returnTo}` });
  headers.append('Set-Cookie', setCookie('legitcheck_session', session, 2592000));
  headers.append('Set-Cookie', clearCookie('legitcheck_oauth_state'));
  headers.append('Set-Cookie', clearCookie('legitcheck_oauth_return'));
  return new Response(null, { status: 302, headers });
}

export async function onRequest({ request, env }) {
  const pathname = new URL(request.url).pathname;

  if (pathname === '/auth/config' && request.method === 'GET') return json({ discordConfigured: isDiscordConfigured(env) });
  if (pathname === '/auth/me' && request.method === 'GET') return json({ user: await readSession(env.SESSION_SECRET || '', request) });
  if (pathname === '/auth/logout' && request.method === 'POST') return json({ ok: true }, { headers: { 'Set-Cookie': clearCookie('legitcheck_session') } });
  if (pathname === '/auth/discord/start' && request.method === 'GET') return handleStart(request, env);
  if (pathname === '/auth/discord/callback' && request.method === 'GET') return handleCallback(request, env);

  return new Response('Not found', { status: 404 });
}
