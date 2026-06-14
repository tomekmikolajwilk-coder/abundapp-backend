-- Nowa kategoria 'etf' — ETF-y akcyjne i obligacyjne razem w jednym worku.
-- Twelve Data wycenia je identycznie jak akcje, więc api_source = 'twelve_data'.
-- Dodanie kategorii = rozszerzenie CHECK constraint + insert wierszy. Zero zmian w kodzie.

-- ── 1. Rozszerzamy dozwolone kategorie o 'etf' ────────────────────────────
alter table public.asset_definitions
  drop constraint asset_definitions_category_check;

alter table public.asset_definitions
  add constraint asset_definitions_category_check
  check (category in ('crypto', 'stock', 'metal', 'currency', 'etf'));

-- ── 2. Top 10 ETF-ów (MVP) ────────────────────────────────────────────────
-- asset_id = czysty ticker, api_symbol = format wymagany przez Twelve Data.
-- ETF-y z giełd europejskich (XETRA/LSE) wymagają sufiksu giełdy.
insert into public.asset_definitions (asset_id, category, api_source, api_symbol, display_name) values
  -- ETF-y akcyjne, giełdy US
  ('SPY',  'etf', 'twelve_data', 'SPY',         'S&P 500 ETF (SPDR)'),
  ('QQQ',  'etf', 'twelve_data', 'QQQ',         'Nasdaq 100 ETF (Invesco)'),
  ('VOO',  'etf', 'twelve_data', 'VOO',         'S&P 500 ETF (Vanguard)'),
  ('VTI',  'etf', 'twelve_data', 'VTI',         'US Total Market ETF (Vanguard)'),
  -- ETF-y akcyjne, giełdy europejskie (popularne wśród polskich inwestorów)
  ('VWCE', 'etf', 'twelve_data', 'VWCE:XETRA',  'FTSE All-World ETF (Vanguard)'),
  ('IWDA', 'etf', 'twelve_data', 'IWDA:LSE',    'MSCI World ETF (iShares)'),
  ('CSPX', 'etf', 'twelve_data', 'CSPX:LSE',    'S&P 500 ETF (iShares)'),
  -- ETF-y obligacyjne
  ('BND',  'etf', 'twelve_data', 'BND',         'US Total Bond Market ETF (Vanguard)'),
  ('TLT',  'etf', 'twelve_data', 'TLT',         'US 20+ Year Treasury ETF (iShares)'),
  ('AGGH', 'etf', 'twelve_data', 'AGGH:LSE',    'Global Aggregate Bond ETF (iShares)');
