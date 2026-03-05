const textEncoder = new TextEncoder();

function toBase64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, textEncoder.encode(value));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function parseCookies(request) {
  const source = request.headers.get('Cookie') || '';
  const out = {};
  source
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const idx = part.indexOf('=');
      out[part.slice(0, idx)] = decodeURIComponent(part.slice(idx + 1));
    });
  return out;
}

export async function serializeSession(secret, user) {
  const payload = toBase64Url(textEncoder.encode(JSON.stringify(user)));
  const signature = await hmacHex(secret, payload);
  return `${payload}.${signature}`;
}

export async function readSession(secret, request) {
  const cookies = parseCookies(request);
  const raw = cookies.legitcheck_session;
  if (!raw || !raw.includes('.')) return null;
  const [payload, signature] = raw.split('.');
  const expected = await hmacHex(secret, payload);
  if (signature !== expected) return null;
  try {
    const bytes = fromBase64Url(payload);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function getBaseUrl(request, env) {
  if (env.BASE_URL) return env.BASE_URL.replace(/\/$/, '');
  return new URL(request.url).origin;
}

export function redirectWithError(request, env, code) {
  const url = new URL('/', getBaseUrl(request, env));
  url.searchParams.set('auth_error', code);
  return Response.redirect(url.toString(), 302);
}

export function isDiscordConfigured(env) {
  return Boolean(
    env.DISCORD_CLIENT_ID &&
      env.DISCORD_CLIENT_SECRET &&
      env.SESSION_SECRET &&
      env.SESSION_SECRET !== 'change-me-please'
  );
}

export function setCookie(name, value, maxAgeSeconds) {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax; Secure`;
}

export function clearCookie(name) {
  return `${name}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure`;
}
