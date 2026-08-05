-- Add Zernio linkage columns to bots for profile/account mapping

alter table public.bots
  add column if not exists zernio_profile_id text,
  add column if not exists zernio_account_id text;

create index if not exists idx_bots_zernio_profile_id on public.bots(zernio_profile_id);
create index if not exists idx_bots_zernio_account_id on public.bots(zernio_account_id);
