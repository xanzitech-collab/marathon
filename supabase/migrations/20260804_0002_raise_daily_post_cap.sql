-- Instagram/Meta officially allows far more than 3 posts/day; raise the
-- app-enforced ceiling to 25 and apply it to existing bots.

alter table public.bots drop constraint if exists bots_max_posts_per_day_chk;
alter table public.bots add constraint bots_max_posts_per_day_chk check (max_posts_per_day between 1 and 25);
alter table public.bots alter column max_posts_per_day set default 25;

update public.bots set max_posts_per_day = 25 where max_posts_per_day < 25;
