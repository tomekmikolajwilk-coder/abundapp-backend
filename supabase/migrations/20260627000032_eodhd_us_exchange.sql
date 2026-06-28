-- Faza 4 fix: stare US-owe akcje/ETF (z init.sql i migracji ETF, sprzed kolumny `exchange`)
-- miały exchange=NULL → fetch-eod nie umiał ich zmapować na giełdę EODHD i pomijał (equities=0).
-- Ustawiamy exchange='US' dla eodhd stock/etf bez giełdy → bulk US je wycenia. Idempotentne.
update public.asset_definitions set exchange = 'US'
where api_source = 'eodhd' and category in ('stock','etf') and exchange is null;
