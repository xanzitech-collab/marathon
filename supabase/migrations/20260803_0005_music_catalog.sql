-- Song catalog for audio selection and pre-render pipeline

create table if not exists public.songs (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  title text not null,
  artist text,
  mood text default 'neutral',
  tags text[] not null default '{}',
  storage_path text not null,
  duration_seconds numeric,
  weight numeric not null default 1,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint songs_weight_chk check (weight > 0)
);

create index if not exists idx_songs_bot_id on public.songs(bot_id);
create index if not exists idx_songs_mood on public.songs(mood);
create index if not exists idx_songs_tags on public.songs using gin(tags);
create unique index if not exists idx_songs_bot_storage_unique on public.songs(bot_id, storage_path);

create trigger trg_songs_updated_at
before update on public.songs
for each row execute function public.set_updated_at();

alter table public.songs enable row level security;

drop policy if exists songs_rw_own on public.songs;
create policy songs_rw_own
on public.songs
for all
to authenticated
using (
  exists (
    select 1 from public.bots b
    where b.id = songs.bot_id
      and b.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.bots b
    where b.id = songs.bot_id
      and b.user_id = auth.uid()
  )
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'music',
  'music',
  false,
  524288000,
  array['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/mp4']
)
on conflict (id) do nothing;

drop policy if exists storage_music_read_own on storage.objects;
create policy storage_music_read_own
on storage.objects
for select
to authenticated
using (
  bucket_id = 'music'
  and exists (
    select 1 from public.bots b
    where b.id::text = split_part(name, '/', 1)
      and b.user_id = auth.uid()
  )
);

drop policy if exists storage_music_insert_own on storage.objects;
create policy storage_music_insert_own
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'music'
  and exists (
    select 1 from public.bots b
    where b.id::text = split_part(name, '/', 1)
      and b.user_id = auth.uid()
  )
);

drop policy if exists storage_music_update_own on storage.objects;
create policy storage_music_update_own
on storage.objects
for update
to authenticated
using (
  bucket_id = 'music'
  and exists (
    select 1 from public.bots b
    where b.id::text = split_part(name, '/', 1)
      and b.user_id = auth.uid()
  )
)
with check (
  bucket_id = 'music'
  and exists (
    select 1 from public.bots b
    where b.id::text = split_part(name, '/', 1)
      and b.user_id = auth.uid()
  )
);

drop policy if exists storage_music_delete_own on storage.objects;
create policy storage_music_delete_own
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'music'
  and exists (
    select 1 from public.bots b
    where b.id::text = split_part(name, '/', 1)
      and b.user_id = auth.uid()
  )
);
