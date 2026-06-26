# Pricing redesign — skalowanie źródeł cen (brief do implementacji)

> Status: **zaakceptowana propozycja, do implementacji.** Powstało w sesji frontendowej, przeniesione tu.
> Czytaj razem z `docs/BACKEND.md` (§4 model aktywów, §5 API kursów, §7–8 crony).

## Problem
Obecny model = **stały katalog + rotacyjne odświeżanie wszystkiego** (`fetch-prices` co 15 min bierze 8
najstarszych `asset_definitions` gdzie `api_source='twelve_data'`). Działa dla ~25 aktywów, **nie skaluje się**
do międzynarodowej apki:
- Twelve Data free: 8 kredytów/min, **800/dobę**. Rotacja 8/run × 96 runów = 768/dobę (≈ sufit).
- Throughput stały: dodanie aktywów NIE zżera kredytów, ale **wydłuża cykl** (21 aktywów → ~40 min;
  121 aktywów → ~4 h staleness). Free tier fizycznie nie odświeży 100+ aktywów częściej niż ~co 3,5–4 h.
- Płatny tier Twelve Data **odpada na ten moment**.

## Decyzje (zaakceptowane)
1. **Crypto → osobne źródło (CoinGecko), bulk, odpięte od Twelve Data.** Cel: 100 największych krypto.
2. **Akcje/ETF → demand-driven:** katalog może mieć tysiące pozycji (tylko metadane = zero kosztu API),
   ale **pobieramy tylko te, które ktoś faktycznie trzyma** (∪ holdingów wszystkich userów).
3. **Provider abstraction** — ale świadomie dwuwarstwowa (patrz niżej): nie wciskamy wszystkich źródeł
   w jeden silnik, bo mają różnie zbudowane limity.
4. **EU akcje/ETF:** gdy znajdziemy źródło — wpina się jako kolejny provider (jeśli REST + budżet dobowy)
   albo własna funkcja (jeśli dziwny limit). Do tego czasu **fallback `price_source='manual'`** (już wspierany).
5. CoinGecko jako źródło krypto — **potwierdzone**.

## Kluczowa zasada abstrakcji (rozróżnienie warstw)
- **Warstwa modelu/księgowania = wspólna, źródło-agnostyczna:** `asset_definitions`
  (`asset_id, category, api_source, api_symbol, display_name`), zapis do `price_cache`, licznik
  `damaged_assets`, ledger. Nie obchodzi ich skąd cena.
- **Warstwa fetchera = per-źródło, NIE wspólna:** sam request + polityka limitu.
- **Wniosek:** silnik rotacji wspólny; „provider" = mały moduł deklarujący własny `batchSize` + `fetchBatch`.
  Źródło pasujące do modelu „batch na run + budżet dobowy" (Twelve Data, przyszłe EU REST) → kolejny provider
  w `fetch-prices`. Źródło o innym limicie (miesięczny jak metale, bulk jak CoinGecko, websocket) →
  **własna funkcja** (jak istniejący `fetch-metals`).

## Architektura docelowa

| Klasa | Mechanizm | Funkcja / cron |
|-------|-----------|----------------|
| Crypto (top 100) | bulk, 1 call = 100 cen — nie rotacja, nie demand-driven | nowa `fetch-crypto` (CoinGecko), `*/5 * * * *` |
| Akcje/ETF (US, +EU) | demand-driven rotacja po trzymanych, grupowana per provider | `fetch-prices` (silnik) + providery, `*/15 * * * *` |
| Metale, FX | bez zmian | `fetch-metals` `0 6 */2 * *` / `fetch-prices` |
| snapshot | bez zmian | `snapshot-portfolio` `0 7 * * *` |

## Zmiany konkretne (z odniesieniem do istniejącego kodu)

### Faza 1 — `fetch-crypto` (CoinGecko)  ← ZACZYNAMY OD TEGO
- Nowa funkcja, wzorzec 1:1 jak `supabase/functions/fetch-metals/` (osobny cron, własny limit).
- Endpoint: `GET https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1`
  → 100 cen w jednym żądaniu.
- `asset_definitions`: BTC/ETH/SOL przełączyć `api_source` z `twelve_data` na `coingecko`; dosypać do top-100.
  **`api_symbol` = coingecko `id`** (np. `bitcoin`, `ethereum`), NIE ticker — symbole krypto się dublują, `id`
  jest jednoznaczne. Mapowanie odpowiedzi: `coin.id → asset_definitions.api_symbol → asset_id → price_cache`.
- Cron co 5 min. CoinGecko free ma limit ~kilkadziesiąt/min + miesięczny — 1 call/5 min jest trywialny.
- Cron rejestrowany ręcznie w SQL Editor (jak reszta — patrz BACKEND.md §8). Dodać do `config.toml`
  (`[functions.fetch-crypto] verify_jwt = false` — jak fetch-prices/fetch-metals), `cron_logs` + alert mailowy.
- Efekt: krypto znika z budżetu Twelve Data, świeżość ~5 min.

### Faza 2 — `fetch-prices` demand-driven + multi-provider
Plik dziś: `supabase/functions/fetch-prices/{index.ts,logic.ts,logic_test.ts}`.
- `loadState` (index.ts): zamiast `asset_definitions where api_source='twelve_data'` → kandydaci =
  `DISTINCT asset_id` z **`holdings` (price_source='market')**, złączone z `asset_definitions`
  po `api_source, api_symbol`. (Później opcjonalnie ∪ watchlist.)
- Grupować kandydatów **per `api_source`**; dla każdej grupy osobny `pickAssets` (każdy provider = własny
  kursor i budżet) → `provider.fetchBatch(symbols)`.
- Interfejs (nowy `_shared/price_providers/`):
  ```ts
  interface PriceProvider {
    source: string;            // 'twelve_data' | 'eu_xxx'
    batchSize: number;         // Twelve Data = 8 (= REQUEST_SIZE)
    fetchBatch(symbols: string[]): Promise<{ rows: PriceRow[]; failed: string[]; errors: string[] }>;
  }
  ```
  Dziś rejestrujemy tylko `twelveDataProvider` = obecny `fetchTwelveData` przeniesiony do modułu.
  EU = dopisanie drugiego modułu + wpis w rejestrze.
- `pickAssets` / `applyOutcomes` / `persistDamaged` w `logic.ts` zostają **bez zmian** (czysta, otestowana
  logika; wołana per grupa). `logic_test.ts` dalej zielony.
- Providery w `_shared/price_providers/`, bo importuje je też `holdings` (Faza 2b).

### Faza 2b — on-demand fetch przy dodaniu pozycji
- `supabase/functions/holdings/index.ts`, POST market (ok. linia 69–98): dziś gdy brak ceny w `price_cache`,
  `execPriceUsd` → null i ledger leci bez wpisu (warning ~linia 98).
- Zmiana: **brak ceny → `provider.fetchBatch([api_symbol])` od razu**, zapis do `price_cache`, user widzi cenę
  natychmiast; potem asset jest trzymany → wchodzi do rotacji. Best-effort (jak reszta) — porażka nie blokuje
  utworzenia pozycji.
- Potrzebny `api_source`/`api_symbol` w zapytaniu walidującym (dziś pobiera tylko `category` — linia 72–74).

### Faza 3 — katalog skalowalny + picker → search (DOTYKA FRONTENDU)
- `asset_definitions` urośnie do tysięcy stock/ETF (tylko metadane). Dodać kolumny `exchange`, `country`
  + indeks trigramowy (pg_trgm) na `display_name`/`asset_id`.
- **`/assets` „zwróć wszystko" przestaje działać dla pickera** → nowy `/assets/search?q=&category=&exchange=`
  (paginowany). Held assety nadal pełne przez `/portfolio`. Krypto top-100 może zostać hurtem.
- `asset_definitions.api_source` CHECK → referencja do małej tabeli `price_sources` (insert wiersza = nowe
  źródło) zamiast edycji CHECK przy każdym dostawcy. Migracja: utworzyć `price_sources`, przepiąć FK.
- **To jedyna faza dotykająca frontendu** (picker = search-as-you-type). Osobny projekt z frontendem.

#### Katalog — jak go napełniamy i ROZSZERZAMY (zaimplementowane)
Zasada nadrzędna: **katalog ⊆ wyceniarne** — w `asset_definitions` ląduje tylko to, czego cenę
realnie umiemy pobrać. Nie zrzucamy całej listy TD (~17k, w tym śmieci i pozycje bez ceny na
free tierze) — seedujemy **popularne instrumenty ∩ metadane TD**, a ostateczny test ceny dzieje
się przy dodawaniu pozycji (add-time guard, niżej).

- **Seed (jednorazowo, przez generator):** `scripts/generate-catalog-seed.ts`.
  - Akcje = **S&P 500** (publiczny CSV) + `EXTRA_STOCK_TICKERS` (retail-favourites spoza indeksu).
  - ETF = `ETF_TICKERS` (curated top ~120 wg AUM).
  - Każdy ticker cross-checkowany z referencyjną listą TD (`/stocks`, `/etf`) — to **metadane,
    zero kredytów `/price`**. Do katalogu wchodzi tylko przecięcie (popularne ∩ zna-TD).
  - Wynik (2026-06): **643 wiersze** (515 akcji + 128 ETF), US (NASDAQ/NYSE/Arca/Cboe). EU poza
    zakresem — TD free tier nie wycenia XETRA/LSE (stąd VWCE/IWDA `active=false`).
- **Jak rozszerzyć w przyszłości** (pełna instrukcja w nagłówku generatora):
  - więcej akcji → `EXTRA_STOCK_TICKERS` lub kolejne źródło indeksu (Nasdaq-100, Russell 1000) w `loadPopularStocks()`;
  - więcej ETF → `ETF_TICKERS`;
  - inne giełdy → `US_EXCHANGES` (EU dopiero z providerem EU — Faza 4);
  - po zmianie: `--write` ponownie; `ON CONFLICT DO NOTHING` nie rusza istniejących wierszy.

#### Add-time guard (Faza 2b zaostrzona)
`POST /holdings` market wycenia asset **przed** insertem: cache → on-demand z providera. Gdy źródło
rotacji (twelve_data) nie zwraca kursu → **blokada `400`, pozycja nie powstaje** („brak notowań").
To realny strażnik niezmiennika „katalog ⊆ wyceniarne" — bez kosztu z góry, 1 kredyt na próbę.
Krypto/metale (własny cron, brak providera w `fetch-prices`) nie są blokowane — cache dosypie cenę.
- **TODO/rozszerzenie:** samoczyszczenie katalogu (`active=false` po potwierdzonym braku notowań) —
  wymaga odróżnienia „TD nie ma symbolu" od „chwilowy błąd sieci" (licznik porażek jak `damaged_assets`),
  żeby transient nie ubił poprawnego assetu. Świadomie zaparkowane.

### Faza 4 (gdy źródło EU) — provider EU albo manual
REST + budżet dobowy → `+1 provider` w `fetch-prices`. Dziwny limit → własna funkcja. Do tego czasu `manual`.

## Schematy istniejące (do referencji)
- `asset_definitions`: `asset_id PK, category CHECK(crypto/stock/metal/currency/etf), api_source
  CHECK(twelve_data/metals_dev), api_symbol, display_name, active`. RLS: public read, service_role write.
  → trzeba rozszerzyć `api_source` (dodać `coingecko`, docelowo `price_sources`).
- `price_cache`: `asset_id PK, price_usd numeric(20,8), updated_at`. Źródło-agnostyczne — bez zmian.
- `damaged_assets`: `asset_id PK → FK asset_definitions ON DELETE CASCADE, fail_count, last_failed_at`. Bez zmian.
- `holdings`: market ma `asset_id` + `price_source='market'`; manual ma `name/unit_value/currency`,
  `price_source='manual'`, `asset_id=null`.

## Kolejność: **Faza 1 → 2 (+2b) → 3 → 4.** Każda samodzielna i deployowalna.
Start: **Faza 1 (`fetch-crypto`)** — izolowana, zero ryzyka dla reszty, zwalnia budżet Twelve Data.

## Otwarte / do potwierdzenia w trakcie
- CoinGecko free: dokładny limit miesięczny vs cron co 5 min (8640 calli/mies.) — zweryfikować, ew. co 10 min.
- Sekret `COINGECKO_API_KEY` (demo plan ma klucz) — dodać w Supabase Edge Secrets jeśli wymagany.
- Lista top-100 krypto: statyczny seed czy auto-sync z `/coins/markets` (id + display_name)? Propozycja:
  seed na start, auto-sync później.
- Eviction `price_cache`: gdy nikt nie trzyma assetu, rotacja sama go pomija (demand-driven) — twarde
  czyszczenie stale-wierszy opcjonalne, nie krytyczne.
