-- Seed default posting windows for newly created bots

create or replace function public.seed_default_posting_windows()
returns trigger
language plpgsql
as $$
begin
  -- Mon-Fri midday window
  insert into public.bot_posting_windows (bot_id, weekday, start_local, end_local)
  values
    (new.id, 1, '12:00', '14:00'),
    (new.id, 2, '12:00', '14:00'),
    (new.id, 3, '12:00', '14:00'),
    (new.id, 4, '12:00', '14:00'),
    (new.id, 5, '12:00', '14:00');

  -- Mon-Fri evening window
  insert into public.bot_posting_windows (bot_id, weekday, start_local, end_local)
  values
    (new.id, 1, '18:00', '21:00'),
    (new.id, 2, '18:00', '21:00'),
    (new.id, 3, '18:00', '21:00'),
    (new.id, 4, '18:00', '21:00'),
    (new.id, 5, '18:00', '21:00');

  -- Weekend midday + evening
  insert into public.bot_posting_windows (bot_id, weekday, start_local, end_local)
  values
    (new.id, 6, '11:00', '14:00'),
    (new.id, 7, '11:00', '14:00'),
    (new.id, 6, '19:00', '22:00'),
    (new.id, 7, '19:00', '22:00');

  return new;
end;
$$;

drop trigger if exists trg_seed_default_posting_windows on public.bots;

create trigger trg_seed_default_posting_windows
after insert on public.bots
for each row execute function public.seed_default_posting_windows();
