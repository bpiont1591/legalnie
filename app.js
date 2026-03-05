const STORAGE_KEY = 'legitcheck_profiles_v1';

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
const yearNode = document.querySelector('#year');

const ratingMeta = {
  legit: { label: 'Legit ✅' },
  sold: { label: 'Sprzedał 💼' },
  scam: { label: 'Oszukał ❌' }
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

function ensureProfile(user) {
  const profiles = loadProfiles();
  if (!profiles[user]) {
    profiles[user] = { reviews: [] };
    saveProfiles(profiles);
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
      const comment = review.comment?.trim() ? review.comment : 'Brak komentarza.';
      return `
        <li class="review">
          <div class="review-head">
            <span>${ratingMeta[review.rating].label}</span>
            <span>${date}</span>
          </div>
          <p>${comment}</p>
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

  profileSection.classList.remove('hidden');
  emptyState.classList.add('hidden');
  copyProfileLink.disabled = false;
}

createProfileForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const rawName = new FormData(createProfileForm).get('username');
  const user = slugify(String(rawName));

  if (!user) {
    createProfileMessage.textContent = 'Podaj poprawną nazwę (min. 3 znaki, bez polskich znaków).';
    return;
  }

  ensureProfile(user);
  setCurrentUser(user);
  createProfileMessage.textContent = `Gotowe! Twój profil to: ${window.location.href}`;
  renderProfile();
});

reviewForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const user = getCurrentUser();
  if (!user) return;

  const formData = new FormData(reviewForm);
  const rating = String(formData.get('rating'));
  const comment = String(formData.get('comment') || '').trim();

  const profiles = loadProfiles();
  profiles[user].reviews.push({
    rating,
    comment,
    createdAt: new Date().toISOString()
  });

  saveProfiles(profiles);
  reviewForm.reset();
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

renderProfile();

if (yearNode) {
  yearNode.textContent = new Date().getFullYear();
}
