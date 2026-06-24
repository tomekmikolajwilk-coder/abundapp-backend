// Wspólne typy używane przez kilka funkcji.

// Pojedyncza pozycja portfela w odpowiedziach /portfolio, /last-visit oraz w snapshotach.
// value_selected jest opcjonalne — pojawia się tylko gdy podano ?currency=X.
//
// Pola id/price_source/name/display_category/interest_rate doszły z tabelą holdings.
// Są opcjonalne, bo stare snapshoty (zapisane przed migracją) ich nie mają — frontend
// czyta je z domyślnymi (price_source→market, reszta null), więc wstecznie kompatybilne.
export type HoldingEntry = {
  id?: string;                            // id wiersza holdings (do PATCH/DELETE)
  asset_id: string | null;               // null dla pozycji manual
  category: string;
  amount: number;
  price_usd: number;
  value_usd: number;
  value_ccy: number;
  value_selected?: number;
  price_source?: "market" | "manual";
  name?: string | null;                  // nazwa custom assetu (manual); null dla market
  display_category?: string | null;      // kategoria wyświetlania; null = jak category
  interest_rate?: number | null;         // roczna stopa % (obligacje); null gdy brak
  unit_value?: number | null;            // natywna cena jednostki (manual, w unit_currency); null dla market
  unit_currency?: string | null;         // waluta natywna pozycji (manual, z POST custom.currency); null dla market
};

// Wiersz zapisywany do price_cache przez fetch-prices / fetch-metals.
export type PriceRow = {
  asset_id: string;
  price_usd: number;
  updated_at: string;
};
