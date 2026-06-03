-- Przemianowujemy assets_updated → items_processed, bo tabela służy teraz kilku funkcjom
-- (fetch-prices liczy aktywa, snapshot-portfolio liczy snapszoty — jedna generyczna kolumna).
alter table public.cron_logs rename column assets_updated to items_processed;

-- Dodajemy function_name żeby w logach od razu widać było która funkcja pisała dany wiersz.
-- Istniejące wiersze (wszystkie z fetch-prices) dostają właściwą wartość.
alter table public.cron_logs add column function_name text;
update public.cron_logs set function_name = 'fetch-prices' where function_name is null;
