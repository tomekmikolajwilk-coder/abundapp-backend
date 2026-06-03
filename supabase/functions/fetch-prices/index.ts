import { createClient } from "npm:@supabase/supabase-js@2";

type PriceRow = { asset_id: string; price_usd: number; updated_at: string };

// Twelve Data: akcje, krypto, waluty
const TWELVE_DATA_SYMBOLS: Record<string, string> = {
  "BTC/USD": "BTC",
  "ETH/USD": "ETH",
  "SOL/USD": "SOL",
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

// Metals.Dev: metale szlachetne
const METALS_DEV_MAP: Record<string, string> = {
  gold: "XAU",
  silver: "XAG",
  platinum: "XPT",
  palladium: "XPD",
};

const BATCH_SIZE = 8;
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

async function fetchMetalsDev(apiKey: string): Promise<PriceRow[]> {
  const now = new Date().toISOString();
  const results = await Promise.all(
    Object.entries(METALS_DEV_MAP).map(async ([metal, asset_id]) => {
      const url = new URL("https://api.metals.dev/v1/metal/spot");
      url.searchParams.set("api_key", apiKey);
      url.searchParams.set("metal", metal);
      url.searchParams.set("currency", "USD");

      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`Metals.Dev error for ${metal}: ${res.status}`);

      const data = await res.json();
      if (data.status !== "success") throw new Error(`Metals.Dev ${metal}: ${data.message}`);

      return { asset_id, price_usd: data.rate.price, updated_at: now };
    })
  );
  return results;
}

async function sendErrorEmail(errorMsg: string): Promise<void> {
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const alertEmail = Deno.env.get("ALERT_EMAIL");
  if (!resendKey || !alertEmail) return;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "abundapp <onboarding@resend.dev>",
      to: alertEmail,
      subject: "❌ abundapp: błąd fetch-prices",
      html: `
        <h2>Funkcja fetch-prices zakończyła się błędem</h2>
        <p><strong>Czas:</strong> ${new Date().toISOString()}</p>
        <pre style="background:#f4f4f4;padding:12px">${errorMsg}</pre>
      `,
    }),
  });
}

async function writeLog(
  supabase: ReturnType<typeof createClient>,
  success: boolean,
  assetsUpdated: number | null,
  errorMessage: string | null
): Promise<void> {
  await supabase.from("cron_logs").insert({
    success,
    assets_updated: assetsUpdated,
    error_message: errorMessage,
  });
}

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const twelveApiKey = Deno.env.get("TWELVE_DATA_API_KEY");
    if (!twelveApiKey) throw new Error("Brak TWELVE_DATA_API_KEY");

    const metalsApiKey = Deno.env.get("METALS_DEV_API_KEY");
    if (!metalsApiKey) throw new Error("Brak METALS_DEV_API_KEY");

    const [twelveRows, metalRows] = await Promise.all([
      fetchTwelveData(twelveApiKey),
      fetchMetalsDev(metalsApiKey),
    ]);

    const allRows = [...twelveRows, ...metalRows];
    if (allRows.length === 0) throw new Error("Brak danych z obu źródeł");

    const { error } = await supabase
      .from("price_cache")
      .upsert(allRows, { onConflict: "asset_id" });

    if (error) throw error;

    await writeLog(supabase, true, allRows.length, null);

    return new Response(
      JSON.stringify({ success: true, updated: allRows.length, assets: allRows }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    const errorMsg = String(err);

    await Promise.all([
      writeLog(supabase, false, null, errorMsg),
      sendErrorEmail(errorMsg),
    ]);

    return new Response(
      JSON.stringify({ success: false, error: errorMsg }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
