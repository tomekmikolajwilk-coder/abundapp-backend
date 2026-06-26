import type { PriceRow } from "../types.ts";
import type { FetchBatchResult, PriceProvider, ProviderAsset } from "./types.ts";

// Provider Twelve Data — jedno żądanie /price na ≤8 symboli, bez sleepów/batchowania
// (to usunęło WORKER_RESOURCE_LIMIT). Treść przeniesiona 1:1 z fetch-prices/index.ts;
// teraz moduł, bo wołają go i fetch-prices (rotacja), i holdings (on-demand przy dodaniu pozycji).

const REQUEST_SIZE = 8; // 8 symboli = 8 kredytów na wywołanie (budżet 8 × 96/dobę = 768 < 800)

async function fetchBatch(assets: ProviderAsset[]): Promise<FetchBatchResult> {
  if (assets.length === 0) return { rows: [], failed: [], errors: [] };

  const apiKey = Deno.env.get("TWELVE_DATA_API_KEY");
  if (!apiKey) {
    // Brak klucza nie wywala całego runa (mogą być inni providerzy) — wszystkie liczymy jako failed.
    return { rows: [], failed: assets.map((a) => a.asset_id), errors: ["Brak TWELVE_DATA_API_KEY"] };
  }

  const symbols = assets.map((s) => s.api_symbol);
  console.log(`[TwelveData] Pobieram ${symbols.length}: ${symbols.join(", ")}`);

  try {
    const url = new URL("https://api.twelvedata.com/price");
    url.searchParams.set("symbol", symbols.join(","));
    url.searchParams.set("apikey", apiKey);

    const res = await fetch(url.toString());
    console.log(`[TwelveData] HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    // Dla jednego symbolu API zwraca {price:"..."}, dla wielu {SYMBOL:{price:"..."}}.
    const normalized: Record<string, { price?: string; code?: number; message?: string }> =
      symbols.length === 1 ? { [symbols[0]]: data } : data;

    const rows: PriceRow[] = [];
    const failed: string[] = [];
    const errors: string[] = [];
    const now = new Date().toISOString();

    for (const def of assets) {
      const val = normalized[def.api_symbol];
      if (val?.price != null && val.code == null) {
        rows.push({ asset_id: def.asset_id, price_usd: parseFloat(val.price), updated_at: now });
      } else {
        const msg = `TwelveData: ${def.api_symbol} (${def.asset_id}) — ${val?.message ?? `code ${val?.code}`}`;
        console.warn(`[TwelveData] ⚠️ ${msg}`);
        failed.push(def.asset_id);
        errors.push(msg);
      }
    }
    console.log(`[TwelveData] OK: ${rows.length}, błędy: ${failed.length}`);
    return { rows, failed, errors };
  } catch (err) {
    // Żądanie padło w całości — wszystkie wybrane assety liczymy jako nieudane.
    const msg = `TwelveData request: ${String(err)}`;
    console.error(`[TwelveData] ❌ ${msg}`);
    return { rows: [], failed: assets.map((s) => s.asset_id), errors: [msg] };
  }
}

export const twelveDataProvider: PriceProvider = {
  source: "twelve_data",
  batchSize: REQUEST_SIZE,
  fetchBatch,
};
