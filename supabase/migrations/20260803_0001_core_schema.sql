-- Core schema for Only1Marathon bot platform
-- Apply in Supabase SQL editor or via migration tooling.

create extension if not exists pgcrypto;

-- Enums
create type bot_connection_status as enum ('disconnected', 'connected', 'token_expiring', 'error');
create type post_surface as enum ('feed', 'reel', 'story');
create type queue_status as enum ('queued', 'validating', 'ready', 'publishing', 'posted', 'failed', 'cancelled');
create type media_type as enum ('image', 'video');
create type post_frequency_mode as enum ('daily', 'every_n_days', 'weekdays_only');

-- Generic updated_at trigger function
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Profiles: one row per auth user
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_profiles_updated_at
before update on public.profiles
for each row execute function set_updated_at();

-- Bot key slots map env key index 1..5
create table if not exists public.bot_api_slots (
  slot smallint primary key,
  is_enabled boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  check (slot between 1 and 5)
);

insert into public.bot_api_slots (slot)
values (1), (2), (3), (4), (5)
on conflict (slot) do nothing;

-- Bots
create table if not exists public.bots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  is_active boolean not null default true,

  api_slot smallint not null references public.bot_api_slots(slot),

  timezone text not null default 'Africa/Lagos',
  country text,
  city text,
  language text not null default 'en',

  persona text not null default 'afrobeats_hype_editor',
  additional_persona text,
  content_target text not null default 'fan_engagement',
  custom_target_prompt text,

  frequency_mode post_frequency_mode not null default 'daily',
  every_n_days smallint,
  weekdays smallint[] not null default '{1,2,3,4,5,6,7}',

  max_posts_per_day smallint not null default 2,
  cooldown_minutes integer not null default 240,

  connection_status bot_connection_status not null default 'disconnected',
  instagram_business_id text,
  instagram_username text,
  instagram_page_id text,

  last_posted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint bots_max_posts_per_day_chk check (max_posts_per_day between 1 and 3),
  constraint bots_cooldown_minutes_chk check (cooldown_minutes between 30 and 1440),
  constraint bots_every_n_days_chk check (every_n_days is null or every_n_days between 2 and 14),
  constraint bots_weekdays_chk check (
    coalesce(array_length(weekdays, 1), 0) >= 1
    and weekdays <@ array[1,2,3,4,5,6,7]::smallint[]
  )
);

create index if not exists idx_bots_user_id on public.bots(user_id);
create index if not exists idx_bots_active on public.bots(is_active);
create index if not exists idx_bots_connection_status on public.bots(connection_status);

create trigger trg_bots_updated_at
before update on public.bots
for each row execute function set_updated_at();

create or replace function public.enforce_max_5_bots_per_user()
returns trigger
language plpgsql
as $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.bots b
  where b.user_id = new.user_id
    and (tg_op = 'INSERT' or b.id <> new.id);

  if v_count >= 5 then
    raise exception 'Bot limit reached: maximum 5 bots per user';
  end if;

  return new;
end;
$$;

create trigger trg_bots_max_5_per_user
before insert or update on public.bots
for each row execute function public.enforce_max_5_bots_per_user();

-- Connection tokens (store encrypted token text from app layer)
create table if not exists public.instagram_connections (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  encrypted_access_token text not null,
  token_expires_at timestamptz,
  scopes text[] not null default '{}',
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bot_id)
);

create trigger trg_instagram_connections_updated_at
before update on public.instagram_connections
for each row execute function set_updated_at();

-- Posting windows (local time in bot timezone)
create table if not exists public.bot_posting_windows (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  weekday smallint not null,
  start_local time not null,
  end_local time not null,
  created_at timestamptz not null default now(),
  constraint posting_windows_weekday_chk check (weekday between 1 and 7),
  constraint posting_windows_time_chk check (start_local < end_local)
);

create index if not exists idx_posting_windows_bot_id on public.bot_posting_windows(bot_id);

-- Media vault
create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  storage_path text not null,
  public_url text,
  media_type media_type not null,
  media_context_caption text not null,
  tags text[] not null default '{}',
  duration_seconds numeric(8,2),
  width integer,
  height integer,
  file_size_bytes bigint,
  sha256 text,
  is_ready boolean not null default true,
  is_used boolean not null default false,
  usage_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_media_assets_bot_id on public.media_assets(bot_id);
create index if not exists idx_media_assets_tags on public.media_assets using gin(tags);
create unique index if not exists idx_media_assets_bot_sha256_unique
on public.media_assets(bot_id, sha256)
where sha256 is not null;

create trigger trg_media_assets_updated_at
before update on public.media_assets
for each row execute function set_updated_at();

-- Content queue
create table if not exists public.content_queue (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  media_asset_id uuid references public.media_assets(id) on delete set null,

  status queue_status not null default 'queued',
  surface post_surface not null default 'feed',

  scheduled_for timestamptz,
  published_at timestamptz,

  generated_caption text,
  hashtag_set text[] not null default '{}',
  call_to_action text,

  provider_post_id text,
  error_message text,
  retry_count smallint not null default 0,
  next_retry_at timestamptz,

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint content_queue_retry_count_chk check (retry_count between 0 and 3)
);

create index if not exists idx_content_queue_bot_id on public.content_queue(bot_id);
create index if not exists idx_content_queue_status on public.content_queue(status);
create index if not exists idx_content_queue_sched on public.content_queue(scheduled_for);

create trigger trg_content_queue_updated_at
before update on public.content_queue
for each row execute function set_updated_at();

-- Post analytics snapshots
create table if not exists public.post_analytics_snapshots (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  queue_item_id uuid references public.content_queue(id) on delete set null,
  provider_post_id text,

  captured_at timestamptz not null default now(),
  impressions integer not null default 0,
  reach integer not null default 0,
  likes integer not null default 0,
  comments integer not null default 0,
  shares integer not null default 0,
  saves integer not null default 0,
  profile_visits integer not null default 0,
  follows integer not null default 0,

  raw jsonb not null default '{}'::jsonb
);

create index if not exists idx_analytics_bot_capture on public.post_analytics_snapshots(bot_id, captured_at desc);

-- Artist account monitor snapshots
create table if not exists public.artist_monitor_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_platform text not null default 'instagram',
  source_handle text not null default 'only1marathon',
  external_post_id text not null,
  content_type text,
  caption text,
  media_url text,
  posted_at timestamptz,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (source_platform, source_handle, external_post_id)
);

-- Utility function: check post eligibility against daily cap and cooldown
create or replace function public.can_bot_post(p_bot_id uuid, p_now timestamptz default now())
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bot public.bots;
  v_count_today integer;
begin
  select * into v_bot from public.bots where id = p_bot_id;
  if not found then
    return false;
  end if;

  if v_bot.is_active is not true then
    return false;
  end if;

  select count(*) into v_count_today
  from public.content_queue q
  where q.bot_id = p_bot_id
    and q.status = 'posted'
    and q.published_at >= date_trunc('day', p_now at time zone v_bot.timezone)
    and q.published_at < date_trunc('day', p_now at time zone v_bot.timezone) + interval '1 day';

  if v_count_today >= v_bot.max_posts_per_day then
    return false;
  end if;

  if v_bot.last_posted_at is not null and v_bot.last_posted_at > p_now - make_interval(mins => v_bot.cooldown_minutes) then
    return false;
  end if;

  return true;
end;
$$;
