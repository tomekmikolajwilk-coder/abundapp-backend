-- Faza 4 (docs/PRICING_REDESIGN.md): cutover akcji/ETF/FX z Twelve Data na EODHD.
-- Kod TD ZOSTAJE w repo (fetch-prices + twelveDataProvider) — revert = sam flip api_source (niżej).
-- api_symbol NIE ruszamy (zostaje w formacie TD), bo EODHD wyprowadza symbol z metadanych
-- (exchange/country) — dzięki temu powrót do TD nie wymaga redeployu ani re-derivacji symboli.

-- 1. Nowe źródło ceny.
insert into public.price_sources (source, display_name, kind)
values ('eodhd', 'EODHD', 'standalone')
on conflict (source) do nothing;

-- 2. Cutover: wszystko co było na Twelve Data → EODHD. TD obsługiwał wyłącznie
--    stock/etf/currency, więc ten jeden UPDATE łapie równo te trzy klasy. Krypto (coingecko)
--    i metale (metals_dev) zostają nietknięte.
update public.asset_definitions set api_source = 'eodhd' where api_source = 'twelve_data';

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (gdyby EODHD sprawiał problemy) — odpalić ręcznie w SQL Editor.
-- Ważny w oknie próbnym, ZANIM doseedujemy EU/PL/Azję (tych TD nie wyceni):
--
--   update public.asset_definitions set api_source = 'twelve_data'
--   where api_source = 'eodhd' and category in ('stock','etf','currency');
--
-- + w pg_cron: włącz z powrotem job 'fetch-prices', wyłącz 'fetch-eod'.
-- Kod TD i api_symbol są nietknięte → revert działa od ręki, bez redeployu.
-- ─────────────────────────────────────────────────────────────────────────────
