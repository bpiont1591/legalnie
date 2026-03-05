const STORAGE_KEY = 'legitcheck_profiles_v1';
const DEVICE_ID_KEY = 'legitcheck_device_id_v1';
const REVIEWER_NAME_KEY = 'legitcheck_reviewer_name_v1';
const REVIEW_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const createProfileForm = document.querySelector('#createProfileForm');
const createProfileMessage = document.querySelector('#createProfileMessage');
const profileSection = document.querySelector('#profileSection');
const emptyState = document.querySelector('#emptyState');
const profileName = document.querySelector('#profileName');
const trustLevel = document.querySelector('#trustLevel');
const legitCount = document.querySelector('#legitCount');
const soldCount = document.querySelector('#soldCount');
const scamCount = document.querySelector('#scamCount');
const reviewForm = document.querySelector('#reviewForm');
const reviewsList = document.querySelector('#reviewsList');
const copyProfileLink = document.querySelector('#copyProfileLink');
const reasonSelect = document.querySelector('#reason');
const reviewerNameInput = document.querySelector('#reviewerName');
const reviewLimitMessage = document.querySelector('#reviewLimitMessage');
const submitReviewButton = document.querySelector('#submitReview');
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

function slugify(username) {
  return username.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
}

function loadProfiles() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveProfiles(profiles) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
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

function ensureDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `dev-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

function ensureProfile(user) {
  const profiles = loadProfiles();
  if (!profiles[user]) {
    profiles[user] = { owner: user, createdAt: new Date().toISOString(), reviews: [] };
    saveProfiles(profiles);
  }
}

function formatRemaining(ms) {
  const totalMin = Math.ceil(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

function getLastReviewByDevice(profile, deviceId) {
  const sameDeviceReviews = profile.reviews.filter((review) => review.reviewerDeviceId === deviceId);
  if (!sameDeviceReviews.length) return null;
  return sameDeviceReviews.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}

function updateReviewGuardState() {
  const user = getCurrentUser();
  if (!user) return;

  const profiles = loadProfiles();
  const profile = profiles[user];
  const deviceId = ensureDeviceId();
  const lastReview = getLastReviewByDevice(profile, deviceId);

  if (!lastReview) {
    submitReviewButton.disabled = false;
    reviewLimitMessage.textContent = 'Możesz teraz wystawić opinię dla tego profilu.';
    return;
  }

  const elapsed = Date.now() - new Date(lastReview.createdAt).getTime();
  const remaining = REVIEW_COOLDOWN_MS - elapsed;

  if (remaining > 0) {
    submitReviewButton.disabled = true;
    reviewLimitMessage.textContent = `Limit aktywny: kolejna opinia dla tego profilu za ${formatRemaining(remaining)}.`;
  } else {
    submitReviewButton.disabled = false;
    reviewLimitMessage.textContent = 'Limit minął — możesz ponownie wystawić opinię.';
  }
}

function computeStats(reviews) {
  return reviews.reduce(
    (acc, review) => {
      acc[review.rating] += 1;
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

function getSelectedRating() {
  return document.querySelector('input[name="rating"]:checked')?.value;
}

function renderReasonOptions(rating) {
  const options = reasonCatalog[rating] || [];
  reasonSelect.innerHTML = ['<option value="" selected disabled>Wybierz powód...</option>', ...options.map((reason) => `<option value="${reason}">${reason}</option>`)].join('');
}

function renderReviews(reviews) {
  if (!reviews.length) {
    reviewsList.innerHTML = '<li class="review">Brak opinii dla tego profilu.</li>';
    return;
  }

  reviewsList.innerHTML = reviews
    .slice()
    .reverse()
    .map((review) => {
      const date = new Date(review.createdAt).toLocaleDateString('pl-PL');
      const reason = review.reason?.trim() ? review.reason : 'Brak powodu.';
      const reviewerName = review.reviewerName || 'Anonim';
      return `
        <li class="review">
          <div class="review-head">
            <span>${ratingMeta[review.rating].label}</span>
            <span>${date}</span>
          </div>
          <p>${reason}</p>
          <small class="review-author">Opinia od: @${reviewerName}</small>
        </li>`;
    })
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
  const profiles = loadProfiles();
  const profile = profiles[user];
  const stats = computeStats(profile.reviews);

  profileName.textContent = `@${user}`;
  legitCount.textContent = stats.legit;
  soldCount.textContent = stats.sold;
  scamCount.textContent = stats.scam;
  renderTrustPill(stats);
  renderReviews(profile.reviews);
  updateReviewGuardState();

  profileSection.classList.remove('hidden');
  emptyState.classList.add('hidden');
  copyProfileLink.disabled = false;
}

createProfileForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const rawName = new FormData(createProfileForm).get('username');
  const user = slugify(String(rawName));

  if (!user || user.length < 3) {
    createProfileMessage.textContent = 'Podaj poprawną nazwę (minimum 3 znaki: litery, cyfry, _ lub -).';
    return;
  }

  const profiles = loadProfiles();
  if (profiles[user]) {
    createProfileMessage.textContent = `Ta nazwa już istnieje. Otwieram profil @${user}.`;
    setCurrentUser(user);
    renderProfile();
    return;
  }

  profiles[user] = { owner: user, createdAt: new Date().toISOString(), reviews: [] };
  saveProfiles(profiles);
  setCurrentUser(user);
  createProfileMessage.textContent = `Profil @${user} utworzony. Link: ${window.location.href}`;
  renderProfile();
});

reviewForm.addEventListener('change', (event) => {
  if (event.target.name === 'rating') {
    renderReasonOptions(getSelectedRating());
  }
});

reviewForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const user = getCurrentUser();
  if (!user) return;

  const formData = new FormData(reviewForm);
  const rating = String(formData.get('rating'));
  const reason = String(formData.get('reason') || '').trim();
  const reviewerName = slugify(String(formData.get('reviewerName') || ''));

  if (!rating || !reason || !reviewerName || reviewerName.length < 3) {
    reviewLimitMessage.textContent = 'Uzupełnij poprawnie nick opiniującego, ocenę i powód.';
    return;
  }

  const profiles = loadProfiles();
  const profile = profiles[user];
  const deviceId = ensureDeviceId();
  const lastReview = getLastReviewByDevice(profile, deviceId);

  if (lastReview) {
    const elapsed = Date.now() - new Date(lastReview.createdAt).getTime();
    const remaining = REVIEW_COOLDOWN_MS - elapsed;
    if (remaining > 0) {
      submitReviewButton.disabled = true;
      reviewLimitMessage.textContent = `Możesz dodać kolejną opinię za ${formatRemaining(remaining)}.`;
      return;
    }
  }

  profile.reviews.push({
    rating,
    reason,
    reviewerName,
    reviewerDeviceId: deviceId,
    createdAt: new Date().toISOString()
  });

  saveProfiles(profiles);
  localStorage.setItem(REVIEWER_NAME_KEY, reviewerName);
  reviewForm.reset();
  reviewerNameInput.value = reviewerName;
  renderReasonOptions(null);
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

ensureDeviceId();
const savedReviewerName = localStorage.getItem(REVIEWER_NAME_KEY);
if (savedReviewerName) reviewerNameInput.value = savedReviewerName;

renderReasonOptions(null);
renderProfile();

if (yearNode) {
  yearNode.textContent = new Date().getFullYear();
}
