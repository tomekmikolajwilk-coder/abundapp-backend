// Wspólne typy używane przez kilka funkcji.

// Pojedyncza pozycja portfela w odpowiedziach /portfolio, /last-visit oraz w snapshotach.
// value_selected jest opcjonalne — pojawia się tylko gdy podano ?currency=X.
export type HoldingEntry = {
  asset_id: string;
  category: string;
  amount: number;
  price_usd: number;
  value_usd: number;
  value_ccy: number;
  value_selected?: number;
};

// Wiersz zapisywany do price_cache przez fetch-prices / fetch-metals.
export type PriceRow = {
  asset_id: string;
  price_usd: number;
  updated_at: string;
};
