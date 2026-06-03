-- ============================================================
-- CATEGORY W PRICE_CACHE
-- ============================================================
alter table public.price_cache
  add column category text;

-- Uzupełnij istniejące wiersze
update public.price_cache set category = 'crypto'   where asset_id in ('BTC', 'ETH', 'SOL');
update public.price_cache set category = 'stock'    where asset_id in ('AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'NVDA');
update public.price_cache set category = 'metal'    where asset_id in ('XAU', 'XAG', 'XPT', 'XPD');
update public.price_cache set category = 'currency' where asset_id in ('EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'PLN');

alter table public.price_cache
  alter column category set not null;

-- ============================================================
-- PORTFOLIO_SNAPSHOTS
-- ============================================================
create table public.portfolio_snapshots (
  id                 bigserial primary key,
  user_id            uuid not null references auth.users(id) on delete cascade,
  currency           text not null,
  holdings_breakdown jsonb not null,
  captured_at        date not null,
  unique (user_id, captured_at)
);

alter table public.portfolio_snapshots enable row level security;

create policy "User can read own snapshots"
  on public.portfolio_snapshots for select
  using (auth.uid() = user_id);

create policy "Service role full access on snapshots"
  on public.portfolio_snapshots for all
  using (auth.role() = 'service_role');
