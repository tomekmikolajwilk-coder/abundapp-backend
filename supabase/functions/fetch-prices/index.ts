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

Deno.serve(async () => {
  try {
    const apiKey = Deno.env.get("TWELVE_DATA_API_KEY");
    if (!apiKey) throw new Error("Brak TWELVE_DATA_API_KEY");

    // Jeden request po wszystkie symbole
    const url = new URL("https://api.twelvedata.com/price");
    url.searchParams.set("symbol", Object.keys(SYMBOLS).join(","));
    url.searchParams.set("apikey", apiKey);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Twelve Data error: ${res.status}`);

    const data = await res.json();

    // Zbuduj rekordy — odpowiedź to { "BTC/USD": { price: "43000" }, ... }
    const rows = Object.entries(data)
      .filter(([symbol, val]: [string, unknown]) => {
        const v = val as { price?: string; code?: number };
        return SYMBOLS[symbol] && v.price != null && v.code == null;
      })
      .map(([symbol, val]: [string, unknown]) => {
        const v = val as { price: string };
        return {
          asset_id: SYMBOLS[symbol],
          price_usd: parseFloat(v.price),
          updated_at: new Date().toISOString(),
        };
      });

    if (rows.length === 0) throw new Error("Brak danych z Twelve Data");

    // Zapisz do Supabase price_cache
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { error } = await supabase
      .from("price_cache")
      .upsert(rows, { onConflict: "asset_id" });

    if (error) throw error;

    return new Response(
      JSON.stringify({ success: true, updated: rows.length, assets: rows }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
