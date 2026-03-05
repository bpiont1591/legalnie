let sessionUser = null;
let discordConfigured = true;
const ADMIN_ACCOUNT = 'dc_1418289596457812088';

const loginView = document.querySelector('#loginView');
const appView = document.querySelector('#appView');

const authMessage = document.querySelector('#authMessage');
const logoutBtn = document.querySelector('#logoutBtn');
const discordLoginBtn = document.querySelector('#discordLoginBtn');
const profileDiscordLoginBtn = document.querySelector('#profileDiscordLoginBtn');

const createProfileForm = document.querySelector('#createProfileForm');
const createProfileMessage = document.querySelector('#createProfileMessage');
const createProfileLockMessage = document.querySelector('#createProfileLockMessage');
const createProfileBtn = document.querySelector('#createProfileBtn');
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
const ownerSettingsMessage = document.querySelector('#ownerSettingsMessage');
const ownerBioInput = document.querySelector('#ownerBio');
const profileSlugInput = document.querySelector('#profileSlug');
const ownerBioDisplay = document.querySelector('#ownerBioDisplay');

const reviewForm = document.querySelector('#reviewForm');
const reasonSelect = document.querySelector('#reason');
const reviewLimitMessage = document.querySelector('#reviewLimitMessage');
const submitReviewButton = document.querySelector('#submitReview');
const reviewsList = document.querySelector('#reviewsList');
const reportsList = document.querySelector('#reportsList');
const adminPanel = document.querySelector('#adminPanel');
const adminPanelMessage = document.querySelector('#adminPanelMessage');
const adminReportsList = document.querySelector('#adminReportsList');

const copyProfileLink = document.querySelector('#copyProfileLink');
const yearNode = document.querySelector('#year');

let currentProfile = null;
let ownedProfileSlug = null;
let profileResolved = false;
let adminReports = [];

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


function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '');
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function getSessionAccount() {
  return sessionUser?.account || '';
}

function isAdminUser() {
  return getSessionAccount() === ADMIN_ACCOUNT;
}

function getCurrentUser() {
  const pathMatch = window.location.pathname.match(/^\/u\/([a-zA-Z0-9_-]{3,30})$/);
  if (pathMatch) return slugify(pathMatch[1]);
  const params = new URLSearchParams(window.location.search);
  return slugify(params.get('user') || '');
}

function setCurrentUser(user) {
  if (user) {
    window.history.replaceState({}, '', `/u/${user}`);
  } else {
    window.history.replaceState({}, '', '/');
  }
}


function applyInitialRouteView() {
  const hasPublicProfileInUrl = Boolean(getCurrentUser());
  if (hasPublicProfileInUrl) {
    loginView.classList.add('hidden');
    appView.classList.remove('hidden');
  } else {
    loginView.classList.remove('hidden');
    appView.classList.add('hidden');
  }
  document.body.classList.remove('preboot');
}

function readAuthErrorFromUrl() {
  const url = new URL(window.location.href);
  const authError = url.searchParams.get('auth_error');
  if (!authError) return;

  const authErrorMap = {
    missing_server_oauth_config: 'Serwer OAuth nie jest skonfigurowany (DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / SESSION_SECRET).',
    oauth_state_mismatch: 'Błąd bezpieczeństwa OAuth (state mismatch). Spróbuj ponownie.',
    discord_token_exchange_failed: 'Discord odrzucił wymianę kodu na token. Sprawdź Redirect URI w Discord Developer Portal.',
    discord_profile_failed: 'Nie udało się pobrać profilu Discord.',
    discord_denied_or_failed: 'Logowanie Discord zostało anulowane lub odrzucone.'
  };

  authMessage.textContent = authErrorMap[authError] || 'Logowanie nie powiodło się.';
  url.searchParams.delete('auth_error');
  window.history.replaceState({}, '', url);
}

async function refreshAuthConfig() {
  const result = await api('/auth/config', { method: 'GET' });
  discordConfigured = Boolean(result.data.discordConfigured);
}

async function refreshSession() {
  const result = await api('/auth/me', { method: 'GET' });
  sessionUser = result.data.user || null;
}

async function refreshCurrentProfile() {
  const user = getCurrentUser();
  if (!user) {
    currentProfile = null;
    profileResolved = true;
    return;
  }

  profileResolved = false;
  const result = await api(`/api/profile?user=${encodeURIComponent(user)}`, { method: 'GET' });
  currentProfile = result.data.profile || null;
  profileResolved = true;
}

async function refreshAdminReports() {
  if (!isAdminUser()) {
    adminReports = [];
    return;
  }
  const result = await api('/api/admin/reports', { method: 'GET' });
  adminReports = result.ok ? (result.data.reports || []) : [];
}


async function refreshOwnedProfileSlug() {
  if (!getSessionAccount()) {
    ownedProfileSlug = null;
    return;
  }
  const result = await api('/api/my-profile', { method: 'GET' });
  ownedProfileSlug = result.ok ? result.data.slug || null : null;
}

async function ensureLoggedInProfile() {
  if (!getSessionAccount() || getCurrentUser()) return;
  if (ownedProfileSlug) setCurrentUser(ownedProfileSlug);
}

function renderReasonOptions(rating) {
  const options = reasonCatalog[rating] || [];
  reasonSelect.innerHTML = ['<option value="" selected disabled>Wybierz powód...</option>', ...options.map((r) => `<option value="${r}">${r}</option>`)].join('');
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

function renderCreateProfileAccess() {
  const disabled = !getSessionAccount() || Boolean(ownedProfileSlug);
  createProfileBtn.disabled = disabled;
  const usernameInput = document.querySelector('#username');
  if (usernameInput) usernameInput.disabled = disabled;

  if (!getSessionAccount()) {
    createProfileLockMessage.textContent = 'Najpierw zaloguj się przez Discord, aby utworzyć własny link profilu.';
    return;
  }

  if (ownedProfileSlug) {
    createProfileLockMessage.textContent = `Masz już profil @${ownedProfileSlug}. Tworzenie nowego jest wyłączone dla jednego konta.`;
    return;
  }

  createProfileLockMessage.textContent = 'Jesteś zalogowany — możesz utworzyć własny link profilu.';
}

function renderAuthUi() {
  const isLoggedIn = Boolean(getSessionAccount());
  const hasPublicProfileInUrl = Boolean(getCurrentUser());

  if (isLoggedIn) {
    authMessage.textContent = `Zalogowano jako Discord: ${sessionUser.display || sessionUser.account}`;
    logoutBtn.classList.remove('hidden');
    loginView.classList.add('hidden');
    appView.classList.remove('hidden');
  } else {
    authMessage.textContent = 'Możesz przeglądać profile bez logowania. Zaloguj się dopiero gdy chcesz utworzyć własny profil.';
    logoutBtn.classList.add('hidden');

    if (hasPublicProfileInUrl) {
      loginView.classList.add('hidden');
      appView.classList.remove('hidden');
    } else {
      loginView.classList.remove('hidden');
      appView.classList.add('hidden');
    }
  }

  discordLoginBtn.disabled = !discordConfigured;
  discordLoginBtn.textContent = discordConfigured ? 'Zaloguj przez Discord' : 'Discord OAuth nie skonfigurowany na serwerze';

  if (profileDiscordLoginBtn) {
    profileDiscordLoginBtn.disabled = !discordConfigured;
    profileDiscordLoginBtn.classList.toggle('hidden', isLoggedIn || !hasPublicProfileInUrl);
    profileDiscordLoginBtn.textContent = discordConfigured ? 'Zaloguj przez Discord' : 'Discord OAuth nieaktywny';
  }

  renderCreateProfileAccess();
}

function formatAccountWithDisplay(account, display, fallbackDisplay = '') {
  const safeAccount = escapeHtml(account || '');
  const safeDisplay = escapeHtml(display || fallbackDisplay || '');
  if (safeDisplay) return `${safeDisplay} (@${safeAccount})`;
  return `@${safeAccount}`;
}

function renderOwnerPanel(profile) {
  const account = getSessionAccount();
  const isOwner = account && profile.owner === account;
  const ownerDisplay = profile.ownerDisplay || ((profile.owner === account) ? (sessionUser?.display || '') : '');
  const ownerLabel = formatAccountWithDisplay(profile.owner, ownerDisplay);

  ownerBadge.innerHTML = profile.owner
    ? `${profile.ownerAvatar ? `<img class="owner-avatar" src="${escapeHtml(profile.ownerAvatar)}" alt="avatar" />` : ''}<span>Właściciel: ${ownerLabel}</span>`
    : 'Właściciel: nieustawiony';
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
    ownerPanelMessage.textContent = 'To Twój profil. Możesz zmienić nazwę linku, opis i moderować zgłoszenia.';
    claimProfileBtn.disabled = true;
    ownerSettingsForm.classList.remove('hidden');
    ownerBioInput.value = profile.ownerBio || '';
    profileSlugInput.value = getCurrentUser();
  } else {
    ownerPanelMessage.textContent = `Profil należy do ${formatAccountWithDisplay(profile.owner, ownerDisplay)}.`;
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
  submitReviewButton.disabled = false;
  reviewLimitMessage.textContent = existing
    ? 'Masz już opinię dla tego profilu — wysłanie formularza zaktualizuje Twoją opinię.'
    : 'Możesz dodać 1 opinię dla tego profilu.';
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
          <p>${escapeHtml(review.reason)}</p>
          <small class="review-author">${review.reviewerAvatar ? `<img class="review-avatar" src="${escapeHtml(review.reviewerAvatar)}" alt="avatar" />` : ''}<span>Opinia od: @${escapeHtml(review.reviewerAccount)}${review.reviewerDisplay ? ` (${escapeHtml(review.reviewerDisplay)})` : ''}</span></small>
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

function renderAdminPanel() {
  if (!adminPanel || !adminReportsList) return;

  if (!isAdminUser()) {
    adminPanel.classList.add('hidden');
    return;
  }

  adminPanel.classList.remove('hidden');
  adminPanelMessage.textContent = `Otwartych zgłoszeń globalnie: ${adminReports.length}`;

  if (!adminReports.length) {
    adminReportsList.innerHTML = '<li class="review">Brak otwartych zgłoszeń w systemie.</li>';
    return;
  }

  adminReportsList.innerHTML = adminReports
    .map((report) => `
      <li class="review admin-review">
        <div class="review-head"><span>Profil: @${escapeHtml(report.profileSlug)}</span><span>${new Date(report.createdAt).toLocaleDateString('pl-PL')}</span></div>
        <p><strong>Powód:</strong> ${escapeHtml(report.reason || '-')}</p>
        <p><strong>Autor opinii:</strong> ${escapeHtml(report.reviewerDisplay || report.reviewerAccount || '-')} (${escapeHtml(report.reviewerAccount || '-')})</p>
        <p><strong>Zgłaszający:</strong> @${escapeHtml(report.reportedBy || '-')}</p>
        <div class="admin-actions">
          <button class="btn btn-secondary" data-admin-action="keep" data-admin-profile="${escapeHtml(report.profileSlug)}" data-admin-report="${escapeHtml(report.reportId)}">Zostaw i zamknij</button>
          <button class="btn btn-report" data-admin-action="delete_review" data-admin-profile="${escapeHtml(report.profileSlug)}" data-admin-report="${escapeHtml(report.reportId)}">Usuń opinię</button>
          <button class="btn btn-secondary" data-admin-action="dismiss" data-admin-profile="${escapeHtml(report.profileSlug)}" data-admin-report="${escapeHtml(report.reportId)}">Pomiń zgłoszenie</button>
          ${report.reviewerAccount ? `<button class="btn ${report.blocked ? 'btn-secondary' : 'btn-report'}" data-admin-block-account="${escapeHtml(report.reviewerAccount)}" data-admin-blocked="${report.blocked ? 'false' : 'true'}">${report.blocked ? 'Odblokuj autora' : 'Zablokuj autora'}</button>` : ''}
        </div>
      </li>`)
    .join('');
}

function renderProfile() {
  const user = getCurrentUser();

  if (!profileResolved) {
    profileSection.classList.add('hidden');
    emptyState.classList.add('hidden');
    copyProfileLink.disabled = true;
    return;
  }

  if (!user || !currentProfile) {
    profileSection.classList.add('hidden');
    emptyState.classList.remove('hidden');
    copyProfileLink.disabled = true;
    return;
  }

  const stats = computeStats(currentProfile.reviews);
  profileName.textContent = `@${user}`;
  legitCount.textContent = stats.legit;
  soldCount.textContent = stats.sold;
  scamCount.textContent = stats.scam;

  renderTrustPill(stats);
  renderOwnerPanel(currentProfile);
  renderReviewPermission(currentProfile);
  renderReviews(currentProfile, user);
  renderReports(currentProfile);
  renderAdminPanel();

  profileSection.classList.remove('hidden');
  emptyState.classList.add('hidden');
  copyProfileLink.disabled = false;
}

async function syncAndRender() {
  await refreshCurrentProfile();
  await refreshAdminReports();
  renderProfile();
}

discordLoginBtn.addEventListener('click', () => {
  if (!discordConfigured) {
    authMessage.textContent = 'Brak konfiguracji OAuth na serwerze. Ustaw sekrety i spróbuj ponownie.';
    return;
  }
  window.location.href = '/auth/discord/start';
});

if (profileDiscordLoginBtn) {
  profileDiscordLoginBtn.addEventListener('click', () => {
    if (!discordConfigured) return;
    window.location.href = '/auth/discord/start';
  });
}

logoutBtn.addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  await refreshSession();
  ownedProfileSlug = null;
  adminReports = [];
  renderAuthUi();
  renderProfile();
});

createProfileForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (ownedProfileSlug) {
    createProfileMessage.textContent = `Masz już profil @${ownedProfileSlug}.`;
    setCurrentUser(ownedProfileSlug);
    await syncAndRender();
    return;
  }

  const slug = slugify(new FormData(createProfileForm).get('username'));
  if (!slug || slug.length < 3) {
    createProfileMessage.textContent = 'Podaj poprawną nazwę profilu (min. 3 znaki).';
    return;
  }

  const result = await api('/api/profile/create', {
    method: 'POST',
    body: JSON.stringify({ slug })
  });

  if (!result.ok) {
    if (result.data.error === 'slug_taken') {
      createProfileMessage.textContent = `Nazwa @${slug} jest już zajęta.`;
      return;
    }
    if (result.data.error === 'already_has_profile') {
      ownedProfileSlug = result.data.slug || ownedProfileSlug;
      createProfileMessage.textContent = `Masz już profil @${ownedProfileSlug}.`;
      if (ownedProfileSlug) setCurrentUser(ownedProfileSlug);
      await syncAndRender();
      renderAuthUi();
      return;
    }
    createProfileMessage.textContent = 'Nie udało się utworzyć profilu.';
    return;
  }

  ownedProfileSlug = result.data.slug;
  setCurrentUser(result.data.slug);
  createProfileMessage.textContent = `Gotowe. Profil @${result.data.slug} został utworzony.`;
  await syncAndRender();
  renderAuthUi();
});

claimProfileBtn.addEventListener('click', async () => {
  const user = getCurrentUser();
  if (!user) return;
  const result = await api('/api/profile/claim', { method: 'POST', body: JSON.stringify({ user }) });
  if (result.ok) {
    ownedProfileSlug = user;
    renderAuthUi();
  }
  await syncAndRender();
});

ownerSettingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const user = getCurrentUser();
  if (!user) return;

  const formData = new FormData(ownerSettingsForm);
  const nextSlug = slugify(formData.get('profileSlug'));
  const ownerBio = String(formData.get('ownerBio') || '').trim();

  const result = await api('/api/profile/settings', {
    method: 'POST',
    body: JSON.stringify({ user, nextSlug, ownerBio })
  });

  if (!result.ok) {
    ownerSettingsMessage.textContent = result.data.error === 'slug_taken' ? `Nazwa @${nextSlug} jest już zajęta.` : 'Nie udało się zapisać zmian.';
    return;
  }

  setCurrentUser(result.data.slug);
  ownedProfileSlug = result.data.slug;
  ownerSettingsMessage.textContent = 'Zmiany zapisane.';
  await syncAndRender();
  renderAuthUi();
});

reviewForm.addEventListener('change', (event) => {
  if (event.target.name === 'rating') renderReasonOptions(event.target.value);
});

reviewForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const user = getCurrentUser();
  if (!user) return;

  const formData = new FormData(reviewForm);
  const rating = String(formData.get('rating'));
  const reason = String(formData.get('reason') || '').trim();
  if (!rating || !reason) return;

  const result = await api('/api/review', {
    method: 'POST',
    body: JSON.stringify({ user, rating, reason })
  });

  if (!result.ok) {
    reviewLimitMessage.textContent = 'Nie udało się dodać opinii.';
    return;
  }

  reviewForm.reset();
  renderReasonOptions(null);
  await syncAndRender();
});

reviewsList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-report-review]');
  if (!button) return;
  await api('/api/report', {
    method: 'POST',
    body: JSON.stringify({ user: button.dataset.reportUser, reviewId: button.dataset.reportReview })
  });
  await syncAndRender();
});

reportsList.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-resolve-report]');
  if (!btn) return;

  await api('/api/report/resolve', {
    method: 'POST',
    body: JSON.stringify({ user: getCurrentUser(), reportId: btn.dataset.resolveReport })
  });
  await syncAndRender();
});

if (adminReportsList) {
  adminReportsList.addEventListener('click', async (event) => {
    const actionBtn = event.target.closest('[data-admin-action]');
    if (actionBtn) {
      const result = await api('/api/admin/report/action', {
        method: 'POST',
        body: JSON.stringify({
          profileSlug: actionBtn.dataset.adminProfile,
          reportId: actionBtn.dataset.adminReport,
          action: actionBtn.dataset.adminAction
        })
      });
      if (!result.ok) {
        adminPanelMessage.textContent = 'Nie udało się wykonać akcji administracyjnej.';
        return;
      }
      await syncAndRender();
      return;
    }

    const blockBtn = event.target.closest('[data-admin-block-account]');
    if (!blockBtn) return;
    const result = await api('/api/admin/block', {
      method: 'POST',
      body: JSON.stringify({ account: blockBtn.dataset.adminBlockAccount, blocked: blockBtn.dataset.adminBlocked === 'true' })
    });
    if (!result.ok) {
      adminPanelMessage.textContent = 'Nie udało się zmienić statusu blokady.';
      return;
    }
    await syncAndRender();
  });
}

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
  try {
    await refreshAuthConfig();
    await refreshSession();
    await refreshOwnedProfileSlug();
    await ensureLoggedInProfile();
    await refreshCurrentProfile();
    await refreshAdminReports();
    renderReasonOptions(null);
    renderAuthUi();
    renderProfile();
    readAuthErrorFromUrl();
  } finally {
    document.body.classList.remove('preboot');
  }
}

applyInitialRouteView();
boot();
