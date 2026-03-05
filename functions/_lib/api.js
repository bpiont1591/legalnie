import { readSession } from './auth.js';

const ADMIN_DISCORD_ID = '1418289596457812088';

const MEM_DB = globalThis.__legitcheckDb || (globalThis.__legitcheckDb = { profiles: {}, blockedAccounts: {} });
const RATE_LIMITS = globalThis.__legitcheckRateLimits || (globalThis.__legitcheckRateLimits = new Map());
if (!MEM_DB.blockedAccounts) MEM_DB.blockedAccounts = {};

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

function isAdmin(user) {
  return Boolean(user?.account === `dc_${ADMIN_DISCORD_ID}`);
}

function isBlockedMem(account) {
  return Boolean(MEM_DB.blockedAccounts?.[account]);
}

async function bodyJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
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

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

function isRateLimited(request, user, action, limit = 20, windowMs = 60_000) {
  const key = `${action}:${user?.account || 'anon'}:${clientIp(request)}`;
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
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS blocked_accounts (
      account TEXT PRIMARY KEY,
      blocked_at TEXT NOT NULL,
      blocked_by TEXT NOT NULL
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

  const indexStatements = [
    'CREATE INDEX IF NOT EXISTS idx_profiles_owner ON profiles(owner)',
    'CREATE INDEX IF NOT EXISTS idx_reviews_profile_slug ON reviews(profile_slug)',
    'CREATE INDEX IF NOT EXISTS idx_reviews_reviewer_account ON reviews(reviewer_account)',
    'CREATE INDEX IF NOT EXISTS idx_reports_profile_slug ON reports(profile_slug)',
    'CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status)',
    'CREATE INDEX IF NOT EXISTS idx_blocked_accounts_blocked_by ON blocked_accounts(blocked_by)'
  ];
  for (const stmt of indexStatements) {
    await env.DB.prepare(stmt).run();
  }
}

async function getProfile(env, slug) {
  if (!env.DB) return MEM_DB.profiles[slug] || null;
  const p = await env.DB
    .prepare('SELECT slug, owner, owner_display, owner_avatar, owner_bio, created_at FROM profiles WHERE slug = ?')
    .bind(slug)
    .first();
  if (!p) return null;
  const reviews = (
    await env.DB
      .prepare('SELECT id, rating, reason, reviewer_account, reviewer_display, reviewer_avatar, created_at, updated_at FROM reviews WHERE profile_slug = ?')
      .bind(slug)
      .all()
  ).results;
  const reports = (
    await env.DB
      .prepare('SELECT id, review_id, reported_by, status, created_at, resolved_at FROM reports WHERE profile_slug = ?')
      .bind(slug)
      .all()
  ).results;
  return {
    owner: p.owner,
    ownerDisplay: p.owner_display || '',
    ownerAvatar: p.owner_avatar || '',
    ownerBio: p.owner_bio,
    createdAt: p.created_at,
    reviews: reviews.map((r) => ({
      id: r.id,
      rating: r.rating,
      reason: r.reason,
      reviewerAccount: r.reviewer_account,
      reviewerDisplay: r.reviewer_display || '',
      reviewerAvatar: r.reviewer_avatar || '',
      createdAt: r.created_at,
      updatedAt: r.updated_at || undefined
    })),
    reports: reports.map((r) => ({
      id: r.id,
      reviewId: r.review_id,
      reportedBy: r.reported_by,
      status: r.status,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at || undefined
    }))
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

  await env.DB
    .prepare('INSERT OR REPLACE INTO profiles (slug, owner, owner_display, owner_avatar, owner_bio, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(slug, profile.owner, profile.ownerDisplay || '', profile.ownerAvatar || '', profile.ownerBio || '', createdAt)
    .run();

  await env.DB.prepare('DELETE FROM reviews WHERE profile_slug = ?').bind(fromSlug).run();
  await env.DB.prepare('DELETE FROM reports WHERE profile_slug = ?').bind(fromSlug).run();

  for (const r of profile.reviews || []) {
    await env.DB
      .prepare('INSERT INTO reviews (id, profile_slug, rating, reason, reviewer_account, reviewer_display, reviewer_avatar, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(r.id, slug, r.rating, r.reason, r.reviewerAccount, r.reviewerDisplay || '', r.reviewerAvatar || '', r.createdAt, r.updatedAt || null)
      .run();
  }

  for (const rp of profile.reports || []) {
    await env.DB
      .prepare('INSERT INTO reports (id, profile_slug, review_id, reported_by, status, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
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

async function isBlockedAccount(env, account) {
  if (!account) return false;
  if (!env.DB) return isBlockedMem(account);
  const row = await env.DB.prepare('SELECT account FROM blocked_accounts WHERE account = ? LIMIT 1').bind(account).first();
  return Boolean(row?.account);
}

async function setBlockedAccount(env, account, blocked, adminAccount) {
  if (!env.DB) {
    MEM_DB.blockedAccounts = MEM_DB.blockedAccounts || {};
    if (blocked) MEM_DB.blockedAccounts[account] = { blockedAt: new Date().toISOString(), blockedBy: adminAccount };
    else delete MEM_DB.blockedAccounts[account];
    return;
  }

  if (blocked) {
    await env.DB
      .prepare('INSERT OR REPLACE INTO blocked_accounts (account, blocked_at, blocked_by) VALUES (?, ?, ?)')
      .bind(account, new Date().toISOString(), adminAccount)
      .run();
  } else {
    await env.DB.prepare('DELETE FROM blocked_accounts WHERE account = ?').bind(account).run();
  }
}

async function collectOpenReports(env) {
  if (!env.DB) {
    const items = [];
    for (const [slug, profile] of Object.entries(MEM_DB.profiles || {})) {
      for (const report of profile.reports || []) {
        if (report.status !== 'open') continue;
        const review = (profile.reviews || []).find((r) => r.id === report.reviewId);
        const reviewerAccount = review?.reviewerAccount || '';
        items.push({
          profileSlug: slug,
          reportId: report.id,
          reviewId: report.reviewId,
          reportedBy: report.reportedBy,
          reviewerAccount,
          reviewerDisplay: review?.reviewerDisplay || '',
          reason: review?.reason || '',
          rating: review?.rating || '',
          createdAt: report.createdAt,
          blocked: reviewerAccount ? isBlockedMem(reviewerAccount) : false
        });
      }
    }
    return items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  const reports = (
    await env.DB
      .prepare(`SELECT rp.id AS report_id, rp.profile_slug, rp.review_id, rp.reported_by, rp.created_at,
                       rv.reviewer_account, rv.reviewer_display, rv.reason, rv.rating,
                       ba.account AS blocked_account
                FROM reports rp
                LEFT JOIN reviews rv ON rv.id = rp.review_id
                LEFT JOIN blocked_accounts ba ON ba.account = rv.reviewer_account
                WHERE rp.status = 'open'
                ORDER BY rp.created_at DESC`)
      .all()
  ).results || [];

  return reports.map((row) => ({
    profileSlug: row.profile_slug,
    reportId: row.report_id,
    reviewId: row.review_id,
    reportedBy: row.reported_by,
    reviewerAccount: row.reviewer_account || '',
    reviewerDisplay: row.reviewer_display || '',
    reason: row.reason || '',
    rating: row.rating || '',
    createdAt: row.created_at,
    blocked: Boolean(row.blocked_account)
  }));
}

export async function handleApiRequest(request, env) {
  await ensureSchema(env);
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname === '/api/my-profile' && request.method === 'GET') {
    const user = await requireSession(request, env);
    if (!user) return json({ error: 'unauthorized' }, { status: 401 });
    return json({ slug: (await findOwnedProfile(env, user.account)) || null });
  }

  if (pathname === '/api/profile' && request.method === 'GET') {
    const slug = slugify(url.searchParams.get('user'));
    if (!slug) return json({ profile: null });
    const profile = await getProfile(env, slug);
    if (!profile) return json({ profile: null });

    const sessionUser = await readSession(env.SESSION_SECRET || '', request);
    if (profile.owner && sessionUser?.account === profile.owner) {
      const nextDisplay = sessionUser.display || '';
      const nextAvatar = sessionUser.avatarUrl || '';
      if ((nextDisplay && !profile.ownerDisplay) || (nextAvatar && !profile.ownerAvatar)) {
        profile.ownerDisplay = nextDisplay || profile.ownerDisplay || '';
        profile.ownerAvatar = nextAvatar || profile.ownerAvatar || '';
        await saveProfile(env, slug, profile);
      }
    }

    return json({ profile: sanitizeProfile(profile) });
  }

  if (pathname === '/api/profile/create' && request.method === 'POST') {
    const user = await requireSession(request, env);
    if (!user) return json({ error: 'unauthorized' }, { status: 401 });
    if (await isBlockedAccount(env, user.account)) return json({ error: 'blocked_user' }, { status: 403 });
    if (isRateLimited(request, user, 'profile_create', 6)) return json({ error: 'rate_limited' }, { status: 429 });

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
    if (await isBlockedAccount(env, user.account)) return json({ error: 'blocked_user' }, { status: 403 });
    if (isRateLimited(request, user, 'profile_claim', 10)) return json({ error: 'rate_limited' }, { status: 429 });

    const slug = slugify((await bodyJson(request)).user);
    if (!isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
    const profile = (await getProfile(env, slug)) || { owner: null, ownerDisplay: '', ownerAvatar: '', ownerBio: '', createdAt: new Date().toISOString(), reviews: [], reports: [] };
    if (profile.owner && profile.owner !== user.account) return json({ error: 'already_owned' }, { status: 409 });
    profile.owner = user.account;
    profile.ownerDisplay = user.display || profile.ownerDisplay || '';
    profile.ownerAvatar = user.avatarUrl || profile.ownerAvatar || '';
    await saveProfile(env, slug, profile);
    return json({ ok: true, profile: sanitizeProfile(profile) });
  }

  if (pathname === '/api/profile/settings' && request.method === 'POST') {
    const user = await requireSession(request, env);
    if (!user) return json({ error: 'unauthorized' }, { status: 401 });
    if (await isBlockedAccount(env, user.account)) return json({ error: 'blocked_user' }, { status: 403 });
    if (isRateLimited(request, user, 'profile_settings', 20)) return json({ error: 'rate_limited' }, { status: 429 });

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
    if (await isBlockedAccount(env, user.account)) return json({ error: 'blocked_user' }, { status: 403 });
    if (isRateLimited(request, user, 'review_write', 12)) return json({ error: 'rate_limited' }, { status: 429 });

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
    if (await isBlockedAccount(env, user.account)) return json({ error: 'blocked_user' }, { status: 403 });
    if (isRateLimited(request, user, 'report_write', 12)) return json({ error: 'rate_limited' }, { status: 429 });

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
    if (isRateLimited(request, user, 'report_resolve', 20)) return json({ error: 'rate_limited' }, { status: 429 });

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

  if (pathname === '/api/admin/reports' && request.method === 'GET') {
    const user = await requireSession(request, env);
    if (!user) return json({ error: 'unauthorized' }, { status: 401 });
    if (!isAdmin(user)) return json({ error: 'forbidden' }, { status: 403 });
    return json({ reports: await collectOpenReports(env) });
  }

  if (pathname === '/api/admin/report/action' && request.method === 'POST') {
    const user = await requireSession(request, env);
    if (!user) return json({ error: 'unauthorized' }, { status: 401 });
    if (!isAdmin(user)) return json({ error: 'forbidden' }, { status: 403 });
    if (isRateLimited(request, user, 'admin_report_action', 60)) return json({ error: 'rate_limited' }, { status: 429 });

    const body = await bodyJson(request);
    const profileSlug = slugify(body.profileSlug);
    const reportId = String(body.reportId || '');
    const action = String(body.action || '');
    if (!isValidSlug(profileSlug) || !reportId || !['keep', 'delete_review', 'dismiss'].includes(action)) {
      return json({ error: 'invalid_input' }, { status: 400 });
    }

    const profile = await getProfile(env, profileSlug);
    if (!profile) return json({ error: 'profile_not_found' }, { status: 404 });
    const report = profile.reports.find((r) => r.id === reportId);
    if (!report) return json({ error: 'report_not_found' }, { status: 404 });

    if (action === 'delete_review') {
      profile.reviews = profile.reviews.filter((r) => r.id !== report.reviewId);
      profile.reports = profile.reports.filter((r) => r.reviewId !== report.reviewId);
    } else if (action === 'dismiss') {
      profile.reports = profile.reports.filter((r) => r.id !== reportId);
    } else {
      report.status = 'resolved';
      report.resolvedAt = new Date().toISOString();
    }

    await saveProfile(env, profileSlug, profile);
    return json({ ok: true, reports: await collectOpenReports(env) });
  }

  if (pathname === '/api/admin/block' && request.method === 'POST') {
    const user = await requireSession(request, env);
    if (!user) return json({ error: 'unauthorized' }, { status: 401 });
    if (!isAdmin(user)) return json({ error: 'forbidden' }, { status: 403 });
    if (isRateLimited(request, user, 'admin_block_action', 60)) return json({ error: 'rate_limited' }, { status: 429 });

    const body = await bodyJson(request);
    const account = String(body.account || '');
    const blocked = Boolean(body.blocked);
    if (!/^dc_[0-9]+$/.test(account)) return json({ error: 'invalid_input' }, { status: 400 });

    await setBlockedAccount(env, account, blocked, user.account);
    return json({ ok: true });
  }

  return json({ error: 'not_found' }, { status: 404 });
}
