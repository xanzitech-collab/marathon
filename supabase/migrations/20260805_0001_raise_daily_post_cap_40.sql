-- Raise the app-enforced daily post ceiling from 25 to 40 and apply it to
-- existing bots, same pattern as the prior 3 -> 25 raise.

alter table public.bots drop constraint if exists bots_max_posts_per_day_chk;
alter table public.bots add constraint bots_max_posts_per_day_chk check (max_posts_per_day between 1 and 40);
alter table public.bots alter column max_posts_per_day set default 40;

update public.bots set max_posts_per_day = 40 where max_posts_per_day < 40;
