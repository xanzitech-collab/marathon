# Only1Marathon Bot Platform Blueprint

## 1) Scope
Build a production-ready Next.js dashboard to manage up to 5 Instagram automation agents for Only1Marathon, each with:
- independent Xenrio API key slot
- independent Gemini API key slot
- independent Instagram Business account connection
- configurable posting rules, persona, location, audience target, media vault, and scheduling
- analytics and post management

## 2) Compliance First
Do not implement evasion or bypass behavior. Implement platform-compliant automation controls:
- strict per-bot posting caps
- cooldown windows
- per-day schedules by weekday and timezone
- duplicate-content suppression
- manual pause switch
- human approval mode for high-risk posts

## 3) Core Product Requirements
- Auth: Supabase Auth (email/password), protected dashboard.
- Bot limit: exactly 5 max bots per user in v1.
- Bot card UI: collapsible/expandable with status chips.
- Connection:
  - Connect Instagram Business via Meta OAuth flow (through Xenrio where needed).
  - Show connection status: disconnected, connected, token_expiring, error.
- Bot configuration fields:
  - name, timezone, country, city, language
  - persona preset (dropdown) + additional persona text
  - content target preset (dropdown) + custom prompt text
  - post mode: daily, every_n_days, selected weekdays
  - posting windows per day (local timezone)
  - max posts/day (hard cap <= 3)
  - cooldown minutes between posts (default 240)
  - sleep/awake toggle
- Media vault per bot:
  - upload image/video
  - required media context caption + tags
  - auto transcode/trim profiles for Instagram surfaces
  - usage tracking and duplicate prevention
- Post generation:
  - uses media first when available
  - falls back to AI text ideas only for supported surfaces
  - generate caption/hashtags with Gemini
  - include CTA and artist context
- Scheduling engine:
  - creates queue items
  - enforces hard limits and cooldowns
  - randomizes time inside configured windows
- Posting pipeline:
  - queued -> validating -> publishing -> posted/failed
  - retry policy with exponential backoff (max 3)
- Analytics:
  - impressions, reach, likes, comments, shares, saves
  - per-bot chart + recent posts table
  - delete post action where API supports deletion
- Main account monitoring:
  - monitor @only1marathon recent activity and store feed snapshots
  - suggest derivative content ideas (not copy)

## 4) Important API Reality Checks
- Instagram Graph publishing generally requires media containers for feed posts.
- Attaching commercial music tracks to published Reels is restricted and often unavailable via API.
- Build graceful fallbacks:
  - if music attach is unavailable, publish without forced track attach and log reason
  - if text-only publish is unsupported on selected surface, require media or reroute to supported surface

## 5) Security and Secrets
- Never expose Xenrio or Gemini secrets to the browser.
- Use server-side route handlers for all secret-dependent actions.
- Use per-bot key slots from environment variables (slot 1..5).
- Encrypt long-lived provider tokens before DB persistence.
- Apply RLS to all user-owned tables.

## 6) Suggested App Structure
- app/(auth)/signin, signup
- app/dashboard with:
  - bot list and global stats
  - collapsible bot detail tabs: Config, Media Vault, Queue, Performance
- app/api routes:
  - /api/bots
  - /api/bots/[id]
  - /api/bots/[id]/connect
  - /api/bots/[id]/media
  - /api/bots/[id]/queue
  - /api/bots/[id]/publish-now
  - /api/scheduler/tick (cron-triggered)
  - /api/webhooks/instagram

## 7) UX Layout Direction
- Bold editorial music identity (not generic SaaS).
- Desktop + mobile responsive.
- Dashboard sections:
  - Header: artist identity, global status, quick actions
  - Stats row: total bots, active bots, queued posts, weekly engagement
  - Bot accordion cards:
    - row summary: toggle, connect badge, schedule summary, next post time
    - expanded tabs: Config, Media, Queue, Performance

## 8) Default Presets
- persona_default: afrobeats_hype_editor
- content_target_default: fan_engagement + release_promo
- max_posts_per_day_default: 2
- cooldown_minutes_default: 240
- posting_windows_default:
  - Mon-Fri: 12:00-14:00, 18:00-21:00
  - Sat-Sun: 11:00-14:00, 19:00-22:00

## 9) CI/CD
- GitHub Actions:
  - install
  - lint
  - typecheck
  - test
  - build
- Deploy web on Vercel.
- Supabase hosts Postgres/Auth/Storage.
- Optional background worker host (Render/Fly/Railway) only if heavy processing is needed.

## 10) MVP Acceptance Criteria
- User can create up to 5 bots.
- Each bot can be independently connected and configured.
- Each bot can upload media with required tags/context.
- Scheduler creates queue respecting weekday + cap + cooldown.
- Publish pipeline posts and records status.
- Dashboard shows per-bot analytics and recent posts.
- RLS prevents cross-user data access.
