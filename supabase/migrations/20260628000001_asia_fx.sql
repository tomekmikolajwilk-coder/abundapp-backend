-- Faza 4: włączenie giełd azjatyckich. Dokładamy waluty FX, których brakowało do przeliczenia
-- cen azjatyckich akcji na USD (price_cache trzyma wszystko w USD). EODHD ma te pary
-- ({CCY}USD.FOREX — zweryfikowane), więc fetch-eod sam zacznie je pobierać (FX-union).
-- Same giełdy (HK/KO/KQ/TW/TWO/SHG/SHE) włączane w _shared/eodhd.ts (EXCHANGE_MAP + SUPPORTED).
--
-- To NIE ma związku z Japonią/Indiami — tam brak GIEŁD w planie EODHD; tu chodziło tylko
-- o brakujące WALUTY do konwersji rynków, które EODHD ma (Chiny/HK, Korea, Tajwan).

insert into public.asset_definitions (asset_id, category, api_source, api_symbol, display_name) values
  ('HKD', 'currency', 'eodhd', 'HKDUSD.FOREX', 'Hong Kong Dollar'),
  ('KRW', 'currency', 'eodhd', 'KRWUSD.FOREX', 'South Korean Won'),
  ('TWD', 'currency', 'eodhd', 'TWDUSD.FOREX', 'Taiwan Dollar'),
  ('CNY', 'currency', 'eodhd', 'CNYUSD.FOREX', 'Chinese Yuan')
on conflict (asset_id) do nothing;
