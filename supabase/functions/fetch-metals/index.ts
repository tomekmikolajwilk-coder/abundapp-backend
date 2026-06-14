import { getServiceClient, type Supa } from "../_shared/supabase.ts";
import { json } from "../_shared/http.ts";
import { sendAlertEmail, writeCronLog } from "../_shared/alerts.ts";
import type { PriceRow } from "../_shared/types.ts";

// Osobna funkcja dla metali, bo Metals.Dev ma limit 100 req/MIESIĄC — nie może jechać
// w 15-minutowej rotacji fetch-prices. Tu własny wolny cron (co 2 dni) i własny tor alertów:
// awaria metalu = mail od razu (przy cyklu co 2 dni nie ma ryzyka spamu, a licznik "3/dobę"
// z damaged_assets tu nie ma sensu — byłaby najwyżej 1 próba na 2 dni).

type MetalDef = { asset_id: string; api_symbol: string };

async function loadMetals(supabase: Supa): Promise<MetalDef[]> {
  const { data, error } = await supabase
    .from("asset_definitions")
    .select("asset_id, api_symbol")
    .eq("active", true)
    .eq("api_source", "metals_dev");
  if (error) throw new Error(`Failed to load metals: ${error.message}`);
  return (data ?? []).map((d) => ({ asset_id: d.asset_id as string, api_symbol: d.api_symbol as string }));
}

async function fetchMetalsDev(
  apiKey: string,
  metals: MetalDef[],
): Promise<{ rows: PriceRow[]; errors: string[] }> {
  const rows: PriceRow[] = [];
  const errors: string[] = [];
  const now = new Date().toISOString();
  console.log(`[MetalsDev] Pobieram metale: ${metals.map((m) => m.api_symbol).join(", ")}`);

  const settled = await Promise.allSettled(
    metals.map(async (m) => {
      const url = new URL("https://api.metals.dev/v1/metal/spot");
      url.searchParams.set("api_key", apiKey);
      url.searchParams.set("metal", m.api_symbol);
      url.searchParams.set("currency", "USD");

      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.status !== "success") throw new Error(data.message ?? "unknown error");
      return { asset_id: m.asset_id, price_usd: data.rate.price as number, updated_at: now };
    }),
  );

  settled.forEach((result, i) => {
    if (result.status === "fulfilled") rows.push(result.value);
    else {
      const msg = `MetalsDev: ${metals[i].api_symbol} (${metals[i].asset_id}) — ${result.reason}`;
      console.warn(`[MetalsDev] ⚠️ ${msg}`);
      errors.push(msg);
    }
  });

  console.log(`[MetalsDev] OK: ${rows.length}, błędy: ${errors.length}`);
  return { rows, errors };
}

Deno.serve(async () => {
  console.log("=== fetch-metals START ===");
  const supabase = getServiceClient();

  try {
    const metalsApiKey = Deno.env.get("METALS_DEV_API_KEY");
    if (!metalsApiKey) throw new Error("Brak METALS_DEV_API_KEY");

    const metals = await loadMetals(supabase);
    const { rows, errors } = await fetchMetalsDev(metalsApiKey, metals);

    if (rows.length > 0) {
      const { error } = await supabase.from("price_cache").upsert(rows, { onConflict: "asset_id" });
      if (error) throw error;
      console.log(`[DB] price_cache: zapisano ${rows.length} kursów`);
    }

    const warningsText = errors.length > 0 ? errors.join("\n") : null;

    if (errors.length > 0 && rows.length === 0) {
      // Totalna porażka — żaden metal się nie pobrał.
      await Promise.all([
        writeCronLog(supabase, "fetch-metals", { success: false, itemsProcessed: 0, errorMessage: "Nie pobrano żadnego metalu", warnings: warningsText }),
        sendAlertEmail("❌ abundapp: błąd fetch-metals (0 metali)", warningsText ?? "—"),
      ]);
    } else if (errors.length > 0) {
      // Część metali padła — mail od razu (cykl co 2 dni, brak spamu).
      await Promise.all([
        writeCronLog(supabase, "fetch-metals", { success: true, itemsProcessed: rows.length, errorMessage: null, warnings: warningsText }),
        sendAlertEmail(
          `⚠️ abundapp: błąd pobierania metali (${errors.length})`,
          `Metale, których nie udało się pobrać:\n${warningsText}`,
        ),
      ]);
    } else {
      await writeCronLog(supabase, "fetch-metals", { success: true, itemsProcessed: rows.length, errorMessage: null, warnings: null });
    }

    console.log("=== fetch-metals DONE ===");
    return json({ success: true, updated: rows.length, warnings: errors });
  } catch (err) {
    const errorMsg = String(err);
    console.error(`[ERROR] ${errorMsg}`);
    await Promise.all([
      writeCronLog(supabase, "fetch-metals", { success: false, itemsProcessed: null, errorMessage: errorMsg, warnings: null }),
      sendAlertEmail("❌ abundapp: błąd fetch-metals", errorMsg),
    ]);
    console.log("=== fetch-metals FAILED ===");
    return json({ success: false, error: errorMsg }, 500);
  }
});
