# abundapp — dokumentacja backendu

> Prywatny inteligentny portfel cyfrowy (Mac + Android) — śledzenie całego majątku
> w jednym miejscu: gotówka, akcje, ETF-y, złoto, krypto. Automatyczne pobieranie
> kursów i prezentacja struktury portfela.

Ten dokument jest **źródłem prawdy** o backendzie. Aktualizuj go przy każdej zmianie
endpointów, tabel, cronów lub workflow.

---

## Spis treści
1. [Stack i infrastruktura](#1-stack-i-infrastruktura)
2. [Workflow / CI-CD](#2-workflow--cicd)
3. [Model danych — tabele](#3-model-danych--tabele)
4. [Model aktywów (dwie osie)](#4-model-aktywów-dwie-osie)
5. [Zewnętrzne API kursów](#5-zewnętrzne-api-kursów)
6. [Edge Functions — endpointy publiczne](#6-edge-functions--endpointy-publiczne)
7. [Edge Functions — joby cron](#7-edge-functions--joby-cron)
8. [Harmonogram pg_cron](#8-harmonogram-pg_cron)
9. [Kod współdzielony (`_shared`)](#9-kod-współdzielony-_shared)
10. [Kody błędów](#10-kody-błędów)
11. [Auth — stan i plan](#11-auth--stan-i-plan)
12. [Testowy user](#12-testowy-user)
13. [Koszty — płatne API, biblioteki i plany](#13-koszty--płatne-api-biblioteki-i-plany)

---

## 1. Stack i infrastruktura

| Warstwa | Technologia |
|---------|-------------|
| Baza danych + auth + hosting | **Supabase** (PostgreSQL, Auth, Edge Functions) |
| Edge Functions | **Deno / TypeScript** |
| Harmonogram | **pg_cron** (konfigurowany ręcznie w SQL Editor) |
| Frontend (osobne repo) | **Flutter** + `supabase_flutter` |
| CI/CD | **GitHub Actions** → push do `main` → deploy + smoke-test |

- **Brak własnego serwera** — całość na Supabase, zero infrastruktury do utrzymania.
- **Repo:** `git@github.com:tomekmikolajwilk-coder/abundapp-backend.git`
- **Supabase project ID:** `mrcjjyaljautuylpsssp`
- **Base URL:** `https://mrcjjyaljautuylpsssp.supabase.co`
- **Endpointy:** `https://mrcjjyaljautuylpsssp.supabase.co/functions/v1/<nazwa>`

### Sekrety
Trzymane **wyłącznie** w Supabase Secrets (Edge Functions) i GitHub Secrets (CI) —
nigdy w repo:

| Klucz | Do czego |
|-------|----------|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | klient z pełnym dostępem (omija RLS) |
| `EODHD_API_KEY` | kursy akcji / ETF / FX (US + EU/PL/Azja) — źródło docelowe (Faza 4) |
| `TWELVE_DATA_API_KEY` | akcje / ETF / forex — **uśpione** po cutoverze na EODHD; kod zostaje pod revert |
| `METALS_DEV_API_KEY` | kursy metali |
| `RESEND_API_KEY`, `ALERT_EMAIL` | alerty mailowe przy awariach cronów |

---

## 2. Workflow / CI-CD

Push do `main` uruchamia GitHub Actions (`.github/workflows/deploy.yml`) w trzech etapach:

```
push → [unit-test] → [deploy] → [smoke-test]
```

1. **`unit-test`** — `deno test supabase/functions/fetch-prices/`
   Czysta logika kursora i licznika awarii (`logic.ts` + `logic_test.ts`).
   Bramka: jeśli testy padną, deploy się nie odpala.
2. **`deploy`** — `supabase link` → `supabase db push` (migracje) →
   `supabase functions deploy --no-verify-jwt` (wszystkie funkcje naraz;
   katalog `_shared/` z prefiksem `_` jest pomijany przez CLI).
3. **`smoke-test`** — odpala funkcję `smoke-test`, która curlem przechodzi po
   wszystkich endpointach i sprawdza statusy/kształty odpowiedzi. HTTP ≠ 200 = czerwony build.

**Migracje** leżą w `supabase/migrations/` (nazwa = `YYYYMMDDHHMMSS_opis.sql`)
i są aplikowane przez `supabase db push` przy deployu.

---

## 3. Model danych — tabele

### `profiles`
Profil usera. Tworzony automatycznie triggerem przy rejestracji.

| Kolumna | Typ | Opis |
|---------|-----|------|
| `id` | uuid PK | FK → `auth.users(id)`, cascade |
| `preferred_currency` | text | domyślnie `'USD'` |
| `created_at` / `updated_at` | timestamptz | |

- Trigger `on_auth_user_created` → `handle_new_user()` auto-wstawia profil.
- RLS: user czyta/edytuje tylko własny profil (`auth.uid() = id`).
- Kolumna `holdings` (JSONB) **usunięta** (migracja 20260622) — pozycje portfela mieszkają
  teraz w osobnej tabeli `holdings` (niżej), bo potrzebują stabilnego `id` i pól dla aktywów manualnych.

### `holdings`
Pozycje portfela usera — jedna pozycja = jeden wiersz ze stabilnym `id` (do PATCH/DELETE).
Dwie klasy wg `price_source`:

| Kolumna | Typ | Opis |
|---------|-----|------|
| `id` | uuid PK | `gen_random_uuid()` |
| `user_id` | uuid | FK → `auth.users(id)`, cascade |
| `price_source` | text | `market` \| `manual` (CHECK) |
| `category` | text | market: `crypto`/`stock`/`etf`/`metal`/`currency`; manual: `real_estate`/`valuables`/`bonds`/`deposits`/`other` (CHECK) |
| `amount` | numeric | ilość; `> 0` (CHECK) |
| `asset_id` | text | market: FK → `asset_definitions`; **null** dla manual |
| `name` | text | manual: nazwa custom assetu; null dla market |
| `unit_value` | numeric | manual: cena za 1 jednostkę w walucie `currency`; null dla market |
| `currency` | text | manual: kod waluty `unit_value` (np. `PLN`, `USD`) |
| `display_category` | text | nadpisanie kategorii wyświetlania (np. ETF→`bonds`); null = jak `category` |
| `interest_rate` | numeric | roczna stopa % (tylko obligacje); null gdy brak |
| `start_date` | date | początek naliczania odsetek (obligacje); null gdy brak |
| `created_at` / `updated_at` | timestamptz | |

- **CHECK kształtu:** `market` ⇒ `asset_id` ustawiony, pola manual null; `manual` ⇒ `name`+`unit_value`+`currency` ustawione, `asset_id` null.
- **`market`** — cenę zna backend; `value_usd = amount × price_cache[asset_id]`.
- **`manual`** — cenę podaje user; `value_ccy = amount × unit_value` (w `currency`), `value_usd` po przeliczeniu FX z `price_cache`.
- **Obligacje (`bonds`)** — wartość naliczana **liniowo, on-read**: `value = principal × (1 + interest_rate/100 × dni_od_start_date/365)`, `principal = amount × unit_value`. Liczone od zera z liczby dni → idempotentne (pominięty/podwójny cron bez znaczenia, **nic nie inkrementujemy**).
- RLS: user CRUD-uje tylko własne wiersze (`auth.uid() = user_id`); service_role pełny dostęp.

### `transactions`
Ledger przepływów per-user — historia transakcji **oraz** baza do rozbicia PnL na „transakcje
vs ruch ceny". Świadomie **bez** cost-basis / realized / unrealized — tylko surowe przepływy.
Wpis powstaje przy mutacji `holdings`; backend jest jedynym autorem (user ma tylko odczyt).

| Kolumna | Typ | Opis |
|---------|-----|------|
| `id` | uuid PK | `gen_random_uuid()` |
| `user_id` | uuid | FK → `auth.users(id)`, cascade |
| `holding_id` | uuid | FK → `holdings(id)` **ON DELETE SET NULL** (historia przeżywa usunięcie pozycji) |
| `asset_id` | text | market: symbol; null dla manual |
| `name` | text | manual: nazwa custom assetu; null dla market |
| `category` | text | |
| `side` | text | `buy` \| `sell` (CHECK) |
| `amount` | numeric | ilość, zawsze `> 0` (CHECK) |
| `exec_price_usd` | numeric | cena 1 jednostki w USD w momencie tx (`>= 0`) |
| `value_usd` | numeric | **PODPISANA**: `+` buy, `−` sell (`= ±amount × exec_price_usd`) |
| `created_at` | timestamptz | |

- **Kiedy zapis:** `POST /holdings` → buy całości; `PATCH amount` → delta (dodatnia=buy, ujemna=sell) po bieżącej cenie; `DELETE` → sell całości. **`PATCH unit_value` (rewaluacja manual) NIE zapisuje** — to ruch ceny, nie przepływ.
- **Cena wykonania:** market = kurs z `price_cache`; manual = `unit_value × fx` (USD=1). Brak kursu → wpis pomijany (best-effort, nie wywraca mutacji holdings).
- **Edge case'y** (kup→sprzedaj→dokup) wychodzą same z sumy podpisanych `value_usd` — nie ma osobnej logiki.
- **Genesis seed** (migracja): istniejące holdingi → po jednym `buy` (bieżąca ilość × bieżąca cena, `created_at` = data utworzenia pozycji).
- RLS: user **tylko odczyt** własnych wierszy; service_role pełny dostęp.

### `asset_definitions`
Katalog wszystkich obsługiwanych aktywów — **źródło prawdy** dla `category`,
`display_name` i sposobu wyceny.

| Kolumna | Typ | Opis |
|---------|-----|------|
| `asset_id` | text PK | czysty ticker, np. `BTC`, `SPY`, `XAU` |
| `category` | text | `crypto` \| `stock` \| `metal` \| `currency` \| `etf` (CHECK) |
| `api_source` | text | **FK → `price_sources(source)`** (`twelve_data`/`metals_dev`/`coingecko`) |
| `api_symbol` | text | symbol w formacie danego API (np. `bitcoin`, `gold`, `VWCE:XETRA`) |
| `display_name` | text | nazwa dla usera (np. `Bitcoin`) |
| `exchange` | text | giełda (`NASDAQ`/`XETRA`/…); filtr w `/assets/search`; null dla krypto/metali/FX |
| `country` | text | ISO kraju (`US`/`DE`/…); null gdzie nie dotyczy |
| `active` | boolean | `false` = ukryty bez usuwania (wypada z fetchy i pickerów) |

- RLS: publiczny odczyt (frontend potrzebuje do pickera), zapis tylko service_role.
- **Niezmiennik:** katalog ⊆ wyceniarne — każdy wiersz ma `(api_source, api_symbol)`, które
  jakiś provider potrafi pobrać. Stock/ETF seedowane z listy Twelve Data (= jej pokrycie cen).
- Trigramowe indeksy (pg_trgm) na `display_name`/`asset_id` pod `/assets/search`.

### `price_sources`
Słownik źródeł cen — FK z `asset_definitions.api_source`. Dodanie źródła = insert wiersza
(zamiast edycji CHECK przy każdym providerze).

| Kolumna | Typ | Opis |
|---------|-----|------|
| `source` | text PK | = `asset_definitions.api_source` / `provider.source` |
| `display_name` | text | nazwa źródła (np. `Twelve Data`) |
| `kind` | text | `rotation` (provider w fetch-prices) \| `standalone` (własna funkcja) — CHECK |

### `price_cache`
Ostatni znany kurs każdego aktywa (w USD).

| Kolumna | Typ | Opis |
|---------|-----|------|
| `asset_id` | text PK | |
| `price_usd` | numeric(20,8) | kurs w USD |
| `updated_at` | timestamptz | znacznik użyty przez kursor fetch-prices |

- RLS: publiczny odczyt (kursy nie są sekretem), zapis tylko service_role.
- `category` była tu kiedyś — usunięta (migracja 009), kategoria mieszka w `asset_definitions`.

### `portfolio_snapshots`
Zapisy stanu portfela w czasie. Dwa rodzaje wg `source`:

| Kolumna | Typ | Opis |
|---------|-----|------|
| `id` | bigserial PK | |
| `user_id` | uuid | FK → `auth.users(id)`, cascade |
| `currency` | text | waluta preferowana usera w chwili snapshotu |
| `holdings_breakdown` | jsonb | tablica pozycji (patrz kształt `HoldingEntry` niżej) |
| `captured_at` | timestamptz | moment zapisu |
| `source` | text | `'cron'` lub `'visit'` |

- **`source='cron'`** — dzienny snapshot dla wszystkich userów (stabilny, używany
  przez `/portfolio?date=` i `/value-history`). Godzina ustalona przez cron (7:00 UTC).
- **`source='visit'`** — snapshot z ostatniej wizyty usera. **Dokładnie jeden na usera** —
  częściowy unique index `(user_id) where source='visit'`. Zapisywany w tle przy każdym
  wywołaniu `/portfolio` (live).
- Indeks `(user_id, captured_at desc)` do szybkiego szukania ostatniego snapshotu.

### `cron_logs`
Audyt wszystkich jobów cron — jeden wiersz na wywołanie.

| Kolumna | Typ | Opis |
|---------|-----|------|
| `id` | bigserial PK | |
| `ran_at` | timestamptz | domyślnie `now()` |
| `function_name` | text | która funkcja pisała wiersz |
| `success` | boolean | |
| `items_processed` | integer | liczba przetworzonych elementów (kursów / snapszotów) |
| `error_message` | text | komunikat błędu (jeśli był) |
| `warnings` | text | ostrzeżenia niefatalne (np. pojedyncze nieudane assety) |

- RLS: zapis service_role, odczyt authenticated.
- **Po co:** szybki wgląd „czy crony chodzą i co poszło nie tak" bez czytania logów Edge.
  Przy fetch-prices co 15 min rośnie ~100 wierszy/dobę (czyszczenie starych — zaparkowane).

### `damaged_assets`
Licznik nieudanych prób pobrania ceny, per asset, w obrębie doby UTC.

| Kolumna | Typ | Opis |
|---------|-----|------|
| `asset_id` | text PK | FK → `asset_definitions(asset_id)`, cascade |
| `fail_count` | int | liczba nieudanych prób w bieżącej dobie |
| `last_failed_at` | timestamptz | znacznik ostatniej porażki |

- **Po co:** fetch-prices to rotujący kursor (bierze najstarsze `updated_at`). Asset,
  którego nie da się pobrać, nie dostaje świeżego `updated_at`, więc bez tego mechanizmu
  byłby wiecznie „najstarszy" i blokowałby sloty. Tu liczymy porażki: po **3 próbach/dobę**
  asset wypada z kolejki do północy UTC + leci log error i mail.
- **Reset leniwy:** liczy się tylko wpis z `last_failed_at = dziś`. Jutro ten sam wiersz
  przestaje blokować (inna data), pierwsza porażka startuje licznik od 1.
- **Reset po sukcesie:** pierwszy udany fetch kasuje wiersz całkowicie.

### Kształt `HoldingEntry` (w `holdings_breakdown` i odpowiedziach)
```json
{
  "id": "8f3c…",
  "asset_id": "BTC",
  "category": "crypto",
  "amount": 0.25,
  "price_usd": 66928,
  "value_usd": 16732,
  "value_ccy": 61125.93,
  "value_selected": 14418.42,
  "price_source": "market",
  "name": null,
  "display_category": null,
  "interest_rate": null,
  "unit_value": null,
  "unit_currency": null
}
```
- `value_usd` = `amount × price_usd` (niezmiennik trzyma się też dla manual — `price_usd` to wtedy efektywna cena jednostki w USD, z odsetkami dla obligacji)
- `value_ccy` = wartość w `preferred_currency` usera
- `value_selected` = wartość w `?currency=X` (pojawia się tylko gdy podano parametr)
- `id` = id wiersza `holdings` (do PATCH/DELETE)
- `price_source` = `market` \| `manual`; `name` = nazwa custom assetu (manual) / null (market);
  `display_category` = nadpisanie kategorii lub null; `interest_rate` = stopa obligacji lub null
- **`unit_value` + `unit_currency`** (tylko manual; null dla market) = natywna wycena pozycji:
  cena jednostki i jej waluta — **dokładnie to, co user podał w `POST custom.unit_value`/`currency`**.
  Front czyta to, by edytować `unit_value` we właściwej walucie. Dla obligacji `unit_value` jest
  **bazowe** (bez naliczonych odsetek — to wartość do edycji); odsetki widać w `value_ccy`/`value_usd`.
- **Wstecznie:** stare snapshoty (sprzed migracji) nie mają tych pól — frontend czyta je z domyślnymi (`price_source`→`market`, reszta null).

---

## 4. Model aktywów (dwie osie)

Aktywo opisują **dwie niezależne osie** — nie sklejać ich:

- **`category`** = CO to jest (`crypto`, `stock`, `metal`, `currency`, `etf`)
- **`api_source`** = JAK wyceniamy — FK do `price_sources` (`twelve_data`, `metals_dev`, `coingecko`; przyszłe EU = insert wiersza)

Przykład: REIT = `category 'real_estate'` + `api_source 'twelve_data'`; fizyczne mieszkanie =
`category 'real_estate'` + `api_source null`. Ta sama klasa aktywa, inny sposób wyceny.

Po stronie **pozycji portfela** ta druga oś jest już zrealizowana przez `holdings.price_source`
(`market` = wycena z `price_cache`, `manual` = `unit_value` od usera). `asset_definitions` to
katalog assetów `market`; pozycje `manual` (nieruchomości, obligacje, lokaty…) nie mają tam wpisu —
niosą własną nazwę i cenę w wierszu `holdings`.

### Aktualny katalog (`asset_definitions`)
| Kategoria | Aktywne | Uwagi |
|-----------|---------|-------|
| crypto | BTC, ETH, SOL | **CoinGecko** (`fetch-crypto`, api_symbol = coingecko id) |
| stock | AAPL, MSFT, GOOGL, AMZN, TSLA, NVDA | Twelve Data |
| currency | EUR, GBP, JPY, CHF, CAD, PLN | Twelve Data (kurs `X/USD`) |
| metal | XAU, XAG, XPT, XPD | Metals.Dev |
| etf | SPY, QQQ, VOO, VTI, BND, TLT | Twelve Data (giełdy US, free tier) |
| etf (wyłączone) | VWCE, IWDA, CSPX, AGGH | `active=false` — giełdy EU (XETRA/LSE) niedostępne na free tierze |

---

## 5. Zewnętrzne API kursów

| API | Limit (free) | Pokrycie | Cron |
|-----|--------------|----------|------|
| **Twelve Data** | 8 credits/min, 800/dobę | krypto, akcje, ETF-y (US), forex | co 15 min |
| **Metals.Dev** | **100 req/miesiąc** | metale (XAU, XAG, XPT, XPD) | co 2 dni |

- Endpoint Twelve Data: `GET /price?symbol=A,B,C&apikey=…` (do 8 symboli po przecinku).
- Endpoint Metals.Dev: `GET /v1/metal/spot?metal=gold&currency=USD&api_key=…` (per metal).
- **Uwaga:** Metals.Dev z limitem 100/mies. NIE może jechać w 15-min rotacji — stąd osobny
  wolny cron i osobna funkcja `fetch-metals`.

---

## 6. Edge Functions — endpointy publiczne

Base: `https://mrcjjyaljautuylpsssp.supabase.co/functions/v1`
Auth: **wymagany JWT** (Bearer zalogowanego usera) — `user_id` brany **wyłącznie** z claim
`sub`. Query param `?user_id=` **nie istnieje** — nie da się odpytać o cudze dane (patrz §11).

### `GET /assets`
Wszystkie aktywne aktywa z aktualnym kursem, pogrupowane po kategorii.
```json
{
  "crypto":   [{ "asset_id": "BTC",  "display_name": "Bitcoin", "price_usd": 66928,  "category": "crypto",   "updated_at": "..." }],
  "stock":    [{ "asset_id": "AAPL", "display_name": "Apple",   "price_usd": 316.29, "category": "stock",    "updated_at": "..." }],
  "metal":    [{ "asset_id": "XAU",  "display_name": "Gold",    "price_usd": 4448.4, "category": "metal",    "updated_at": "..." }],
  "currency": [{ "asset_id": "PLN",  "display_name": "...",     "price_usd": 0.2737, "category": "currency", "updated_at": "..." }]
}
```
Hurtem ma sens dla małych zbiorów (krypto, waluty, metale). Dla tysięcy stock/ETF picker
używa `/assets/search` — `/assets` ich nie zwraca w całości (zwraca tylko to, co ma kurs w cache).

### `GET /assets/search`
Paginowany search po katalogu (picker search-as-you-type, Faza 3). Routuje do tej samej
funkcji co `/assets`.
- Parametry: `q` (podłańcuch nazwy/tickera, ≥2 znaki), `category`, `exchange`, `limit` (≤50, dom. 20), `offset`.
- Wymaga **`q` lub `category`** (inaczej 400 — bez tego zwracałby cały katalog).
- `q` → trigramowy ILIKE po `display_name` i `asset_id` (indeksy pg_trgm).
```json
{
  "results": [{ "asset_id": "AAPL", "category": "stock", "display_name": "Apple Inc", "exchange": "NASDAQ", "country": "US" }],
  "limit": 20, "offset": 0, "has_more": false
}
```
- `has_more` liczone trickiem limit+1 (bez `COUNT(*)` po całym katalogu).
- Zwraca **metadane** (bez kursu) — held assety z kursem idą przez `/portfolio`.

### `GET /assets/discover?q=` — request-asset (samorozszerzanie katalogu)
Katalog trzymamy **mały (popularne)** → szybki search. Gdy user nie znajduje tickera w `/search`,
front woła `/discover` — szuka w **EODHD** tego, czego nie mamy. Routuje do funkcji `assets`.
- Filtruje do **obsługiwanych giełd** (mamy FX) + typów **Common Stock / ETF** (odcina FUND, Warrant…).
- Każdy kandydat ma `in_catalog` (czy już go mamy).
```json
{ "query": "bogdanka", "results": [
  { "asset_id": "LWB.WAR", "code": "LWB", "exchange": "WAR", "display_name": "Lubelski Wegiel Bogdanka S.A.", "category": "stock", "currency": "PLN", "in_catalog": false }
]}
```
- `asset_id`: US = bare (`AAPL`), nie-US = `CODE.EXCHANGE` (bo ten sam Code bywa różną spółką na różnych giełdach).

### `POST /assets/request` `{ code, exchange }` — dodaj ticker do katalogu
Dodaje wybranego kandydata z `/discover` do `asset_definitions` (`api_source='eodhd'`). Idempotentne
(jest już → zwraca istniejący). Weryfikuje w EODHD (Code+Exchange, typ stock/etf) — **jest w EODHD
→ dodajemy; nie ma → 404**. Po dodaniu ticker jest w katalogu → user może go dodać do portfela.

### `GET /portfolio`
Live portfolio — liczone na bieżąco z `holdings × price_cache`.
Każde wywołanie zapisuje synchronicznie visit-snapshot (jeden wiersz na usera).
```json
{
  "currency": "PLN",
  "holdings_breakdown": [
    { "asset_id": "BTC", "category": "crypto", "amount": 0.25, "price_usd": 66928, "value_usd": 16732, "value_ccy": 61125.93 }
  ]
}
```
Parametry opcjonalne:
- **`&currency=EUR`** — dodaje `value_selected` (wartość w wybranej walucie).
- **`&date=2026-06-03`** — historyczny cron-snapshot z tej daty (godzina 7:00 UTC).
  Akceptuje pełny timestamp `&date=2026-06-03T10:30:00Z` → ostatni snapshot przed tym momentem.
  Odpowiedź zawiera dodatkowo `captured_at` i `source`. 404 gdy brak snapshotu.

Frontend liczy total sam (suma `value_usd` / `value_ccy`).

### `GET /last-visit`
Ostatnia wizyta usera — kiedy i jaki był wtedy portfel (do „od ostatniej wizyty: +X%").
```json
{
  "currency": "PLN",
  "captured_at": "2026-06-05T12:19:54.818+00:00",
  "holdings_breakdown": [ ... ]
}
```
- `&currency=EUR` — dodaje `value_selected`.
- 404 jeśli user nigdy nie otworzył aplikacji.

### `GET /snapshot-dates`
Lista dat (YYYY-MM-DD) dostępnych cron-snapshotów, od najnowszej. Frontend wie, które
opcje PnL pokazać (wczoraj, start tygodnia/miesiąca/roku).
```json
{ "dates": ["2026-06-13", "2026-06-12", "2026-06-11"] }
```
- Nieistniejący user → `200` z pustą tablicą `[]`.

### `GET /value-history`
Szereg czasowy wartości portfela z cron-snapshotów — jeden punkt na dzień. Zamiast
N requestów `?date=` frontend dostaje cały wykres naraz.
```json
{
  "currency": "PLN",
  "points": [ { "date": "2026-01-01", "value": 184320.55 }, ... ]
}
```
Parametry opcjonalne:
- **`&category_id=crypto`** — tylko aktywa z tej kategorii.
- **`&asset_id=BTC`** — tylko ten asset.
- **`&currency=EUR`** — dodaje `value_selected` per punkt.
- **`&from=2026-01-01&to=2026-03-31`** — filtr zakresu dat.

### `POST /holdings`
Dodaje pozycję do portfela. `user_id` z JWT. Zwraca `201` z utworzonym wierszem (z `id`).

**market** (cenę zna backend):
```json
{ "category": "crypto", "asset_id": "BTC", "amount": 0.25, "display_category": null }
```
- `category` ∈ market (`crypto`/`stock`/`etf`/`metal`/`currency`), `asset_id` musi istnieć i być aktywny w `asset_definitions`, a jego kategoria musi zgadzać się z `category`.
- `display_category` opcjonalne (np. ETF obligacyjny → `bonds`).
- **Add-time guard:** backend wycenia asset **przed** insertem (cache → on-demand z providera).
  Gdy źródło rotacji nie zwraca kursu → **`400` „brak notowań", pozycja NIE powstaje** (niezmiennik
  „katalog ⊆ wyceniarne"). Krypto/metale (własny cron) nie są blokowane — cache dosypie cenę.

**manual** (cenę podaje user):
```json
{ "category": "bonds", "amount": 100,
  "custom": { "name": "Obligacje EDO", "unit_value": 1, "currency": "PLN",
              "display_category": null, "interest_rate": 5, "start_date": "2026-01-01" } }
```
- `category` ∈ manual (`real_estate`/`valuables`/`bonds`/`deposits`/`other`).
- `custom.unit_value > 0`, `custom.currency` = `USD` lub aktywna waluta z katalogu.
- Obligacje: `interest_rate` opcjonalne; `start_date` opcjonalne (`YYYY-MM-DD`, domyślnie dziś).
- `400` przy złej kategorii / nieznanym asset / brakującym polu.

### `PATCH /holdings/:id`
Edycja istniejącej pozycji usera. Body: `{ "amount"?: number, "unit_value"?: number }`.
- `amount` dla obu klas; `unit_value` tylko dla `manual` (na market → `400`).
- `404` gdy pozycja nie należy do usera / nie istnieje.

### `DELETE /holdings/:id`
Usuwa pozycję usera. Zwraca `{ "deleted": true, "id": "…" }`. `404` gdy nie znaleziono.
W tle zapisuje do ledgera `sell` całości po bieżącej cenie.

### `GET /transactions`
Historia przepływów usera (`JWT`, `user_id` z claim `sub`). Lista **malejąco po `created_at`**.
- `?currency=EUR` — przeliczenie na EUR; bez parametru używa `preferred_currency` usera.
- `value_usd` PODPISANA (`+` buy, `−` sell); `value_ccy = value_usd / fx` (fx = ile USD kosztuje 1 jednostka waluty, USD=1) — zachowuje znak, do sumowania przepływów w walucie frontu.
- Front liczy rozbicie sam: **`Ruch ceny = ΔWartość − Σ value_ccy`** (ΔWartość już ma z `/portfolio`).
```json
{ "currency": "PLN",
  "transactions": [
    { "id": "…", "asset_id": "BTC", "name": null, "category": "crypto",
      "side": "buy", "amount": 0.25, "exec_price_usd": 66928,
      "value_usd": 16732, "value_ccy": 61125.93, "created_at": "2026-06-24T18:00:00Z" }
  ] }
```
- Manual: `asset_id` = null, `name` ustawione. `400` przy nieznanej walucie.

---

## 7. Edge Functions — joby cron

Te funkcje odpala pg_cron (nie frontend). Każda loguje do `cron_logs` i wysyła mail przy awarii.

### `fetch-prices` (co 15 min)
Silnik rotacji cen — **demand-driven + multi-provider** (patrz `docs/PRICING_REDESIGN.md` Faza 2).
- **Kandydaci = aktywa faktycznie trzymane** (`DISTINCT holdings.asset_id` gdzie `price_source='market'`)
  **∪ wszystkie aktywne waluty** (FX-szkielet konwersji `preferred_currency`/`?currency=` — bierzemy
  niezależnie od holdings). Katalog może mieć tysiące pozycji, rotacja ich nie tyka.
- Kandydaci **grupowani per `api_source`**; każda grupa ma własny provider
  (`_shared/price_providers/`) z własnym `batchSize` i kursorem. Dziś zarejestrowany tylko
  `twelve_data` (`batchSize=8`). Źródła z własną funkcją (`coingecko`, `metals_dev`) nie mają
  providera tutaj → trzymane aktywa z tych źródeł rotacja pomija.
- Kursor per grupa: **najstarsze `updated_at` pierwsze** (NULL = nowy ticker = priorytet),
  jedno żądanie na ≤`batchSize` symboli.
- Sukces → zapis do `price_cache`, kasuje wpis w `damaged_assets`.
- Porażka → inkrement licznika w `damaged_assets`. Po 3 próbach/dobę: log error + mail,
  asset wypada z rotacji do północy UTC.
- Czysta logika (`logic.ts`: `pickAssets`/`applyOutcomes`) testowana jednostkowo, wołana per
  grupa — bramka `unit-test` w CI. Sam request siedzi w providerze.
- Bezpiecznik budżetu: 8 × 96 wywołań/dobę = 768 < 800 (limit Twelve Data).
- **On-demand (Faza 2b):** `holdings` POST market przy braku ceny w cache woła
  `provider.fetchBatch([asset])` od razu (best-effort) — user widzi cenę natychmiast.

### `fetch-metals` (co 2 dni, 6:00 UTC)
Metale z Metals.Dev. Osobno, bo limit 100 req/**miesiąc**.
- Każdy metal pobierany osobnym requestem (`Promise.allSettled`).
- Awaria (choćby częściowa) → **mail od razu** (przy cyklu co 2 dni nie ma ryzyka spamu;
  licznik „3/dobę" tu nie ma sensu).

### `fetch-crypto` (co 15 min)
Krypto z CoinGecko. Osobna funkcja (jak `fetch-metals`), bo CoinGecko daje **bulk**:
jedno żądanie `/coins/markets` zwraca całe top-100 naraz — nie pasuje do rotacyjnego
silnika Twelve Data. Patrz `docs/PRICING_REDESIGN.md` (Faza 1).
- `asset_definitions` z `api_source='coingecko'`; **`api_symbol` = coingecko `id`**
  (`bitcoin`, `ethereum`, …), nie ticker. Mapowanie `coin.id → api_symbol → asset_id → price_cache`.
- Polityka alertów inna niż `fetch-metals` (cykl co 5 min): mail **tylko** przy totalnej
  porażce (0 cen); brak pojedynczego coina w top-100 → tylko `cron_logs.warnings`, bez maila.
- Sekret `COINGECKO_API_KEY` (demo plan, nagłówek `x-cg-demo-api-key`) — opcjonalny.

### `fetch-eod` (co godzinę) — źródło docelowe akcji/ETF/FX
Akcje/ETF/FX z **EODHD** (zastępuje Twelve Data). Standalone, bo model jest inny niż rotacja TD:
dane **EOD** (raz dziennie), pobierane **bulkiem per giełda**. Patrz `docs/PRICING_REDESIGN.md` (Faza 4).
- **FX** (`{CCY}USD.FOREX`, `close`=kurs) pobierane **pierwsze** — szkielet konwersji akcji nie-USD na USD.
- **Akcje/ETF**: `eod-bulk-last-day/{EXCHANGE}` = 1 call/giełda. US → filtr `symbols=`; nie-US → pełny
  dump giełdy + filtr w kodzie. Konwersja: `close × (÷100 jeśli pensy/LSE) × kurs(waluta→USD)`.
- **`api_symbol` nie jest czytany** — symbol/giełda wyprowadzane z `exchange`/`country` (rewers do TD
  = sam flip `api_source`, bez redeployu — `api_symbol` zostaje w formacie TD).
- **Model błędów** (cron co godzinę, pełny run): **FX bez kursu CAŁY dzień → mail**; **trzymany ticker
  bez ceny CAŁY dzień → mail**; transient (jeden run) → cicho, następny run ponawia. „Cały dzień"
  wykrywane z `price_cache.updated_at` (audyt w runie o 23:00 UTC).
- Sekret `EODHD_API_KEY`. **Rewers do TD**: patrz migracja `..._eodhd_cutover.sql` (blok ROLLBACK).

### `snapshot-portfolio` (codziennie, 7:00 UTC)
Dzienny cron-snapshot dla **wszystkich** userów (`source='cron'`).
- Usuwa istniejący dzisiejszy cron-snapshot, liczy świeży z `price_cache`, wstawia.
- Warningi (brak kursu dla assetu) → `cron_logs.warnings`; twardy błąd → mail.

### `smoke-test` (po każdym deployu)
Harness testowy — curlem przechodzi po wszystkich endpointach i weryfikuje statusy/kształty.
Nie jest częścią runtime'u aplikacji, służy CI.

---

## 8. Harmonogram pg_cron

Konfigurowany **ręcznie** w Supabase SQL Editor (nie w migracjach):

| Job | Harmonogram | Cron expr |
|-----|-------------|-----------|
| `fetch-eod` (EODHD — akcje/ETF/FX, docelowe) | co godzinę | `0 * * * *` |
| `fetch-prices` (TD — **uśpione** po cutoverze) | co 15 min | `*/15 * * * *` |
| `fetch-crypto` | co 15 min | `*/15 * * * *` |
| `fetch-metals` | co 2 dni, 6:00 UTC | `0 6 */2 * *` |
| `daily-portfolio-snapshot` (`snapshot-portfolio`) | codziennie, 7:00 UTC | `0 7 * * *` |

---

## 9. Kod współdzielony (`_shared`)

Wspólna logika wydzielona do `supabase/functions/_shared/` (prefiks `_` → CLI nie deployuje
tego jako osobnej funkcji; importy `../_shared/*.ts` są bundlowane do każdej funkcji):

| Plik | Zawiera |
|------|---------|
| `supabase.ts` | `getServiceClient()` + typ `Supa` |
| `http.ts` | `json()`, `badRequest()`, `notFound()`, `serverError()` |
| `types.ts` | `HoldingEntry`, `PriceRow` |
| `alerts.ts` | `sendAlertEmail()`, `writeCronLog()` |
| `currency.ts` | `resolveSelectedCurrency()` — walidacja `?currency=X` + kurs FX |
| `pricing.ts` | `buildPriceMap()` — mapa `asset_id → { price_usd, category }` |
| `price_providers/` | warstwa per-źródło rotacji: `PriceProvider` (interfejs), `twelveDataProvider`, rejestr `getProvider()` |

---

## 10. Kody błędów (wszystkie endpointy)

| HTTP | Sytuacja |
|------|----------|
| 400 | Brak wymaganego parametru lub nieprawidłowa waluta |
| 404 | Brak usera / snapshotu dla daty / visit-snapshotu |
| 500 | Błąd DB lub zewnętrznego API |

Kształt błędu: `{ "error": "opis" }`. Funkcje cron zwracają na błędzie `{ "success": false, "error": "..." }`.

---

## 11. Auth — stan i plan

- **Teraz:** endpointy per-user (`portfolio`, `last-visit`, `assets`, `snapshot-dates`,
  `value-history`) mają **`verify_jwt = true`** (config.toml). Bramka Supabase weryfikuje
  podpis tokena, funkcja czyta `user_id` z claim `sub` (helper `_shared/auth.ts`).
- **user_id tylko z `sub`** (helper `resolveUserId`): token `authenticated` → `user_id`
  z claim `sub`; `anon` / `service_role` / brak `sub` → **brak dostępu** (`null`). Nie ma
  żadnego fallbacku na `?user_id=` — query param jest całkowicie ignorowany, więc nawet
  z ważnym (publicznym) anon key nie da się podać cudzego id i odczytać nie swoich danych.
- **Funkcje cron + `smoke-test`:** `verify_jwt = false` (woła je pg_cron / CI bez tokena
  usera). `smoke-test` loguje się jako testowy user (password grant, sekret
  `SMOKE_TEST_PASSWORD`) i dopiero tym tokenem odpytuje endpointy per-user. Deploy bez flagi
  `--no-verify-jwt` — bramka sterowana per-funkcja z `config.toml`.
- **Nowy user bez danych:** profil zakładany automatycznie triggerem `on_auth_user_created`
  przy rejestracji (brak wierszy w `holdings` → `portfolio` zwraca `holdings_breakdown: []`, nie 404).
  `last-visit` bez wizyt → 404 (oczekiwane, frontend to obsługuje).

---

## 12. Testowy user

- **UUID:** `4ff2377f-a833-4a05-9930-391d84d4182d`
- **preferred_currency:** PLN
- **holdings (10 aktywów, tabela `holdings`, wszystkie `market`):** BTC=0.25, ETH=2, SOL=15, AAPL=10, MSFT=5, GOOGL=3, XAU=2, EUR=500, SPY=12, QQQ=8
- Cron-snapshoty od 1 stycznia generowane syntetycznie z realistyczną oscylacją ceny
  (ten sam zestaw 10 aktywów co żywy portfel).

---

## 13. Koszty — płatne API, biblioteki i plany

Stan na **2026-06-14**. Wszystko obecnie **w ramach darmowych tierów / licencji — zero realnych kosztów**.
Kwoty orientacyjne; przed upgradem sprawdź aktualny cennik dostawcy.

### Usługi (API, hosting, mail)

| Usługa | Do czego | Plan teraz | Zużycie / limit dziś | Warunki przejścia na wyższy plan |
|--------|----------|-----------|----------------------|----------------------------------|
| **Supabase** | baza, auth, Edge Functions, cron | Free | DB ~500 MB, ~500 tys. wywołań funkcji/mies.; projekt **pauzuje po 7 dniach bezczynności** | **Pro ~$25/mies.** — produkcja (brak pauzowania), backupy, przekroczenie DB/transferu/wywołań |
| **Twelve Data** | krypto, akcje, ETF, forex | Free | 8 credits/min, 800/dobę, **tylko rynki US**; zużycie 8×96 = **768/800** | **płatny od ~$29/mies.** — giełdy EU (XETRA/LSE → VWCE/IWDA/CSPX/AGGH), więcej assetów, próg 800/dobę lub rate limit 8/min |
| **Metals.Dev** | metale (XAU, XAG, XPT, XPD) | Free | **100 req/miesiąc**; zużycie 4 metale co 2 dni ≈ **60/100** | płatny — więcej metali, częstszy cron lub dobicie do 100/mies. |
| **Resend** | alerty mailowe przy awariach cronów | Free | 100 maili/dobę, 3000/mies., 1 domena (nadawca `onboarding@resend.dev`) | **~$20/mies.** — własna domena nadawcza, większy wolumen |

### Biblioteki frontendu (Flutter — repo `abundapp-frontend`)

| Biblioteka | Do czego | Licencja / koszt | Uwaga |
|------------|----------|------------------|-------|
| **`syncfusion_flutter_charts`** | wykresy (zaawansowane) | **Komercyjna.** Darmowa tylko na **Community License**: roczny przychód < $1 mln USD, ≤5 deweloperów, ≤10 pracowników. Inaczej płatna (subskrypcja per-deweloper). | **Jedyna potencjalnie płatna zależność.** Dziś kwalifikujemy się na Community (projekt prywatny) — pilnować progu przy komercjalizacji |
| `fl_chart` | wykresy (proste) | MIT — darmowa | open-source |
| `supabase_flutter` | klient Supabase | BSD/MIT — darmowa | oficjalny SDK |
| `flutter_riverpod`, `riverpod_annotation` | state management | MIT — darmowa | |
| `http`, `shared_preferences`, `intl`, `cupertino_icons` | sieć, storage, formatowanie, ikony | BSD/MIT — darmowe | standardowe pakiety |

> **Backend (to repo)** nie ciągnie żadnych płatnych bibliotek — zależności Edge Functions
> (`supabase-js`, Deno std) są darmowe i open-source. Jedyne koszty backendu to usługi z tabeli wyżej.
