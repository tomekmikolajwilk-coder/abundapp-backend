-- damaged_assets — licznik nieudanych prób pobrania ceny, per asset, w obrębie doby UTC.
--
-- Po co: fetch-prices działa jak rotujący kursor — bierze 8 assetów z najstarszym
-- updated_at. Asset którego nie da się pobrać NIE dostaje świeżego updated_at, więc bez
-- tego mechanizmu zawsze byłby "najstarszy" i w nieskończoność zajmowałby sloty, blokując
-- zdrowe assety. Tutaj liczymy nieudane próby: po MAX_FAILS_PER_DAY (= 3) prób w danej dobie
-- asset wypada z kolejki do północy UTC, a my logujemy error i wysyłamy maila.
--
-- Reset jest leniwy (bez crona czyszczącego): liczy się tylko wpis z last_failed_at = dziś.
-- Jutro ten sam wiersz przestaje blokować (inna data), a pierwsza porażka startuje licznik od 1.
-- Pierwszy udany fetch kasuje wiersz całkowicie (reset po sukcesie).

create table if not exists public.damaged_assets (
  asset_id       text primary key references public.asset_definitions(asset_id) on delete cascade,
  fail_count     int not null default 0,
  last_failed_at timestamptz not null default now()
);

alter table public.damaged_assets enable row level security;

-- Tylko service_role (fetch-prices) dotyka tej tabeli — to wewnętrzny stan crona, nie dane usera.
create policy "Service role full access on damaged_assets"
  on public.damaged_assets for all using (auth.role() = 'service_role');

comment on table public.damaged_assets is
  'Licznik nieudanych prób pobrania ceny (per asset, reset dzienny UTC). Wpis kasowany po pierwszym udanym pobraniu.';
