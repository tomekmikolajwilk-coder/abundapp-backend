import type { PriceRow } from "../types.ts";

// Asset do pobrania przez providera — minimum potrzebne, by zmapować cenę z powrotem na asset_id.
export type ProviderAsset = { asset_id: string; api_symbol: string };

// Wynik pobrania batcha:
//   rows   — pobrane ceny (→ price_cache),
//   failed — asset_id których nie udało się pobrać (→ licznik damaged_assets),
//   errors — ludzkie komunikaty (→ cron_logs.warnings / mail).
export type FetchBatchResult = { rows: PriceRow[]; failed: string[]; errors: string[] };

// Provider = małe, deklaratywne źródło ceny pasujące do silnika rotacji fetch-prices:
// deklaruje własny batchSize (budżet na jedno wywołanie) + sam request (fetchBatch).
// Reszta — kursor, licznik awarii, zapis do price_cache — jest WSPÓLNA (logic.ts + index.ts).
//
// Tu wpinają się tylko źródła pasujące do modelu „batch na run + budżet dobowy" (Twelve Data,
// przyszłe EU REST). Źródła o innym limicie (bulk CoinGecko, miesięczny Metals.Dev) mają
// WŁASNE funkcje (fetch-crypto, fetch-metals) i nie są providerami tutaj.
export interface PriceProvider {
  source: string; // = asset_definitions.api_source
  batchSize: number; // ile assetów bierzemy w jednym wywołaniu
  fetchBatch(assets: ProviderAsset[]): Promise<FetchBatchResult>;
}
