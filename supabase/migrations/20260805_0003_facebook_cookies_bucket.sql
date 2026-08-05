-- Stores the Facebook auth cookies.txt file (uploaded from the dashboard)
-- so serverless functions on Vercel can read it without a local file path.
-- A single fixed object path is always upserted, so uploading a new file
-- automatically replaces/expires the previous one.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'app-secrets',
  'app-secrets',
  false,
  1048576,
  array['text/plain', 'application/octet-stream']
)
on conflict (id) do nothing;

drop policy if exists storage_app_secrets_rw on storage.objects;
create policy storage_app_secrets_rw
on storage.objects
for all
to authenticated
using (bucket_id = 'app-secrets')
with check (bucket_id = 'app-secrets');
