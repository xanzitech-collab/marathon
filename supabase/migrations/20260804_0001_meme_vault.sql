-- Local meme vault: manually curated meme images/videos catalogued for
-- selection instead of live web crawling (9gag/Kapwing are both blocked or
-- limited to blank templates when scraped live).

create table if not exists public.meme_vault_items (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  source text not null,
  media_type text not null check (media_type in ('image', 'video')),
  storage_path text not null,
  original_filename text not null,
  context_text text,
  is_posted boolean not null default false,
  posted_count integer not null default 0,
  last_posted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (category, original_filename)
);

create index if not exists idx_meme_vault_unposted on public.meme_vault_items(is_posted, media_type);
create index if not exists idx_meme_vault_category on public.meme_vault_items(category);

alter table public.meme_vault_items enable row level security;

drop policy if exists meme_vault_read_all_auth on public.meme_vault_items;
create policy meme_vault_read_all_auth
on public.meme_vault_items
for select
to authenticated
using (true);
