You are a senior full-stack engineer. Build this project end-to-end in this repository with production-quality code, tests, and setup docs.

PROJECT
Only1Marathon AI Social Dashboard

STACK
- Next.js 14+ (App Router), TypeScript
- Tailwind + shadcn-style primitives
- Supabase (Auth, Postgres, Storage)
- Vercel deployment
- Optional background worker using Next.js cron endpoint first, external worker only if needed

NON-NEGOTIABLE RULES
1. Do not attempt to bypass platform protections or evade detection systems.
2. Implement compliant automation controls:
   - hard max posts/day per bot <= 3
   - cooldown between posts
   - active weekdays + local timezone windows
   - duplicate content guard
3. All API secrets must remain server-side.
4. Apply strict Supabase RLS on all user-owned tables.
5. Keep code modular and typed.

PRODUCT REQUIREMENTS
1) Auth + onboarding
- Email/password login
- Protected dashboard route

2) Bot management (max 5)
- Cards shown in dashboard
- Expand/collapse each bot for configuration
- Awake/Sleep toggle
- Connection status badge

3) Bot config fields
- bot name
- timezone, country, city, language
- persona preset dropdown
- additional persona text
- content target preset dropdown
- custom target text
- posting mode: daily / every_n_days / weekdays
- weekdays multiselect
- posting windows (time ranges)
- max_posts_per_day (must enforce <= 3)
- cooldown_minutes (default 240)

4) Connections
- Connect Instagram Business account per bot
- Show connected page/account metadata
- Status: disconnected / connected / expiring / error

5) Per-bot key assignment
- Each bot must be assigned a slot from 1..5
- Slot maps to env vars:
  - XENRIO_API_KEY_1..5
  - GEMINI_API_KEY_1..5
- Store slot number in DB, never raw API keys

6) Media vault
- Upload images/videos per bot
- Require media context caption + tags on upload
- Store in Supabase storage + metadata in DB
- Track media duration/dimensions and readiness
- Add processing pipeline stubs for transcode/trim profiles

7) Content generation
- Gemini service for captions, hashtags, CTA, idea generation
- Use bot persona + location + target + media tags as context
- Generate text ideas when media is insufficient
- Add prompt templates in reusable module

8) Scheduler and posting
- Queue table with statuses
- Scheduler tick endpoint chooses eligible posts using:
  - bot active toggle
  - weekday and window checks in bot timezone
  - daily cap check
  - cooldown check
- Publish route posts through Xenrio client
- Record attempts, errors, and final status
- Retry failed posts with exponential backoff (max 3)

9) Analytics
- Per-bot metrics cards and trend chart
- Recent posts table with engagement and delete action
- Pull analytics from provider and cache snapshots

10) Main artist monitor
- Track @only1marathon recent posts and store snapshots
- Surface content ideas derived from observed themes

API/PLATFORM CONSTRAINTS
- If selected surface requires media for publishing, do not attempt unsupported text-only publishing; reroute or block with clear UI message.
- If adding a commercial song via API is not available, log capability limitation and continue without forced song attachment.

DELIVERABLES
- Complete file tree and implementation
- SQL migrations and RLS policies
- .env.example
- README with local setup + deployment
- Basic tests for scheduler eligibility and limits

INITIAL TASK ORDER
1. Initialize Next.js app with TypeScript, Tailwind, linting
2. Add Supabase clients (server/client/middleware)
3. Implement DB schema and migration files from /supabase/migrations
4. Build auth pages + protected dashboard layout
5. Implement bots CRUD and bot accordion UI
6. Implement media vault upload and listing
7. Implement scheduler eligibility utility + API routes
8. Implement Xenrio + Gemini server clients
9. Implement analytics page and recent-post actions
10. Add tests, README, and deployment workflow

OUTPUT EXPECTATIONS
- Create all code directly in repository
- Explain assumptions briefly in README
- Keep code clean, typed, and production-friendly
