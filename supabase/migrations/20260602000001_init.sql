-- ============================================================
-- PROFILES
-- ============================================================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  preferred_currency text not null default 'USD',
  holdings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Auto-tworzenie profilu gdy nowy user się rejestruje
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id)
  values (new.id);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- RLS
alter table public.profiles enable row level security;

create policy "User can read own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "User can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- ============================================================
-- PRICE CACHE
-- ============================================================
create table public.price_cache (
  asset_id text primary key,       -- np. BTC, AAPL, XAU, EUR
  price_usd numeric(20, 8) not null,
  updated_at timestamptz not null default now()
);

-- Price cache jest publiczny do odczytu (kursy nie są sekretem)
alter table public.price_cache enable row level security;

create policy "Anyone can read price cache"
  on public.price_cache for select
  using (true);

-- Tylko service role może zapisywać (Edge Function fetchPrices)
create policy "Service role can upsert price cache"
  on public.price_cache for all
  using (auth.role() = 'service_role');

-- ============================================================
-- TESTOWY PROFIL
-- ============================================================
insert into public.profiles (id, preferred_currency, holdings)
values (
  '4ff2377f-a833-4a05-9930-391d84d4182d',
  'PLN',
  '{
    "BTC":  0.25,
    "AAPL": 10,
    "XAU":  2,
    "EUR":  500
  }'::jsonb
)
on conflict (id) do nothing;
