import { createClient } from "npm:@supabase/supabase-js@2";

// Mapowanie: Yahoo symbol → nasz asset_id w price_cache
const SYMBOLS: Record<string, string> = {
  // Krypto
  "BTC-USD": "BTC",
  "ETH-USD": "ETH",
  "SOL-USD": "SOL",
  // Złoto i srebro (futures)
  "GC=F": "XAU",
  "SI=F": "XAG",
  // Waluty (cena w USD)
  "EURUSD=X": "EUR",
  "GBPUSD=X": "GBP",
  "JPYUSD=X": "JPY",
  "CNHUSD=X": "CNH",
  "CHFUSD=X": "CHF",
  "CADUSD=X": "CAD",
  "PLNUSD=X": "PLN",
};

const YAHOO_URL =
  "https://query1.finance.yahoo.com/v8/finance/quote?symbols=" +
  Object.keys(SYMBOLS).join(",");

Deno.serve(async () => {
  try {
    // 1. Pobierz kursy z Yahoo Finance
    const res = await fetch(YAHOO_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    if (!res.ok) {
      throw new Error(`Yahoo Finance error: ${res.status}`);
    }

    const data = await res.json();
    const quotes = data?.quoteResponse?.result ?? [];

    if (quotes.length === 0) {
      throw new Error("Yahoo Finance zwrócił puste dane");
    }

    // 2. Zbuduj rekordy do upsert
    const rows = quotes
      .filter((q: { symbol: string; regularMarketPrice?: number }) =>
        SYMBOLS[q.symbol] && q.regularMarketPrice != null
      )
      .map((q: { symbol: string; regularMarketPrice: number }) => ({
        asset_id: SYMBOLS[q.symbol],
        price_usd: q.regularMarketPrice,
        updated_at: new Date().toISOString(),
      }));

    // 3. Zapisz do Supabase price_cache
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
