-- 4 europejskie ETF-y nie działają na free tierze Twelve Data (potwierdzone na żywo):
--   IWDA, CSPX → "not available with your plan" — dane giełd europejskich = plan płatny
--   VWCE, AGGH → "symbol not found" — i tak najpewniej za paywallem XETRA/LSE
-- Wyłączamy je (active=false), żeby:
--   - wypadły z kursora fetch-prices (jako null zawsze byłyby "najstarsze" i zżerałyby sloty),
--   - nie generowały codziennego maila po dobiciu limitu prób w damaged_assets.
-- Wiersze zostają w bazie — wrócą przy płatnym planie albo manualnej wycenie (custom assets).
update public.asset_definitions set active = false
where asset_id in ('VWCE', 'IWDA', 'CSPX', 'AGGH');

-- Sprzątamy wpisy licznika po nieudanych próbach — tych assetów już nie pobieramy.
delete from public.damaged_assets
where asset_id in ('VWCE', 'IWDA', 'CSPX', 'AGGH');
