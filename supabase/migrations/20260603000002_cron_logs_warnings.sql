alter table public.cron_logs
  add column if not exists warnings text;
