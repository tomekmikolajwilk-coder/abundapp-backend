-- Dane syntetyczne do testów frontendu:
-- 1. Rozszerzamy holdings testowego usera o nowe assety
-- 2. Generujemy cron-snapshoty od 1 stycznia do wczoraj
--    z cenami rosnącymi liniowo w czasie (symulacja bull marketu)
--    żeby wykres PnL pokazywał sensowne zmiany

-- ── 1. Nowe holdings ──────────────────────────────────────────────────────
update public.profiles
set holdings = jsonb_build_object(
  'BTC',   0.25,
  'ETH',   2.0,
  'SOL',   15.0,
  'AAPL',  10,
  'MSFT',  5,
  'GOOGL', 3,
  'XAU',   2,
  'EUR',   500
)
where id = '4ff2377f-a833-4a05-9930-391d84d4182d';

-- ── 2. Czyścimy istniejące cron-snapshoty testowego usera ─────────────────
delete from public.portfolio_snapshots
where user_id = '4ff2377f-a833-4a05-9930-391d84d4182d'
  and source = 'cron';

-- ── 3. Generujemy snapshoty od 1 stycznia do wczoraj ─────────────────────
-- Każdy asset ma swój growth_rate — o tyle procent niższa była cena w styczniu.
-- Przykład: BTC z growth_rate=0.35 miał w jan cenę 65% obecnej.
-- Formuła: cena_historyczna = cena_obecna * (1 - growth_rate * days_ago / total_days)
with
date_series as (
  select
    d::date                                          as snap_date,
    (current_date - d::date)::float                  as days_ago,
    (current_date - '2026-01-01'::date)::float       as total_days
  from generate_series('2026-01-01'::date, current_date - 1, '1 day'::interval) d
),
pln_rate as (
  select price_usd from public.price_cache where asset_id = 'PLN'
),
holdings (asset_id, category, amount, growth_rate) as (
  values
    ('BTC',   'crypto',   0.25,  0.35::float),
    ('ETH',   'crypto',   2.0,   0.40::float),
    ('SOL',   'crypto',   15.0,  0.50::float),
    ('AAPL',  'stock',    10.0,  0.22::float),
    ('MSFT',  'stock',    5.0,   0.18::float),
    ('GOOGL', 'stock',    3.0,   0.25::float),
    ('XAU',   'metal',    2.0,   0.12::float),
    ('EUR',   'currency', 500.0, 0.05::float)
)
insert into public.portfolio_snapshots (user_id, currency, holdings_breakdown, captured_at, source)
select
  '4ff2377f-a833-4a05-9930-391d84d4182d'::uuid,
  'PLN',
  jsonb_agg(
    jsonb_build_object(
      'asset_id', h.asset_id,
      'category', h.category,
      'amount',   h.amount::float,
      'price_usd', round((cp.price_usd * (1.0 - h.growth_rate * ds.days_ago / ds.total_days))::numeric, 4),
      'value_usd', round((h.amount * cp.price_usd * (1.0 - h.growth_rate * ds.days_ago / ds.total_days))::numeric, 2),
      'value_ccy', round((h.amount * cp.price_usd * (1.0 - h.growth_rate * ds.days_ago / ds.total_days) / pln.price_usd)::numeric, 2)
    )
  ),
  (ds.snap_date + time '07:00:00') at time zone 'UTC',
  'cron'
from date_series ds
cross join pln_rate pln
cross join holdings h
join public.price_cache cp on cp.asset_id = h.asset_id
group by ds.snap_date, ds.days_ago, ds.total_days, pln.price_usd;
