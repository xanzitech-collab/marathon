# Only1Marathon Bot Dashboard (Next.js + Supabase)

A full Next.js dashboard to manage up to 5 Instagram automation bots with:
- per-bot Xenrio key slot and Gemini key slot
- per-bot Instagram business connection state
- bot health panel showing key connectivity and connection readiness
- scheduling controls (weekday, cap, cooldown)
- media vault and queue pipelines
- publish-now API flow
- artist monitoring snapshot endpoint

## App location
- Web app: `web/`
- SQL migrations: `supabase/migrations/` (project root)

## 1) Install
```bash
cd web
npm install
```

## 2) Configure env
Copy `web/.env.example` to `web/.env.local` and fill all required values.

Critical fields for bot health status:
- `XENRIO_API_KEY_1..5`
- `GEMINI_API_KEY_1..5`

Each bot is assigned `api_slot` 1..5. The dashboard marks Xenrio/Gemini as connected if that slot key exists in env.

## 3) Apply Supabase schema
Run SQL files in this order:
1. `supabase/migrations/20260803_0001_core_schema.sql`
2. `supabase/migrations/20260803_0002_rls_and_storage.sql`
3. `supabase/migrations/20260803_0003_defaults.sql`
4. `supabase/migrations/20260803_0004_zernio_columns.sql`
5. `supabase/migrations/20260803_0005_music_catalog.sql`

## 4) Run locally
```bash
cd web
npm run dev
```
Open `http://localhost:3000`.

## 5) Routes overview
- `GET/POST /api/bots`
- `GET/PATCH/DELETE /api/bots/:id`
- `POST /api/bots/:id/connect`
- `GET/POST/DELETE /api/bots/:id/media`
- `GET/POST /api/bots/:id/queue`
- `POST /api/bots/:id/publish-now`
- `POST /api/scheduler/tick`
- `GET/POST /api/monitoring/artist`

## 6) Bot health logic
Each bot card shows:
- Xenrio key status (`Connected` or `Missing`)
- Gemini key status (`Connected` or `Missing`)
- Instagram connection status
- Overall readiness (`Active Ready` or `Needs Setup`)

Health is computed server-side in `src/lib/bot-health.ts` and returned by bot APIs.

## 7) Zernio connect flow
1. Click `Connect Instagram via Zernio` inside a bot card.
2. The app creates a Zernio profile (if missing) and redirects to OAuth.
3. Complete OAuth in browser.
4. Zernio redirects to `/api/zernio/callback`, which auto-syncs the connected account to the bot, then returns to dashboard.

Connection data persisted on bot:
- `zernio_profile_id`
- `zernio_account_id`

## 7.1) Supabase RLS note
If you saw `syntax error at or near "not"` on policy creation, use the updated migration.
Postgres does not support `create policy if not exists` in this context, so policies now use:
- `drop policy if exists ...`
- `create policy ...`

## 8) Deploy
- Frontend/API: Vercel (point to `web` as root directory)
- Database/Auth/Storage: Supabase
- CI: `.github/workflows/ci.yml`

## 9) Upload local songs to Supabase
Place files in `web/public/music`, then run:

```bash
cd web
npm run music:upload
```

Optional environment variables:
- `BOT_ID`: explicit bot id to attach songs to
- `BOT_NAME`: bot name lookup fallback (default: `Only1Marathon`)
- `MUSIC_SOURCE_DIR`: custom source folder
- `SUPABASE_MUSIC_BUCKET`: storage bucket override (default: `music`)

## 10) Audio render in publish flow
- If a song is available in `songs`, publish-now attempts an FFmpeg render step that:
	- combines selected song audio with the selected media
	- converts output to an IG-safe `mp4` (1080x1920 target)
	- uploads rendered media to `bot-media` and publishes that rendered URL
- If FFmpeg fails or is unavailable, the flow logs a warning and falls back to publishing the original media.

Install FFmpeg locally and ensure `ffmpeg` is on PATH.

## 11) Video reels pipeline
- Discovery can queue public reddit-hosted mp4 clips when `REDDIT_VIDEO_SCRAPE_ENABLED=true`.
- Video queue items are marked as `surface=reel` and analyzed at publish time:
	- FFmpeg trims long clips (over 60s) to short-form length.
	- FFmpeg extracts keyframes and audio.
	- Gemini synthesizes transcript + visuals for context-aware captioning.
	- Metadata stores context summary, hashtag set, and low-confidence review flag.
- Publish flow uploads a processed mp4 and then optionally overlays selected local song audio.

Environment flags:
- `REDDIT_VIDEO_SCRAPE_ENABLED` (default `false`)
- `VIDEO_MAX_DURATION_SECONDS` (default `30`)
- `NO_REPEAT_MEDIA_WINDOW_POSTS` (default `5`)
- `NO_REPEAT_SONG_WINDOW_POSTS` (default `4`)
- `DISCOVER_MAX_QUEUE_INSERTS` (default `5`)
- `MEME_FONT_PATH` (optional override for meme text rendering)

Focus and safety guards:
- Queue items from known wrapper hosts (for example Tenor/GIPHY/short-page wrappers) are auto-cancelled before publish.
- Queue items that do not align with the bot `content_target` are auto-cancelled before publish.
- Meme image posts are vision-checked before publish; if readable meme text is missing, the bot renders a text overlay and verifies legibility before posting.
- Publish avoids reusing the same media asset and song within the configured recent-post windows whenever alternatives exist.
- When bot `content_target` changes, existing queued/ready items that no longer align are auto-pruned (status `cancelled`).
- Discovery can scan broadly but only inserts up to `DISCOVER_MAX_QUEUE_INSERTS` items per run.

## Important compliance note
This project enforces conservative scheduling limits and does not implement bypass/evasion techniques.
