-- Faza 3: api_source z CHECK → FK do małej tabeli price_sources. Dodanie nowego źródła
-- = insert wiersza (nie edycja CHECK przy każdym providerze). kind rozróżnia dwie warstwy
-- abstrakcji z briefu: 'rotation' = provider w fetch-prices (batch+budżet), 'standalone' =
-- własna funkcja o innym limicie (fetch-crypto, fetch-metals).

create table public.price_sources (
  source       text primary key,                    -- = asset_definitions.api_source / provider.source
  display_name text not null,
  kind         text not null check (kind in ('rotation', 'standalone'))
);

alter table public.price_sources enable row level security;
create policy "Public read price_sources"
  on public.price_sources for select using (true);
create policy "Service role full access on price_sources"
  on public.price_sources for all using (auth.role() = 'service_role');

-- Wszystkie dotychczas używane źródła — muszą istnieć PRZED założeniem FK.
insert into public.price_sources (source, display_name, kind) values
  ('twelve_data', 'Twelve Data', 'rotation'),
  ('metals_dev',  'Metals.Dev',  'standalone'),
  ('coingecko',   'CoinGecko',   'standalone');

-- CHECK (z migracji Fazy 1) → FK. Istniejące api_source pokryte powyższym insertem.
alter table public.asset_definitions
  drop constraint asset_definitions_api_source_check;

alter table public.asset_definitions
  add constraint asset_definitions_api_source_fkey
  foreign key (api_source) references public.price_sources(source);
