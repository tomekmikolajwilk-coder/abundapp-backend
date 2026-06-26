-- Faza 3 pricing redesign (docs/PRICING_REDESIGN.md): katalog skalowalny + search.
-- asset_definitions urośnie do tysięcy stock/ETF (same metadane) — picker przestaje brać
-- „wszystko" z /assets, przechodzi na /assets/search (search-as-you-type). Tu strona schematu:
-- kolumny exchange/country + trigramowy search po nazwie/tickerze.

create extension if not exists pg_trgm;

alter table public.asset_definitions
  add column if not exists exchange text,   -- np. 'NASDAQ', 'NYSE', 'XETRA', 'LSE'
  add column if not exists country  text;   -- ISO np. 'US', 'DE', 'GB'

-- Indeksy trigramowe pod /assets/search — ILIKE '%q%' korzysta z gin_trgm_ops
-- (bez tego search po podłańcuchu na tysiącach wierszy = seq scan).
create index if not exists asset_definitions_display_name_trgm
  on public.asset_definitions using gin (display_name gin_trgm_ops);
create index if not exists asset_definitions_asset_id_trgm
  on public.asset_definitions using gin (asset_id gin_trgm_ops);

-- Filtr po giełdzie w search — zwykły btree.
create index if not exists asset_definitions_exchange_idx
  on public.asset_definitions (exchange);
