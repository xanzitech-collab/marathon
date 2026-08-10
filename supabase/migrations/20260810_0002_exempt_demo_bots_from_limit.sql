-- Demo channels (is_demo = true) never publish or use a real API key slot,
-- so they shouldn't count against the real 5-bot-per-user limit that exists
-- specifically because there are only 5 configured API key pairs.
create or replace function public.enforce_max_5_bots_per_user()
returns trigger
language plpgsql
as $$
declare
  v_count integer;
begin
  if new.is_demo then
    return new;
  end if;

  select count(*) into v_count
  from public.bots b
  where b.user_id = new.user_id
    and not b.is_demo
    and (tg_op = 'INSERT' or b.id <> new.id);

  if v_count >= 5 then
    raise exception 'Bot limit reached: maximum 5 bots per user';
  end if;

  return new;
end;
$$;
