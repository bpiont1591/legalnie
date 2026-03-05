const STORAGE_KEY = 'legitcheck_profiles_v2';
const SESSION_KEY = 'legitcheck_session_user_v2';

const runtimeConfig = window.LEGITCHECK_CONFIG || {};
const DISCORD_CLIENT_ID = runtimeConfig.DISCORD_CLIENT_ID || '';
const DISCORD_AUTH_URL = 'https://discord.com/oauth2/authorize';
const DISCORD_API_ME = 'https://discord.com/api/users/@me';

const authMessage = document.querySelector('#authMessage');
const logoutBtn = document.querySelector('#logoutBtn');
const discordLoginBtn = document.querySelector('#discordLoginBtn');

const createProfileForm = document.querySelector('#createProfileForm');
const createProfileMessage = document.querySelector('#createProfileMessage');
const profileSection = document.querySelector('#profileSection');
const emptyState = document.querySelector('#emptyState');
const profileName = document.querySelector('#profileName');
const ownerBadge = document.querySelector('#ownerBadge');
const trustLevel = document.querySelector('#trustLevel');
const legitCount = document.querySelector('#legitCount');
const soldCount = document.querySelector('#soldCount');
const scamCount = document.querySelector('#scamCount');

const claimProfileBtn = document.querySelector('#claimProfileBtn');
const ownerPanelMessage = document.querySelector('#ownerPanelMessage');
const ownerSettingsForm = document.querySelector('#ownerSettingsForm');
const ownerBioInput = document.querySelector('#ownerBio');
const ownerBioDisplay = document.querySelector('#ownerBioDisplay');

const reviewForm = document.querySelector('#reviewForm');
const reasonSelect = document.querySelector('#reason');
const reviewLimitMessage = document.querySelector('#reviewLimitMessage');
const submitReviewButton = document.querySelector('#submitReview');
const reviewsList = document.querySelector('#reviewsList');
const reportsList = document.querySelector('#reportsList');

const copyProfileLink = document.querySelector('#copyProfileLink');
const yearNode = document.querySelector('#year');

const ratingMeta = {
  legit: { label: 'Legit ✅' },
  sold: { label: 'Sprzedał 💼' },
  scam: { label: 'Oszukał ❌' }
};

const reasonCatalog = {
  legit: ['Szybka wysyłka', 'Towar zgodny z opisem', 'Dobry kontakt', 'Polecam sprzedawcę'],
  sold: ['Sprzedane bez problemu', 'Transakcja zakończona pomyślnie', 'Płatność i odbiór poprawne', 'Finalizacja zgodnie z ustaleniami'],
  scam: ['Brak wysyłki po płatności', 'Towar niezgodny z opisem', 'Brak kontaktu po transakcji', 'Podejrzenie oszustwa']
};

function slugify(text) {
  return String(text).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
}

function loadDb() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { profiles: {} };
  } catch {
    return { profiles: {} };
  }
}

function saveDb(db) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

function getSessionUser() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY)) || null;
  } catch {
    return null;
  }
}

function getSessionAccount() {
  return getSessionUser()?.account || '';
}

function setSessionUser(sessionUser) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(sessionUser));
}

function clearSessionAccount() {
  localStorage.removeItem(SESSION_KEY);
}

function getDiscordRedirectUri() {
  return `${window.location.origin}${window.location.pathname}`;
}

function buildDiscordAuthUrl() {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: getDiscordRedirectUri(),
    response_type: 'token',
    scope: 'identify'
  });
  return `${DISCORD_AUTH_URL}?${params.toString()}`;
}

async function tryDiscordLoginFromHash() {
  if (!window.location.hash.includes('access_token=')) return;

  const hash = new URLSearchParams(window.location.hash.slice(1));
  const accessToken = hash.get('access_token');
  if (!accessToken) return;

  try {
    const response = await fetch(DISCORD_API_ME, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) throw new Error('discord_profile_failed');

    const profile = await response.json();
    const account = slugify(`dc_${profile.id}`);
    const display = `${profile.username}${profile.discriminator && profile.discriminator !== '0' ? `#${profile.discriminator}` : ''}`;

    setSessionUser({
      account,
      provider: 'discord',
      display,
      discordId: profile.id,
      avatar: profile.avatar || null
    });
    authMessage.textContent = `Zalogowano przez Discord jako ${display}`;
  } catch {
    authMessage.textContent = 'Nie udało się zalogować przez Discord. Sprawdź konfigurację OAuth.';
  }

  window.history.replaceState({}, '', window.location.pathname + window.location.search);
}

function getCurrentUser() {
  const params = new URLSearchParams(window.location.search);
  return slugify(params.get('user') || '');
}

function setCurrentUser(user) {
  const url = new URL(window.location.href);
  url.searchParams.set('user', user);
  window.history.replaceState({}, '', url);
}

function ensureProfile(user) {
  const db = loadDb();
  if (!db.profiles[user]) {
    db.profiles[user] = {
      owner: null,
      ownerBio: '',
      createdAt: new Date().toISOString(),
      reviews: [],
      reports: []
    };
    saveDb(db);
  }
}

function computeStats(reviews) {
  return reviews.reduce(
    (acc, review) => {
      if (acc[review.rating] !== undefined) acc[review.rating] += 1;
      return acc;
    },
    { legit: 0, sold: 0, scam: 0 }
  );
}

function renderReasonOptions(rating) {
  const options = reasonCatalog[rating] || [];
  reasonSelect.innerHTML = ['<option value="" selected disabled>Wybierz powód...</option>', ...options.map((r) => `<option value="${r}">${r}</option>`)].join('');
}

function renderTrustPill(stats) {
  const total = stats.legit + stats.sold + stats.scam;
  if (!total) {
    trustLevel.textContent = 'Brak ocen';
    trustLevel.style.background = 'rgba(255,255,255,.13)';
    return;
  }
  const trustScore = Math.round(((stats.legit + stats.sold) / total) * 100);
  if (trustScore >= 85) {
    trustLevel.textContent = `Wysokie zaufanie · ${trustScore}%`;
    trustLevel.style.background = 'rgba(46,206,139,.22)';
  } else if (trustScore >= 60) {
    trustLevel.textContent = `Umiarkowane zaufanie · ${trustScore}%`;
    trustLevel.style.background = 'rgba(246,186,77,.24)';
  } else {
    trustLevel.textContent = `Niskie zaufanie · ${trustScore}%`;
    trustLevel.style.background = 'rgba(239,84,102,.26)';
  }
}

function renderAuthUi() {
  const sessionUser = getSessionUser();
  const account = sessionUser?.account;
  if (account) {
    authMessage.textContent = `Zalogowano jako Discord: ${sessionUser.display || account}`;
    logoutBtn.classList.remove('hidden');
  } else {
    authMessage.textContent = 'Nie jesteś zalogowany. Użyj Discord OAuth.';
    logoutBtn.classList.add('hidden');
  }

  if (!DISCORD_CLIENT_ID) {
    discordLoginBtn.disabled = true;
    discordLoginBtn.textContent = 'Brak DISCORD_CLIENT_ID (Cloud Secret)';
  }
}

function renderOwnerPanel(profile) {
  const account = getSessionAccount();
  const isOwner = account && profile.owner === account;

  ownerBadge.textContent = profile.owner ? `Właściciel: @${profile.owner}` : 'Właściciel: nieustawiony';
  ownerBioDisplay.textContent = profile.ownerBio ? `Opis: ${profile.ownerBio}` : '';

  if (!account) {
    ownerPanelMessage.textContent = 'Zaloguj się przez Discord, aby claimować profil.';
    claimProfileBtn.disabled = true;
    ownerSettingsForm.classList.add('hidden');
    return;
  }

  if (!profile.owner) {
    ownerPanelMessage.textContent = 'Ten profil nie ma właściciela. Możesz go przypisać do swojego konta.';
    claimProfileBtn.disabled = false;
    ownerSettingsForm.classList.add('hidden');
    return;
  }

  if (isOwner) {
    ownerPanelMessage.textContent = 'To Twój profil. Możesz edytować opis i moderować zgłoszenia.';
    claimProfileBtn.disabled = true;
    ownerSettingsForm.classList.remove('hidden');
    ownerBioInput.value = profile.ownerBio || '';
  } else {
    ownerPanelMessage.textContent = `Profil należy do @${profile.owner}.`;
    claimProfileBtn.disabled = true;
    ownerSettingsForm.classList.add('hidden');
  }
}

function renderReviewPermission(profile) {
  const account = getSessionAccount();
  if (!account) {
    submitReviewButton.disabled = true;
    reviewLimitMessage.textContent = 'Zaloguj się przez Discord, aby wystawić opinię.';
    return;
  }

  if (profile.owner === account) {
    submitReviewButton.disabled = true;
    reviewLimitMessage.textContent = 'Właściciel profilu nie może wystawiać opinii sam sobie.';
    return;
  }

  const existing = profile.reviews.find((r) => r.reviewerAccount === account);
  if (existing) {
    submitReviewButton.disabled = false;
    reviewLimitMessage.textContent = 'Masz już opinię dla tego profilu — wysłanie formularza zaktualizuje Twoją opinię.';
    return;
  }

  submitReviewButton.disabled = false;
  reviewLimitMessage.textContent = 'Możesz dodać 1 opinię dla tego profilu.';
}

function renderReviews(profile, user) {
  if (!profile.reviews.length) {
    reviewsList.innerHTML = '<li class="review">Brak opinii dla tego profilu.</li>';
    return;
  }

  const account = getSessionAccount();
  reviewsList.innerHTML = profile.reviews
    .slice()
    .reverse()
    .map((review) => {
      const date = new Date(review.createdAt).toLocaleDateString('pl-PL');
      const canReport = account && account !== review.reviewerAccount;
      return `
        <li class="review">
          <div class="review-head">
            <span>${ratingMeta[review.rating].label}</span>
            <span>${date}</span>
          </div>
          <p>${review.reason}</p>
          <small class="review-author">Opinia od: @${review.reviewerAccount}</small>
          ${canReport ? `<button class="btn btn-report" data-report-review="${review.id}" data-report-user="${user}">Zgłoś opinię</button>` : ''}
        </li>`;
    })
    .join('');
}

function renderReports(profile) {
  const account = getSessionAccount();
  const isOwner = account && profile.owner === account;
  if (!isOwner) {
    reportsList.innerHTML = '<li class="review">Brak dostępu do zgłoszeń.</li>';
    return;
  }

  const openReports = profile.reports.filter((r) => r.status === 'open');
  if (!openReports.length) {
    reportsList.innerHTML = '<li class="review">Brak otwartych zgłoszeń.</li>';
    return;
  }

  reportsList.innerHTML = openReports
    .map(
      (report) => `
      <li class="review">
        <div class="review-head"><span>Zgłoszenie</span><span>${new Date(report.createdAt).toLocaleDateString('pl-PL')}</span></div>
        <p>Opinia ID: ${report.reviewId}</p>
        <p>Zgłaszający: @${report.reportedBy}</p>
        <button class="btn btn-secondary" data-resolve-report="${report.id}">Oznacz jako rozwiązane</button>
      </li>`
    )
    .join('');
}

function renderProfile() {
  const user = getCurrentUser();
  if (!user) {
    profileSection.classList.add('hidden');
    emptyState.classList.remove('hidden');
    copyProfileLink.disabled = true;
    return;
  }

  ensureProfile(user);
  const db = loadDb();
  const profile = db.profiles[user];
  const stats = computeStats(profile.reviews);

  profileName.textContent = `@${user}`;
  legitCount.textContent = stats.legit;
  soldCount.textContent = stats.sold;
  scamCount.textContent = stats.scam;

  renderTrustPill(stats);
  renderOwnerPanel(profile);
  renderReviewPermission(profile);
  renderReviews(profile, user);
  renderReports(profile);

  profileSection.classList.remove('hidden');
  emptyState.classList.add('hidden');
  copyProfileLink.disabled = false;
}

discordLoginBtn.addEventListener('click', () => {
  if (!DISCORD_CLIENT_ID) {
    authMessage.textContent = 'Ustaw DISCORD_CLIENT_ID przez Cloud Secret / runtime config.';
    return;
  }
  window.location.href = buildDiscordAuthUrl();
});

logoutBtn.addEventListener('click', () => {
  clearSessionAccount();
  renderAuthUi();
  renderProfile();
});

createProfileForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const user = slugify(new FormData(createProfileForm).get('username'));
  if (!user || user.length < 3) {
    createProfileMessage.textContent = 'Podaj poprawną nazwę profilu (min. 3 znaki).';
    return;
  }

  const db = loadDb();
  if (db.profiles[user]) {
    createProfileMessage.textContent = `Profil @${user} już istnieje — otwarto istniejący profil.`;
    setCurrentUser(user);
    renderProfile();
    return;
  }

  db.profiles[user] = { owner: null, ownerBio: '', createdAt: new Date().toISOString(), reviews: [], reports: [] };
  saveDb(db);
  setCurrentUser(user);
  createProfileMessage.textContent = `Utworzono profil @${user}.`;
  renderProfile();
});

claimProfileBtn.addEventListener('click', () => {
  const user = getCurrentUser();
  const account = getSessionAccount();
  if (!user || !account) return;

  const db = loadDb();
  const profile = db.profiles[user];
  if (!profile.owner) {
    profile.owner = account;
    saveDb(db);
  }

  renderProfile();
});

ownerSettingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const user = getCurrentUser();
  const account = getSessionAccount();
  if (!user || !account) return;

  const db = loadDb();
  const profile = db.profiles[user];
  if (profile.owner !== account) return;

  profile.ownerBio = String(new FormData(ownerSettingsForm).get('ownerBio') || '').trim();
  saveDb(db);
  renderProfile();
});

reviewForm.addEventListener('change', (event) => {
  if (event.target.name === 'rating') renderReasonOptions(event.target.value);
});

reviewForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const user = getCurrentUser();
  const account = getSessionAccount();
  if (!user || !account) return;

  const formData = new FormData(reviewForm);
  const rating = String(formData.get('rating'));
  const reason = String(formData.get('reason') || '').trim();
  if (!rating || !reason) return;

  const db = loadDb();
  const profile = db.profiles[user];
  if (profile.owner === account) {
    reviewLimitMessage.textContent = 'Nie możesz ocenić własnego profilu.';
    return;
  }

  const existing = profile.reviews.find((review) => review.reviewerAccount === account);
  if (existing) {
    existing.rating = rating;
    existing.reason = reason;
    existing.updatedAt = new Date().toISOString();
  } else {
    profile.reviews.push({
      id: `rvw_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      rating,
      reason,
      reviewerAccount: account,
      createdAt: new Date().toISOString()
    });
  }

  saveDb(db);
  reviewForm.reset();
  renderReasonOptions(null);
  renderProfile();
});

reviewsList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-report-review]');
  if (!button) return;

  const user = button.dataset.reportUser;
  const reviewId = button.dataset.reportReview;
  const account = getSessionAccount();
  if (!user || !reviewId || !account) return;

  const db = loadDb();
  const profile = db.profiles[user];
  const already = profile.reports.find((r) => r.reviewId === reviewId && r.reportedBy === account && r.status === 'open');
  if (already) return;

  profile.reports.push({
    id: `rep_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    reviewId,
    reportedBy: account,
    status: 'open',
    createdAt: new Date().toISOString()
  });
  saveDb(db);
  renderProfile();
});

reportsList.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-resolve-report]');
  if (!btn) return;

  const user = getCurrentUser();
  const account = getSessionAccount();
  if (!user || !account) return;

  const db = loadDb();
  const profile = db.profiles[user];
  if (profile.owner !== account) return;

  const report = profile.reports.find((r) => r.id === btn.dataset.resolveReport);
  if (!report) return;

  report.status = 'resolved';
  report.resolvedAt = new Date().toISOString();
  saveDb(db);
  renderProfile();
});

copyProfileLink.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    copyProfileLink.textContent = 'Skopiowano!';
    setTimeout(() => {
      copyProfileLink.textContent = 'Kopiuj link profilu';
    }, 1200);
  } catch {
    copyProfileLink.textContent = 'Nie udało się skopiować';
  }
});

if (yearNode) yearNode.textContent = new Date().getFullYear();

async function boot() {
  await tryDiscordLoginFromHash();
  renderReasonOptions(null);
  renderAuthUi();
  renderProfile();
}

boot();
