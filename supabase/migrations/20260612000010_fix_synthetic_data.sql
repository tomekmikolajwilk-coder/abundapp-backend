-- Poprawka danych syntetycznych: zastępujemy liniowy wzrost cen
-- oscylacją złożoną z trendu + dwóch fal sinusoidalnych na asset.
-- Dzięki temu wykres wygląda jak prawdziwa historia notowań (góra/dół)
-- a nie prosta kreska w górę.

-- ── 1. Usuwamy stare liniowe snapshoty testowego usera ────────────────────
delete from public.portfolio_snapshots
where user_id = '4ff2377f-a833-4a05-9930-391d84d4182d'
  and source = 'cron';

-- ── 2. Generujemy na nowo od 1 stycznia do wczoraj ────────────────────────
-- Formuła ceny historycznej dla każdego dnia:
--
--   factor = trend + fala_główna + fala_szumowa
--
-- gdzie:
--   trend       = (1 - growth_rate * days_ago / total_days)
--                 → cena w przeszłości była niższa, teraz bliska aktualnej
--   fala_główna = amplitude * sin(days_ago * freq + phase)
--                 → cykl 12–30 dniowy, różny per asset
--   fala_szumowa= amplitude * 0.4 * sin(days_ago * freq * 2.3 + phase + 1.1)
--                 → krótsze oscylacje, mniejsza amplituda
--
-- Każdy asset ma inne freq i phase → wykresy nie są zsynchronizowane.
-- greatest(0.01, ...) chroni przed ujemną ceną.

with
date_series as (
  select
    d::date                                        as snap_date,
    (current_date - d::date)::float                as days_ago,
    (current_date - '2026-01-01'::date)::float     as total_days
  from generate_series('2026-01-01'::date, current_date - 1, '1 day'::interval) d
),
pln_rate as (
  select price_usd from public.price_cache where asset_id = 'PLN'
),
-- kolumny: asset_id, category, amount, growth_rate, amplitude, freq, phase
holdings (asset_id, category, amount, growth_rate, amplitude, freq, phase) as (
  values
    ('BTC',   'crypto',   0.25,  0.35::float, 0.10::float, 0.1571::float, 0.00::float),
    ('ETH',   'crypto',   2.0,   0.40::float, 0.12::float, 0.1963::float, 1.20::float),
    ('SOL',   'crypto',   15.0,  0.50::float, 0.15::float, 0.2618::float, 2.50::float),
    ('AAPL',  'stock',    10.0,  0.22::float, 0.06::float, 0.1257::float, 0.70::float),
    ('MSFT',  'stock',    5.0,   0.18::float, 0.05::float, 0.1428::float, 1.80::float),
    ('GOOGL', 'stock',    3.0,   0.25::float, 0.07::float, 0.1745::float, 3.10::float),
    ('XAU',   'metal',    2.0,   0.12::float, 0.04::float, 0.1047::float, 2.00::float),
    ('EUR',   'currency', 500.0, 0.05::float, 0.02::float, 0.2244::float, 0.50::float)
)
insert into public.portfolio_snapshots (user_id, currency, holdings_breakdown, captured_at, source)
select
  '4ff2377f-a833-4a05-9930-391d84d4182d'::uuid,
  'PLN',
  jsonb_agg(
    jsonb_build_object(
      'asset_id',  h.asset_id,
      'category',  h.category,
      'amount',    h.amount::float,
      'price_usd', round((cp.price_usd * greatest(0.01,
        (1.0 - h.growth_rate * ds.days_ago / ds.total_days)
        + h.amplitude * sin(ds.days_ago * h.freq + h.phase)
        + h.amplitude * 0.4 * sin(ds.days_ago * h.freq * 2.3 + h.phase + 1.1)
      ))::numeric, 4),
      'value_usd', round((h.amount * cp.price_usd * greatest(0.01,
        (1.0 - h.growth_rate * ds.days_ago / ds.total_days)
        + h.amplitude * sin(ds.days_ago * h.freq + h.phase)
        + h.amplitude * 0.4 * sin(ds.days_ago * h.freq * 2.3 + h.phase + 1.1)
      ))::numeric, 2),
      'value_ccy', round((h.amount * cp.price_usd * greatest(0.01,
        (1.0 - h.growth_rate * ds.days_ago / ds.total_days)
        + h.amplitude * sin(ds.days_ago * h.freq + h.phase)
        + h.amplitude * 0.4 * sin(ds.days_ago * h.freq * 2.3 + h.phase + 1.1)
      ) / pln.price_usd)::numeric, 2)
    )
  ),
  (ds.snap_date + time '07:00:00') at time zone 'UTC',
  'cron'
from date_series ds
cross join pln_rate pln
cross join holdings h
join public.price_cache cp on cp.asset_id = h.asset_id
group by ds.snap_date, ds.days_ago, ds.total_days, pln.price_usd;
