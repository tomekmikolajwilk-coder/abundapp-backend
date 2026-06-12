-- Tabela z definicjami wszystkich obsługiwanych assetów.
-- Zastępuje hardkodowane listy w fetch-prices.
-- Frontend używa jej do wyświetlenia pickera przy dodawaniu assetów do portfela.
create table public.asset_definitions (
  asset_id     text primary key,
  category     text not null check (category in ('crypto', 'stock', 'metal', 'currency')),
  api_source   text not null check (api_source in ('twelve_data', 'metals_dev')),
  api_symbol   text not null,   -- symbol w formacie wymaganym przez dane API (np. "BTC/USD", "gold")
  display_name text not null,   -- nazwa wyświetlana userowi (np. "Bitcoin", "Gold")
  active       boolean not null default true  -- false = ukryty bez usuwania z bazy
);

alter table public.asset_definitions enable row level security;

-- Każdy może czytać — frontend potrzebuje tej listy do pickera assetów
create policy "Public read asset_definitions"
  on public.asset_definitions for select using (true);

-- Tylko service_role może dodawać/edytować assety
create policy "Service role full access on asset_definitions"
  on public.asset_definitions for all using (auth.role() = 'service_role');

-- Wszystkie aktualnie obsługiwane assety
insert into public.asset_definitions (asset_id, category, api_source, api_symbol, display_name) values
  -- Krypto (Twelve Data)
  ('BTC',   'crypto',   'twelve_data', 'BTC/USD',  'Bitcoin'),
  ('ETH',   'crypto',   'twelve_data', 'ETH/USD',  'Ethereum'),
  ('SOL',   'crypto',   'twelve_data', 'SOL/USD',  'Solana'),
  -- Akcje (Twelve Data)
  ('AAPL',  'stock',    'twelve_data', 'AAPL',     'Apple'),
  ('MSFT',  'stock',    'twelve_data', 'MSFT',     'Microsoft'),
  ('GOOGL', 'stock',    'twelve_data', 'GOOGL',    'Alphabet'),
  ('AMZN',  'stock',    'twelve_data', 'AMZN',     'Amazon'),
  ('TSLA',  'stock',    'twelve_data', 'TSLA',     'Tesla'),
  ('NVDA',  'stock',    'twelve_data', 'NVDA',     'NVIDIA'),
  -- Waluty (Twelve Data)
  ('EUR',   'currency', 'twelve_data', 'EUR/USD',  'Euro'),
  ('GBP',   'currency', 'twelve_data', 'GBP/USD',  'British Pound'),
  ('JPY',   'currency', 'twelve_data', 'JPY/USD',  'Japanese Yen'),
  ('CHF',   'currency', 'twelve_data', 'CHF/USD',  'Swiss Franc'),
  ('CAD',   'currency', 'twelve_data', 'CAD/USD',  'Canadian Dollar'),
  ('PLN',   'currency', 'twelve_data', 'PLN/USD',  'Polish Złoty'),
  -- Metale szlachetne (Metals.Dev)
  ('XAU',   'metal',    'metals_dev',  'gold',      'Gold'),
  ('XAG',   'metal',    'metals_dev',  'silver',    'Silver'),
  ('XPT',   'metal',    'metals_dev',  'platinum',  'Platinum'),
  ('XPD',   'metal',    'metals_dev',  'palladium', 'Palladium');
