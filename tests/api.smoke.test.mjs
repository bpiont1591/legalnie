import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';

const PORT = 4299;
const BASE = `http://127.0.0.1:${PORT}`;
const SESSION_SECRET = 'change-me-please';

function sessionCookie(user) {
  const payload = Buffer.from(JSON.stringify(user)).toString('base64url');
  const sig = createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `legitcheck_session=${payload}.${sig}`;
}

let server;

async function waitForServer() {
  for (let i = 0; i < 30; i += 1) {
    try {
      const res = await fetch(`${BASE}/auth/config`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

test.before(async () => {
  server = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });
  await waitForServer();
});

test.after(() => {
  if (server) server.kill('SIGTERM');
});

test('unauthorized create profile is blocked', async () => {
  const res = await fetch(`${BASE}/api/profile/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'brakauth' })
  });
  assert.equal(res.status, 401);
});

test('create profile and add review/report flow', async () => {
  const owner = sessionCookie({ account: 'dc_200000000000000001', display: 'owner' });
  const reviewer = sessionCookie({ account: 'dc_200000000000000002', display: 'reviewer' });

  const create = await fetch(`${BASE}/api/profile/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: owner },
    body: JSON.stringify({ slug: 'sklep-testowy' })
  });
  assert.equal(create.status, 200);

  const reviewMissing = await fetch(`${BASE}/api/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: reviewer },
    body: JSON.stringify({ user: 'nie-istnieje', rating: 'legit', reason: 'ok' })
  });
  assert.equal(reviewMissing.status, 404);

  const review = await fetch(`${BASE}/api/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: reviewer },
    body: JSON.stringify({ user: 'sklep-testowy', rating: 'legit', reason: 'ok' })
  });
  assert.equal(review.status, 200);
  const reviewData = await review.json();
  assert.equal(reviewData.ok, true);

  const reviewId = reviewData.profile.reviews[0].id;

  const reportMissing = await fetch(`${BASE}/api/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: owner },
    body: JSON.stringify({ user: 'nie-istnieje', reviewId })
  });
  assert.equal(reportMissing.status, 404);

  const report = await fetch(`${BASE}/api/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: owner },
    body: JSON.stringify({ user: 'sklep-testowy', reviewId })
  });
  assert.equal(report.status, 200);
});


test('owner can delete profile and create a new one', async () => {
  const owner = sessionCookie({ account: 'dc_200000000000000011', display: 'owner2' });

  const create = await fetch(`${BASE}/api/profile/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: owner },
    body: JSON.stringify({ slug: 'profil-do-usuniecia' })
  });
  assert.equal(create.status, 200);

  const del = await fetch(`${BASE}/api/profile/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: owner },
    body: JSON.stringify({ user: 'profil-do-usuniecia' })
  });
  assert.equal(del.status, 200);

  const recreate = await fetch(`${BASE}/api/profile/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: owner },
    body: JSON.stringify({ slug: 'nowy-profil-owner2' })
  });
  assert.equal(recreate.status, 200);
});
