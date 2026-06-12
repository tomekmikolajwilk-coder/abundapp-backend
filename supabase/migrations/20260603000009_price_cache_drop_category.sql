-- Kolumna category w price_cache była redundantna — kategoria jest teraz w asset_definitions.
alter table public.price_cache drop column category;
