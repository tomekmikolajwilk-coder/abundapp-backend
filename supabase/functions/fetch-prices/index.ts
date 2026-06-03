import { createClient } from "npm:@supabase/supabase-js@2";

type PriceRow = { asset_id: string; price_usd: number; updated_at: string };

// Twelve Data: akcje, krypto, złoto, waluty
const TWELVE_DATA_SYMBOLS: Record<string, string> = {
  "BTC/USD": "BTC",
  "ETH/USD": "ETH",
  "SOL/USD": "SOL",
  "WTI/USD": "WTI",
  "EUR/USD": "EUR",
  "GBP/USD": "GBP",
  "JPY/USD": "JPY",
  "CHF/USD": "CHF",
  "CAD/USD": "CAD",
  "PLN/USD": "PLN",
  "AAPL": "AAPL",
  "MSFT": "MSFT",
  "GOOGL": "GOOGL",
  "AMZN": "AMZN",
  "TSLA": "TSLA",
  "NVDA": "NVDA",
};

const BATCH_SIZE = 8;       // free tier: 8 creditów/minutę
const BATCH_DELAY_MS = 61_000;

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTwelveData(apiKey: string): Promise<PriceRow[]> {
  const allSymbols = Object.keys(TWELVE_DATA_SYMBOLS);
  const batches = chunk(allSymbols, BATCH_SIZE);
  const rows: PriceRow[] = [];

  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await sleep(BATCH_DELAY_MS);

    const url = new URL("https://api.twelvedata.com/price");
    url.searchParams.set("symbol", batches[i].join(","));
    url.searchParams.set("apikey", apiKey);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Twelve Data error: ${res.status}`);
    const data = await res.json();

    const normalized: Record<string, { price?: string; code?: number }> =
      batches[i].length === 1 ? { [batches[i][0]]: data } : data;

    for (const [symbol, val] of Object.entries(normalized)) {
      if (TWELVE_DATA_SYMBOLS[symbol] && val.price != null && val.code == null) {
        rows.push({
          asset_id: TWELVE_DATA_SYMBOLS[symbol],
          price_usd: parseFloat(val.price),
          updated_at: new Date().toISOString(),
        });
      }
    }
  }

  return rows;
}

// Metals.Dev: srebro (XAG), platyna (XPT), pallad (XPD)
const METALS_DEV_MAP: Record<string, string> = {
  gold: "XAU",
  silver: "XAG",
  platinum: "XPT",
  palladium: "XPD",
};

async function fetchMetalsDev(apiKey: string): Promise<PriceRow[]> {
  const url = new URL("https://metals.dev/api/spot");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("currency", "USD");
  url.searchParams.set("unit", "toz");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Metals.Dev error: ${res.status}`);

  const data = await res.json();
  if (data.status !== "success") throw new Error(`Metals.Dev: ${data.message}`);

  const now = new Date().toISOString();
  return Object.entries(METALS_DEV_MAP)
    .filter(([metal]) => data.metals?.[metal] != null)
    .map(([metal, asset_id]) => ({
      asset_id,
      price_usd: data.metals[metal],
      updated_at: now,
    }));
}

Deno.serve(async () => {
  try {
    const twelveApiKey = Deno.env.get("TWELVE_DATA_API_KEY");
    if (!twelveApiKey) throw new Error("Brak TWELVE_DATA_API_KEY");

    const metalsApiKey = Deno.env.get("METALS_DEV_API_KEY");
    if (!metalsApiKey) throw new Error("Brak METALS_DEV_API_KEY");

    // Pobierz dane z obu źródeł równolegle
    const [twelveRows, metalRows] = await Promise.all([
      fetchTwelveData(twelveApiKey),
      fetchMetalsDev(metalsApiKey),
    ]);

    const allRows = [...twelveRows, ...metalRows];
    if (allRows.length === 0) throw new Error("Brak danych");

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
