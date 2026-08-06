-- Generalizes bot->social-account linkage beyond Instagram-only (zernio_account_id
-- on bots) to support connecting Instagram, TikTok, and Facebook simultaneously.

create table if not exists public.bot_platform_accounts (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  platform text not null check (platform in ('instagram', 'tiktok', 'facebook')),
  zernio_account_id text not null,
  username text,
  connection_status text not null default 'connected',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bot_id, platform)
);

create index if not exists idx_bot_platform_accounts_bot_id on public.bot_platform_accounts(bot_id);

create trigger trg_bot_platform_accounts_updated_at
before update on public.bot_platform_accounts
for each row execute function set_updated_at();

alter table public.bot_platform_accounts enable row level security;

drop policy if exists bot_platform_accounts_rw_own on public.bot_platform_accounts;
create policy bot_platform_accounts_rw_own
on public.bot_platform_accounts
for all
to authenticated
using (
  exists (
    select 1 from public.bots b
    where b.id = bot_platform_accounts.bot_id
      and b.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.bots b
    where b.id = bot_platform_accounts.bot_id
      and b.user_id = auth.uid()
  )
);

-- Backfill: bots already connected to Instagram via the legacy single-account columns.
insert into public.bot_platform_accounts (bot_id, platform, zernio_account_id, username, connection_status)
select id, 'instagram', zernio_account_id, instagram_username, coalesce(connection_status::text, 'connected')
from public.bots
where zernio_account_id is not null
on conflict (bot_id, platform) do nothing;
