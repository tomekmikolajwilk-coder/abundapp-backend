-- Faza 1 pricing redesign (docs/PRICING_REDESIGN.md): krypto schodzi z Twelve Data na
-- CoinGecko (bulk, osobna funkcja fetch-crypto + cron co 5 min). Tu tylko strona modelu:
-- rozszerzamy api_source o 'coingecko' i przepinamy istniejące krypto.
--
-- WAŻNE: dla krypto api_symbol = coingecko `id` (np. 'bitcoin'), NIE ticker — tickery się
-- dublują między łańcuchami, `id` jest jednoznaczne. Mapowanie w fetch-crypto:
--   coin.id (z /coins/markets) → asset_definitions.api_symbol → asset_id → price_cache.
--
-- Pełny seed top-100 to osobny krok (open question w briefie: seed vs auto-sync) — funkcja
-- działa już z poniższymi definicjami i od razu zdejmuje krypto z budżetu Twelve Data.

-- ── 1. Dozwolone źródła cen + 'coingecko' ─────────────────────────────────
alter table public.asset_definitions
  drop constraint asset_definitions_api_source_check;

alter table public.asset_definitions
  add constraint asset_definitions_api_source_check
  check (api_source in ('twelve_data', 'metals_dev', 'coingecko'));

-- ── 2. Przepięcie istniejących krypto na CoinGecko ────────────────────────
-- api_symbol zmienia się z tickera Twelve Data (np. 'BTC/USD') na coingecko id.
update public.asset_definitions set api_source = 'coingecko', api_symbol = 'bitcoin'  where asset_id = 'BTC';
update public.asset_definitions set api_source = 'coingecko', api_symbol = 'ethereum' where asset_id = 'ETH';
update public.asset_definitions set api_source = 'coingecko', api_symbol = 'solana'   where asset_id = 'SOL';
