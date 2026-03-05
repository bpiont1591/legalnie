# legalnie

## Uruchomienie (Discord OAuth z sekretem po stronie serwera)

Aplikacja używa backendu `server.js`, który trzyma sekret Discorda w env.

1. Utwórz aplikację w Discord Developer Portal i ustaw redirect URI:
   - `http://localhost:4173/auth/discord/callback`
   - (prod) `https://twoja-domena.pl/auth/discord/callback`

2. Ustaw zmienne środowiskowe:

```bash
export DISCORD_CLIENT_ID="twoj_client_id"
export DISCORD_CLIENT_SECRET="twoj_client_secret"
export SESSION_SECRET="losowy_tajny_ciag"
# opcjonalnie, przy reverse proxy / prod:
export BASE_URL="https://twoja-domena.pl"
```

3. Uruchom:

```bash
npm start
```

4. Otwórz:
   - `http://localhost:4173`

## Jeśli po kliknięciu „Zaloguj przez Discord” strona się psuje

Najczęstsze powody:
- brak `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` / `SESSION_SECRET`
- niezgodny redirect URI w Discord Developer Portal
- zły `BASE_URL` w środowisku produkcyjnym

Aplikacja pokaże teraz czytelny komunikat `auth_error` po powrocie na stronę.
