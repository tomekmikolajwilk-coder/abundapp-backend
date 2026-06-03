-- Zmieniamy captured_at z date na timestamptz — potrzebne do snapszotów z wizyt
-- (user może chcieć zobaczyć wartość portfela sprzed 3 godzin).

-- Najpierw usuwamy unique constraint oparty na samej dacie — już nie będzie jeden snapshot na dzień
alter table public.portfolio_snapshots
  drop constraint portfolio_snapshots_user_id_captured_at_key;

-- Zmieniamy typ kolumny — istniejące daty (np. 2026-06-03) stają się 2026-06-03T00:00:00Z
alter table public.portfolio_snapshots
  alter column captured_at type timestamptz
  using (captured_at::timestamptz);

-- Skąd pochodzi snapshot: 'cron' (codzienny job) lub 'visit' (user otworzył aplikację)
alter table public.portfolio_snapshots
  add column source text not null default 'cron';

-- Indeks do szybkiego wyszukiwania ostatniego snapshotu dla usera (używamy w /portfolio?date=)
create index idx_portfolio_snapshots_user_time
  on public.portfolio_snapshots (user_id, captured_at desc);
