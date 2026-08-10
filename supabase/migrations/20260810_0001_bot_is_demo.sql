-- Flags bots seeded purely for UI/scale preview (not real connected
-- accounts) so they can be visibly marked as demo data in the dashboard
-- instead of ever being mistaken for genuine connected channels.
alter table public.bots
  add column if not exists is_demo boolean not null default false;
