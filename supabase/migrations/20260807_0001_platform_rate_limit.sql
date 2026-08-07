-- Tracks the platform's own posting-frequency throttle (e.g. TikTok's 429
-- "wait 1h 18m" rate limit) per bot+platform, so future publish attempts can
-- skip that platform until the window passes instead of blindly retrying and
-- burning a full Gemini/ffmpeg pipeline run just to get rate-limited again.
alter table public.bot_platform_accounts
  add column if not exists rate_limited_until timestamptz;
