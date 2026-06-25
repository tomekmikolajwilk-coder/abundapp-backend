-- ============================================================
-- TRANSACTIONS — ledger przepływów per-user (historia + PnL breakdown)
-- ============================================================
-- Jedna tabela obsługuje dwie potrzeby frontendu:
--   1. historia transakcji do wyświetlenia,
--   2. przepływy netto za okres do rozbicia PnL na „transakcje vs ruch ceny"
--      (Ruch ceny = ΔWartość − Przepływy; ΔWartość liczy front).
-- Świadomie BEZ cost-basis / realized / unrealized — tylko surowe przepływy.
--
-- value_usd jest PODPISANA: + dla buy, − dla sell. Dzięki temu suma podpisanych
-- value_* za okres = przepływ netto, a edge case'y (kup→sprzedaj→dokup) wychodzą
-- same z sumy — nie trzeba ich osobno obsługiwać.
--
-- Wpis powstaje przy mutacji holdings (POST / PATCH amount / DELETE). Rewaluacja
-- manual (PATCH unit_value) to NIE transakcja — to ruch ceny, nie przepływ.

create table public.transactions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,

  -- Link do pozycji. ON DELETE SET NULL, bo historia ma PRZEŻYĆ usunięcie holdingu
  -- (sprzedaż całości kasuje wiersz holdings, ale wpis sell musi zostać w ledgerze).
  holding_id     uuid references public.holdings(id) on delete set null,

  asset_id       text,                 -- market: symbol; null dla manual
  name           text,                 -- manual: nazwa custom assetu; null dla market
  category       text not null,
  side           text not null check (side in ('buy', 'sell')),
  amount         numeric not null check (amount > 0),   -- zawsze dodatnia
  exec_price_usd numeric not null check (exec_price_usd >= 0), -- cena 1 jednostki w USD w momencie tx
  value_usd      numeric not null,     -- PODPISANA: + buy, − sell (= ±amount × exec_price_usd)

  created_at     timestamptz not null default now()
);

-- Listowanie zawsze per-user, malejąco po created_at — indeks pod dokładnie ten odczyt.
create index transactions_user_created_idx on public.transactions (user_id, created_at desc);

alter table public.transactions enable row level security;

-- Edge Functions chodzą po service_role (omija RLS) i same filtrują po user_id.
-- Poniższe polityki to defense-in-depth dla bezpośredniego dostępu z JWT usera.
-- Tylko odczyt + service_role: wpisy do ledgera robi wyłącznie backend przy mutacji
-- holdings, więc user nie ma własnej ścieżki insertu/update/delete.
create policy "User can read own transactions"
  on public.transactions for select using (auth.uid() = user_id);
create policy "Service role full access on transactions"
  on public.transactions for all using (auth.role() = 'service_role');

-- ── Genesis seed: istniejące holdingi (sprzed ledgera) → po jednym buy ──────────
-- Bieżąca ilość po bieżącej cenie, created_at = data utworzenia holdingu.
--   market → kurs z price_cache.
--   manual → unit_value × fx waluty (USD=1; inne z price_cache).
-- Pozycje bez dającej się ustalić ceny (uszkodzony asset / brak kursu waluty)
-- pomijamy — `where px.price_usd is not null`.
insert into public.transactions
  (user_id, holding_id, asset_id, name, category, side, amount, exec_price_usd, value_usd, created_at)
select
  h.user_id, h.id, h.asset_id, h.name, h.category,
  'buy', h.amount, px.price_usd, h.amount * px.price_usd, h.created_at
from public.holdings h
cross join lateral (
  select case
    when h.price_source = 'market'
      then (select pc.price_usd from public.price_cache pc where pc.asset_id = h.asset_id)
    when h.currency = 'USD'
      then h.unit_value
    else h.unit_value * (select pc.price_usd from public.price_cache pc where pc.asset_id = h.currency)
  end as price_usd
) px
where px.price_usd is not null;
