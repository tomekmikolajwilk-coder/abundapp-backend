-- TYMCZASOWE assety-pułapki do weryfikacji ścieżki alertów mailowych.
-- Każdy ma nieistniejący api_symbol → zawsze faila → wymusza maila z błędem.
--   TESTBAD   (twelve_data) → po 3 nieudanych próbach w fetch-prices leci error + mail (damaged_assets)
--   TESTMETAL (metals_dev)  → fetch-metals wysyła mail od razu przy nieudanej próbie
--
-- USUNĄĆ po weryfikacji (osobna migracja albo: update ... set active=false) — inaczej
-- generują maila codziennie (twelve_data, po nocnym resecie licznika) / co 2 dni (metals).
insert into public.asset_definitions (asset_id, category, api_source, api_symbol, display_name, active) values
  ('TESTBAD',   'stock', 'twelve_data', 'NONEXISTENT_XYZ', 'TEST — nieistniejący ticker (weryfikacja maila)', true),
  ('TESTMETAL', 'metal', 'metals_dev',  'unobtanium',      'TEST — nieistniejący metal (weryfikacja maila)', true);
