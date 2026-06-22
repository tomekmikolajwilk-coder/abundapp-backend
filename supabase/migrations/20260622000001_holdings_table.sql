-- ============================================================
-- HOLDINGS — per-user, per-pozycja (zastępuje profiles.holdings JSONB)
-- ============================================================
-- Dwie klasy pozycji (price_source):
--   market — cenę zna backend (price_cache); user podaje tylko amount.
--            category ∈ crypto/stock/etf/metal/currency, asset_id → asset_definitions.
--   manual — cenę podaje user (unit_value w walucie `currency`): nieruchomości,
--            kosztowności, obligacje, lokaty, inne. value liczone z unit_value × fx.
-- Każda pozycja ma stabilne `id` → frontend robi PATCH/DELETE po nim.

create table public.holdings (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  price_source text not null check (price_source in ('market', 'manual')),
  category     text not null check (category in (
                 'crypto', 'stock', 'etf', 'metal', 'currency',          -- market
                 'real_estate', 'valuables', 'bonds', 'deposits', 'other')), -- manual
  amount       numeric not null check (amount > 0),

  -- market
  asset_id     text references public.asset_definitions(asset_id),

  -- manual
  name             text,     -- nazwa custom assetu; null dla market
  unit_value       numeric,  -- cena za 1 jednostkę w walucie `currency`; null dla market
  currency         text,     -- kod waluty, w której wyrażony jest unit_value
  display_category text,     -- nadpisanie kategorii wyświetlania (etf→bonds, other→stock); null = jak category
  interest_rate    numeric,  -- roczna stopa %, tylko obligacje; null gdy brak
  start_date       date,     -- data początku naliczania odsetek (obligacje); null gdy brak

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- Kształt wiersza zależny od klasy: market trzyma asset_id i nic z pól manual;
  -- manual trzyma name/unit_value/currency i nie ma asset_id.
  constraint holdings_market_shape check (
    price_source <> 'market' or (
      asset_id is not null
      and name is null and unit_value is null and currency is null
      and interest_rate is null and start_date is null
    )
  ),
  constraint holdings_manual_shape check (
    price_source <> 'manual' or (
      asset_id is null
      and name is not null
      and unit_value is not null and unit_value > 0
      and currency is not null
    )
  )
);

create index holdings_user_id_idx on public.holdings (user_id);

alter table public.holdings enable row level security;

-- Edge Functions chodzą po service_role (omija RLS) i same filtrują po user_id.
-- Poniższe polityki to defense-in-depth dla bezpośredniego dostępu z JWT usera.
create policy "User can read own holdings"
  on public.holdings for select using (auth.uid() = user_id);
create policy "User can insert own holdings"
  on public.holdings for insert with check (auth.uid() = user_id);
create policy "User can update own holdings"
  on public.holdings for update using (auth.uid() = user_id);
create policy "User can delete own holdings"
  on public.holdings for delete using (auth.uid() = user_id);
create policy "Service role full access on holdings"
  on public.holdings for all using (auth.role() = 'service_role');

-- ── Migracja danych: profiles.holdings JSONB → wiersze (wszystko = market) ──
-- Bierzemy tylko assety obecne w asset_definitions (źródło kategorii); reszta i tak
-- nie miała kursu. jsonb_each_text na '{}' nie zwraca wierszy — userzy bez holdings OK.
insert into public.holdings (user_id, price_source, category, asset_id, amount)
select p.id, 'market', d.category, kv.key, (kv.value)::numeric
from public.profiles p
cross join lateral jsonb_each_text(p.holdings) as kv(key, value)
join public.asset_definitions d on d.asset_id = kv.key;

-- profiles.holdings przestaje być źródłem prawdy — usuwamy, żeby nie było drugiego stanu.
alter table public.profiles drop column holdings;
