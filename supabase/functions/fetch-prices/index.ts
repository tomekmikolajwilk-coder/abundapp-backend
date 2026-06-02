import { createClient } from "npm:@supabase/supabase-js@2";

// Mapowanie: Twelve Data symbol → nasz asset_id w price_cache
const SYMBOLS: Record<string, string> = {
  // Krypto
  "BTC/USD": "BTC",
  "ETH/USD": "ETH",
  "SOL/USD": "SOL",
  // Złoto i srebro
  "XAU/USD": "XAU",
  "XAG/USD": "XAG",
  // Waluty (cena 1 jednostki w USD)
  "EUR/USD": "EUR",
  "GBP/USD": "GBP",
  "JPY/USD": "JPY",
  "CNH/USD": "CNH",
  "CHF/USD": "CHF",
  "CAD/USD": "CAD",
  "PLN/USD": "PLN",
  // Popularne akcje
  "AAPL": "AAPL",
  "MSFT": "MSFT",
  "GOOGL": "GOOGL",
  "AMZN": "AMZN",
  "TSLA": "TSLA",
  "NVDA": "NVDA",
};

const BATCH_SIZE = 8; // free tier: 8 creditów/minutę
const BATCH_DELAY_MS = 61_000; // 61 sekund między batchami

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBatch(
  symbols: string[],
  apiKey: string
): Promise<{ asset_id: string; price_usd: number; updated_at: string }[]> {
  const url = new URL("https://api.twelvedata.com/price");
  url.searchParams.set("symbol", symbols.join(","));
  url.searchParams.set("apikey", apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Twelve Data error: ${res.status}`);

  const data = await res.json();

  // Gdy tylko 1 symbol — API zwraca obiekt bez zagnieżdżenia
  const normalized: Record<string, { price?: string; code?: number }> =
    symbols.length === 1 ? { [symbols[0]]: data } : data;

  return Object.entries(normalized)
    .filter(([symbol, val]) => SYMBOLS[symbol] && val.price != null && val.code == null)
    .map(([symbol, val]) => ({
      asset_id: SYMBOLS[symbol],
      price_usd: parseFloat(val.price!),
      updated_at: new Date().toISOString(),
    }));
}

Deno.serve(async () => {
  try {
    const apiKey = Deno.env.get("TWELVE_DATA_API_KEY");
    if (!apiKey) throw new Error("Brak TWELVE_DATA_API_KEY");

    const allSymbols = Object.keys(SYMBOLS);
    const batches = chunk(allSymbols, BATCH_SIZE);
    const allRows: { asset_id: string; price_usd: number; updated_at: string }[] = [];

    for (let i = 0; i < batches.length; i++) {
      if (i > 0) await sleep(BATCH_DELAY_MS); // czekaj między batchami
      const rows = await fetchBatch(batches[i], apiKey);
      allRows.push(...rows);
    }

    if (allRows.length === 0) throw new Error("Brak danych z Twelve Data");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { error } = await supabase
      .from("price_cache")
      .upsert(allRows, { onConflict: "asset_id" });

    if (error) throw error;

    return new Response(
      JSON.stringify({ success: true, updated: allRows.length, assets: allRows }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
