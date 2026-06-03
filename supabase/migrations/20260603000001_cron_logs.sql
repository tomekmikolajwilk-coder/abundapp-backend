create table public.cron_logs (
  id          bigserial primary key,
  ran_at      timestamptz not null default now(),
  success     boolean not null,
  assets_updated integer,
  error_message  text
);

-- Tylko service_role może pisać, authenticated może czytać
alter table public.cron_logs enable row level security;

create policy "Service role full access"
  on public.cron_logs for all
  using (auth.role() = 'service_role');

create policy "Authenticated can read logs"
  on public.cron_logs for select
  using (auth.role() = 'authenticated');
