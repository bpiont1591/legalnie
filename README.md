# legalnie

## Cloudflare Pages + GitHub + Discord OAuth (sekrety po stronie Cloudflare)

Ta wersja obsługuje OAuth i API przez **Cloudflare Pages Functions** (folder `functions/`),
więc sekrety są trzymane po stronie Cloudflare, a nie w frontendzie.

Routing endpointów jest rozdzielony na `functions/auth/[[path]].js` oraz `functions/api/[[path]].js`.

## 1) Discord Developer Portal

W `OAuth2` ustaw redirect URI:

- `https://legalnie.pages.dev/auth/discord/callback`

Jeśli masz własną domenę, dodaj też:
- `https://twoja-domena.pl/auth/discord/callback`

## 2) Cloudflare Pages (Project -> Settings -> Environment Variables)

Dodaj jako **Secrets**:

- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `SESSION_SECRET` (losowy, długi string)

Dodaj jako variable (opcjonalne, ale zalecane):

- `BASE_URL=https://legalnie.pages.dev`

Ustaw to dla `Production` (i opcjonalnie `Preview`).

## 3) GitHub + deploy

1. Commit i push do repo na GitHub.
2. Cloudflare Pages zaciągnie build/deploy automatycznie.
3. Po deployu sprawdź:
   - `https://legalnie.pages.dev/auth/config`

Powinno zwrócić:

```json
{"discordConfigured":true}
```

## 4) Co zrobić jeśli logowanie nadal nie działa

Najczęstsze przyczyny:
- redirect URI w Discord nie jest identyczny 1:1
- brakuje któregoś secreta w Cloudflare
- `SESSION_SECRET` jest pusty
- OAuth ustawiony tylko w Preview, a testujesz Production
- przeglądarka trzyma stary cache frontendu (zrób twarde odświeżenie: Ctrl/Cmd+Shift+R)

Aplikacja wyświetla `auth_error` po powrocie na stronę, aby łatwiej diagnozować problem.


## 5) Nowy flow aplikacji

- Strona główna służy jako landing + logowanie Discord.
- Po zalogowaniu przechodzisz do panelu zarządzania profilem.
- Publiczny profil działa pod adresem: `/u/twoj_slug`.
- Profile, opinie i zgłoszenia obsługują endpointy backendowe `/api/*` (zamiast samego localStorage).


## 6) Baza danych

- Local Node zapisuje dane do pliku: `data/profiles-db.json` (trwałe między restartami).
- Cloudflare Pages Functions obsługuje bazę przez binding `DB` (Cloudflare D1).
- Jeśli `DB` nie jest podpięte w Cloudflare, funkcje użyją pamięci procesu (tylko awaryjnie, nietrwałe).

Dla Cloudflare dodaj binding D1 o nazwie `DB` w ustawieniach projektu Pages.


## 7) Refresh / routing SPA

Dla Cloudflare Pages dodano plik `_redirects`, aby odświeżenie podstron typu `/u/:slug` działało poprawnie (fallback do `index.html`) bez psucia panelu po refreshu.
