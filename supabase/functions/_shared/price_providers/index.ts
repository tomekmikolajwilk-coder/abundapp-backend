import type { PriceProvider } from "./types.ts";
import { twelveDataProvider } from "./twelve_data.ts";

export type { FetchBatchResult, PriceProvider, ProviderAsset } from "./types.ts";

// Rejestr providerów rotacji fetch-prices. Klucz = asset_definitions.api_source.
// Dziś tylko Twelve Data. Dodanie źródła EU (REST + budżet dobowy) = nowy moduł + jedna linijka tu.
// Źródła o innym modelu limitu (coingecko bulk, metals_dev miesięczny) NIE są tutaj — mają
// własne funkcje (fetch-crypto, fetch-metals); held assety z tych źródeł rotacja po prostu pomija.
export const PROVIDERS: Record<string, PriceProvider> = {
  [twelveDataProvider.source]: twelveDataProvider,
};

export function getProvider(source: string): PriceProvider | undefined {
  return PROVIDERS[source];
}
