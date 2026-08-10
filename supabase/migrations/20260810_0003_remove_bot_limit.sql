-- Removes the 5-bot-per-user cap entirely (previous migration only
-- exempted demo bots; this drops the limit for real bots too, so manual
-- channel creation isn't capped either).
drop trigger if exists trg_bots_max_5_per_user on public.bots;
drop function if exists public.enforce_max_5_bots_per_user();
