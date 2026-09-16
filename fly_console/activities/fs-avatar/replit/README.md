# Walton-LoFly-v0.1 (Replit)

Battlesnake webhook for Funathon. **Deploy here first**, then register the public URL on play.battlesnake.com.

## Deploy order (recommended)

1. Open this folder as a Replit App (upload / import / paste these files).
2. Set Secrets (optional): `FS_AVATAR_NAME=Walton-LoFly-v0.1`, `FS_AVATAR_COLOR=#f0b429`, `FS_AVATAR_AUTHOR=Walton`.
3. Click **Run**, then **Publish** so the URL stays awake for tournaments.
4. Copy the public URL (e.g. `https://….replit.app`).
5. On [play.battlesnake.com/account/battlesnakes](https://play.battlesnake.com/account/battlesnakes) → create snake:
   - **Name:** `Walton-LoFly-v0.1` (must include Walton)
   - **URL:** that Replit URL
6. Hit the URL in a browser before each tournament so Replit is awake.

## Local check

```bash
python main.py
# → GET http://127.0.0.1:$PORT/
```

After policy changes in the fly-brain repo, copy `server.py` → `main.py` and `game_log.py` into this folder, then **republish** on Replit.
