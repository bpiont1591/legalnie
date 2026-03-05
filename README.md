# legalnie

## Uruchomienie (Discord OAuth z sekretem po stronie serwera)

Aplikacja używa backendu `server.js`, który trzyma sekret Discorda w env.

1. Utwórz aplikację w Discord Developer Portal i ustaw redirect URI:
   - `http://localhost:4173/auth/discord/callback`
2. Ustaw zmienne środowiskowe:

```bash
export DISCORD_CLIENT_ID="twoj_client_id"
export DISCORD_CLIENT_SECRET="twoj_client_secret"
export SESSION_SECRET="losowy_tajny_ciag"
```

3. Uruchom:

```bash
npm start
```

4. Otwórz:
   - `http://localhost:4173`
