-- RLS, policies, and storage policies

-- Enable RLS
alter table public.profiles enable row level security;
alter table public.bots enable row level security;
alter table public.instagram_connections enable row level security;
alter table public.bot_posting_windows enable row level security;
alter table public.media_assets enable row level security;
alter table public.content_queue enable row level security;
alter table public.post_analytics_snapshots enable row level security;
alter table public.artist_monitor_snapshots enable row level security;

-- Profiles policies
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
on public.profiles
for select
to authenticated
using (id = auth.uid());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own
on public.profiles
for insert
to authenticated
with check (id = auth.uid());

-- Bots policies
drop policy if exists bots_select_own on public.bots;
create policy bots_select_own
on public.bots
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists bots_insert_own on public.bots;
create policy bots_insert_own
on public.bots
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists bots_update_own on public.bots;
create policy bots_update_own
on public.bots
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists bots_delete_own on public.bots;
create policy bots_delete_own
on public.bots
for delete
to authenticated
using (user_id = auth.uid());

-- Child table helper condition uses bot ownership
-- instagram_connections
drop policy if exists ig_conn_select_own on public.instagram_connections;
create policy ig_conn_select_own
on public.instagram_connections
for select
to authenticated
using (
  exists (
    select 1 from public.bots b
    where b.id = instagram_connections.bot_id
      and b.user_id = auth.uid()
  )
);

drop policy if exists ig_conn_write_own on public.instagram_connections;
create policy ig_conn_write_own
on public.instagram_connections
for all
to authenticated
using (
  exists (
    select 1 from public.bots b
    where b.id = instagram_connections.bot_id
      and b.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.bots b
    where b.id = instagram_connections.bot_id
      and b.user_id = auth.uid()
  )
);

-- bot_posting_windows
drop policy if exists posting_windows_rw_own on public.bot_posting_windows;
create policy posting_windows_rw_own
on public.bot_posting_windows
for all
to authenticated
using (
  exists (
    select 1 from public.bots b
    where b.id = bot_posting_windows.bot_id
      and b.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.bots b
    where b.id = bot_posting_windows.bot_id
      and b.user_id = auth.uid()
  )
);

-- media_assets
drop policy if exists media_assets_rw_own on public.media_assets;
create policy media_assets_rw_own
on public.media_assets
for all
to authenticated
using (
  exists (
    select 1 from public.bots b
    where b.id = media_assets.bot_id
      and b.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.bots b
    where b.id = media_assets.bot_id
      and b.user_id = auth.uid()
  )
);

-- content_queue
drop policy if exists content_queue_rw_own on public.content_queue;
create policy content_queue_rw_own
on public.content_queue
for all
to authenticated
using (
  exists (
    select 1 from public.bots b
    where b.id = content_queue.bot_id
      and b.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.bots b
    where b.id = content_queue.bot_id
      and b.user_id = auth.uid()
  )
);

-- post_analytics_snapshots
drop policy if exists analytics_select_own on public.post_analytics_snapshots;
create policy analytics_select_own
on public.post_analytics_snapshots
for select
to authenticated
using (
  exists (
    select 1 from public.bots b
    where b.id = post_analytics_snapshots.bot_id
      and b.user_id = auth.uid()
  )
);

drop policy if exists analytics_insert_own on public.post_analytics_snapshots;
create policy analytics_insert_own
on public.post_analytics_snapshots
for insert
to authenticated
with check (
  exists (
    select 1 from public.bots b
    where b.id = post_analytics_snapshots.bot_id
      and b.user_id = auth.uid()
  )
);

drop policy if exists analytics_update_own on public.post_analytics_snapshots;
create policy analytics_update_own
on public.post_analytics_snapshots
for update
to authenticated
using (
  exists (
    select 1 from public.bots b
    where b.id = post_analytics_snapshots.bot_id
      and b.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.bots b
    where b.id = post_analytics_snapshots.bot_id
      and b.user_id = auth.uid()
  )
);

-- artist monitor is global read-only for authenticated users
drop policy if exists artist_monitor_read_all_auth on public.artist_monitor_snapshots;
create policy artist_monitor_read_all_auth
on public.artist_monitor_snapshots
for select
to authenticated
using (true);

-- Storage bucket + object policies
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'bot-media',
  'bot-media',
  false,
  524288000,
  array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime']
)
on conflict (id) do nothing;

-- Folder convention: bot-media/{user_id}/{bot_id}/...
drop policy if exists storage_read_own on storage.objects;
create policy storage_read_own
on storage.objects
for select
to authenticated
using (
  bucket_id = 'bot-media'
  and split_part(name, '/', 1) = auth.uid()::text
);

drop policy if exists storage_insert_own on storage.objects;
create policy storage_insert_own
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'bot-media'
  and split_part(name, '/', 1) = auth.uid()::text
);

drop policy if exists storage_update_own on storage.objects;
create policy storage_update_own
on storage.objects
for update
to authenticated
using (
  bucket_id = 'bot-media'
  and split_part(name, '/', 1) = auth.uid()::text
)
with check (
  bucket_id = 'bot-media'
  and split_part(name, '/', 1) = auth.uid()::text
);

drop policy if exists storage_delete_own on storage.objects;
create policy storage_delete_own
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'bot-media'
  and split_part(name, '/', 1) = auth.uid()::text
);
