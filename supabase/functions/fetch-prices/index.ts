import { createClient } from "npm:@supabase/supabase-js@2";

type PriceRow = {
  asset_id: string;
  price_usd: number;
  category: string;
  updated_at: string;
};
type FetchResult = { rows: PriceRow[]; errors: string[] };
type SymbolDef = { asset_id: string; category: string };

// Twelve Data: akcje, krypto, waluty
const TWELVE_DATA_SYMBOLS: Record<string, SymbolDef> = {
  "BTC/USD": { asset_id: "BTC", category: "crypto" },
  "ETH/USD": { asset_id: "ETH", category: "crypto" },
  "SOL/USD": { asset_id: "SOL", category: "crypto" },
  "EUR/USD": { asset_id: "EUR", category: "currency" },
  "GBP/USD": { asset_id: "GBP", category: "currency" },
  "JPY/USD": { asset_id: "JPY", category: "currency" },
  "CHF/USD": { asset_id: "CHF", category: "currency" },
  "CAD/USD": { asset_id: "CAD", category: "currency" },
  "PLN/USD": { asset_id: "PLN", category: "currency" },
  "AAPL":    { asset_id: "AAPL", category: "stock" },
  "MSFT":    { asset_id: "MSFT", category: "stock" },
  "GOOGL":   { asset_id: "GOOGL", category: "stock" },
  "AMZN":    { asset_id: "AMZN", category: "stock" },
  "TSLA":    { asset_id: "TSLA", category: "stock" },
  "NVDA":    { asset_id: "NVDA", category: "stock" },
};

// Metals.Dev: metale szlachetne
const METALS_DEV_MAP: Record<string, SymbolDef> = {
  gold:      { asset_id: "XAU", category: "metal" },
  silver:    { asset_id: "XAG", category: "metal" },
  platinum:  { asset_id: "XPT", category: "metal" },
  palladium: { asset_id: "XPD", category: "metal" },
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

async function fetchTwelveData(apiKey: string): Promise<FetchResult> {
  const allSymbols = Object.keys(TWELVE_DATA_SYMBOLS);
  const batches = chunk(allSymbols, BATCH_SIZE);
  const rows: PriceRow[] = [];
  const errors: string[] = [];

  console.log(`[TwelveData] Start — ${allSymbols.length} symboli w ${batches.length} batchach`);

  for (let i = 0; i < batches.length; i++) {
    if (i > 0) {
      console.log(`[TwelveData] Czekam 61s przed batchem ${i + 1}...`);
      await sleep(BATCH_DELAY_MS);
    }

    console.log(`[TwelveData] Batch ${i + 1}/${batches.length}: ${batches[i].join(", ")}`);

    try {
      const url = new URL("https://api.twelvedata.com/price");
      url.searchParams.set("symbol", batches[i].join(","));
      url.searchParams.set("apikey", apiKey);

      const res = await fetch(url.toString());
      console.log(`[TwelveData] Batch ${i + 1} HTTP status: ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const normalized: Record<string, { price?: string; code?: number; message?: string }> =
        batches[i].length === 1 ? { [batches[i][0]]: data } : data;

      for (const [symbol, val] of Object.entries(normalized)) {
        const def = TWELVE_DATA_SYMBOLS[symbol];
        if (!def) continue;
        if (val.price != null && val.code == null) {
          rows.push({
            asset_id: def.asset_id,
            price_usd: parseFloat(val.price),
            category: def.category,
            updated_at: new Date().toISOString(),
          });
        } else {
          const msg = `TwelveData: ${symbol} — ${val.message ?? `code ${val.code}`}`;
          console.warn(`[TwelveData] ⚠️ ${msg}`);
          errors.push(msg);
        }
      }
      console.log(`[TwelveData] Batch ${i + 1} — OK: ${rows.length}, błędy: ${errors.length}`);
    } catch (err) {
      const msg = `TwelveData batch ${i + 1}: ${String(err)}`;
      console.error(`[TwelveData] ❌ ${msg}`);
      errors.push(msg);
    }
  }

  console.log(`[TwelveData] Zakończono — ${rows.length} OK, ${errors.length} błędów`);
  return { rows, errors };
}

async function fetchMetalsDev(apiKey: string): Promise<FetchResult> {
  const rows: PriceRow[] = [];
  const errors: string[] = [];
  const now = new Date().toISOString();

  console.log(`[MetalsDev] Start — metale: ${Object.keys(METALS_DEV_MAP).join(", ")}`);

  const settled = await Promise.allSettled(
    Object.entries(METALS_DEV_MAP).map(async ([metal, def]) => {
      const url = new URL("https://api.metals.dev/v1/metal/spot");
      url.searchParams.set("api_key", apiKey);
      url.searchParams.set("metal", metal);
      url.searchParams.set("currency", "USD");

      const res = await fetch(url.toString());
      console.log(`[MetalsDev] ${metal} HTTP status: ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (data.status !== "success") throw new Error(data.message ?? "unknown error");

      console.log(`[MetalsDev] ${metal} (${def.asset_id}): $${data.rate.price}`);
      return {
        asset_id: def.asset_id,
        price_usd: data.rate.price,
        category: def.category,
        updated_at: now,
      };
    })
  );

  const metals = Object.keys(METALS_DEV_MAP);
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      rows.push(result.value);
    } else {
      const msg = `MetalsDev: ${metals[i]} — ${result.reason}`;
      console.warn(`[MetalsDev] ⚠️ ${msg}`);
      errors.push(msg);
    }
  });

  console.log(`[MetalsDev] Zakończono — ${rows.length} OK, ${errors.length} błędów`);
  return { rows, errors };
}

async function sendAlertEmail(subject: string, body: string): Promise<void> {
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const alertEmail = Deno.env.get("ALERT_EMAIL");
  if (!resendKey || !alertEmail) {
    console.warn("[Email] Brak RESEND_API_KEY lub ALERT_EMAIL — pomijam wysyłkę");
    return;
  }

  console.log(`[Email] Wysyłam alert na ${alertEmail}: "${subject}"`);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "abundapp <onboarding@resend.dev>",
      to: alertEmail,
      subject,
      html: `<p><strong>Czas:</strong> ${new Date().toISOString()}</p><pre style="background:#f4f4f4;padding:12px;line-height:2">${body.split("\n").join("<br>")}</pre>`,
    }),
  });
  console.log(`[Email] Resend HTTP status: ${res.status}`);
}

async function writeLog(
  supabase: ReturnType<typeof createClient>,
  success: boolean,
  assetsUpdated: number | null,
  errorMessage: string | null,
  warnings: string | null
): Promise<void> {
  const { error } = await supabase.from("cron_logs").insert({
    success,
    assets_updated: assetsUpdated,
    error_message: errorMessage,
    warnings,
  });
  if (error) {
    console.error(`[DB] Błąd zapisu do cron_logs: ${error.message}`);
  } else {
    console.log(`[DB] cron_logs — success=${success}, assets=${assetsUpdated}, warnings=${warnings ? "tak" : "nie"}`);
  }
}

Deno.serve(async () => {
  console.log("=== fetch-prices START ===");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const twelveApiKey = Deno.env.get("TWELVE_DATA_API_KEY");
    if (!twelveApiKey) throw new Error("Brak TWELVE_DATA_API_KEY");

    const metalsApiKey = Deno.env.get("METALS_DEV_API_KEY");
    if (!metalsApiKey) throw new Error("Brak METALS_DEV_API_KEY");

    const [twelveResult, metalsResult] = await Promise.all([
      fetchTwelveData(twelveApiKey),
      fetchMetalsDev(metalsApiKey),
    ]);

    const allRows = [...twelveResult.rows, ...metalsResult.rows];
    const allErrors = [...twelveResult.errors, ...metalsResult.errors];

    if (allRows.length === 0) throw new Error("Brak jakichkolwiek danych z obu źródeł");

    console.log(`[DB] Zapisuję ${allRows.length} kursów do price_cache...`);
    const { error } = await supabase
      .from("price_cache")
      .upsert(allRows, { onConflict: "asset_id" });

    if (error) throw error;
    console.log(`[DB] price_cache zaktualizowany pomyślnie`);

    const warningsText = allErrors.length > 0 ? allErrors.join("\n") : null;

    if (allErrors.length > 0) {
      console.warn(`[PARTIAL] ${allErrors.length} tickerów nie udało się pobrać`);
      await Promise.all([
        writeLog(supabase, true, allRows.length, null, warningsText),
        sendAlertEmail(
          `⚠️ abundapp: partial success (${allRows.length} OK, ${allErrors.length} błędów)`,
          `Pobrano ${allRows.length} z ${allRows.length + allErrors.length} aktywów.\n\nBłędy:\n${warningsText}`
        ),
      ]);
    } else {
      await writeLog(supabase, true, allRows.length, null, null);
    }

    console.log("=== fetch-prices DONE ===");
    return new Response(
      JSON.stringify({ success: true, updated: allRows.length, warnings: allErrors, assets: allRows }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    const errorMsg = String(err);
    console.error(`[ERROR] ${errorMsg}`);

    await Promise.all([
      writeLog(supabase, false, null, errorMsg, null),
      sendAlertEmail("❌ abundapp: błąd fetch-prices", errorMsg),
    ]);

    console.log("=== fetch-prices FAILED ===");
    return new Response(
      JSON.stringify({ success: false, error: errorMsg }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
