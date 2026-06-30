import { getServiceClient } from "../_shared/supabase.ts";
import { json } from "../_shared/http.ts";
import { sendAlertEmail, writeCronLog } from "../_shared/alerts.ts";
import { buildPriceMap } from "../_shared/pricing.ts";
import { buildBreakdown, HOLDINGS_COLUMNS, type HoldingRow } from "../_shared/holdings.ts";

// Wywoływana przez pg_cron raz dziennie — zapisuje stan portfela wszystkich userów.
Deno.serve(async () => {
  console.log("=== snapshot-portfolio START ===");

  const supabase = getServiceClient();

  try {
    const [pricesResult, profilesResult, holdingsResult] = await Promise.all([
      supabase.from("price_cache").select("asset_id, price_usd"),
      supabase.from("profiles").select("id, preferred_currency"),
      supabase.from("holdings").select(`user_id, ${HOLDINGS_COLUMNS}`),
    ]);

    if (pricesResult.error || !pricesResult.data) {
      throw new Error(`Failed to fetch prices: ${pricesResult.error?.message}`);
    }
    if (profilesResult.error || !profilesResult.data) {
      throw new Error(`Failed to fetch profiles: ${profilesResult.error?.message}`);
    }
    if (holdingsResult.error || !holdingsResult.data) {
      throw new Error(`Failed to fetch holdings: ${holdingsResult.error?.message}`);
    }

    // Kategorie tylko dla assetów z price_cache (zbiór ograniczony), nie z całego katalogu —
    // po cutoverze EODHD katalog > 1000 wierszy = domyślny limit PostgREST → category="unknown"
    // dla assetów spoza pierwszego tysiąca.
    const priceIds = pricesResult.data.map((p) => p.asset_id as string);
    const defsResult = await supabase
      .from("asset_definitions").select("asset_id, category, display_name")
      .in("asset_id", priceIds.length > 0 ? priceIds : ["__none__"]);

    const profiles = profilesResult.data;
    console.log(`[snapshot] ${profiles.length} users, ${pricesResult.data.length} assets in price_cache`);

    // Grupujemy holdingi po user_id — jedna pętla zamiast pytania per user.
    const holdingsByUser = new Map<string, HoldingRow[]>();
    for (const row of holdingsResult.data as (HoldingRow & { user_id: string })[]) {
      const list = holdingsByUser.get(row.user_id) ?? [];
      list.push(row);
      holdingsByUser.set(row.user_id, list);
    }

    // Mapa asset_id → { price_usd, category } (category z asset_definitions — źródła prawdy).
    const priceMap = buildPriceMap(pricesResult.data, defsResult.data ?? []);

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayEnd = new Date(now);
    todayEnd.setUTCHours(23, 59, 59, 999);

    // Usuwamy poprzedni cron-snapshot z dzisiaj zanim zapiszemy nowy.
    // To zastępuje upsert — bo nie mamy już unique constraint na (user_id, captured_at).
    const { error: deleteError } = await supabase
      .from("portfolio_snapshots")
      .delete()
      .eq("source", "cron")
      .gte("captured_at", todayStart.toISOString())
      .lte("captured_at", todayEnd.toISOString());

    if (deleteError) console.warn(`[snapshot] Błąd usuwania starych cron-snaphotów: ${deleteError.message}`);

    const warnings: string[] = [];

    const snapshots = profiles.map((profile) => {
      const currency = profile.preferred_currency as string;
      const rows = holdingsByUser.get(profile.id) ?? [];

      const { breakdown, warnings: userWarnings } = buildBreakdown(rows, priceMap, currency, null, now);
      for (const w of userWarnings) {
        const msg = `User ${profile.id}: ${w}`;
        console.warn(`[snapshot] ⚠️ ${msg}`);
        warnings.push(msg);
      }

      return {
        user_id: profile.id,
        currency,
        holdings_breakdown: breakdown,
        captured_at: now.toISOString(),
        source: "cron",
      };
    });

    if (snapshots.length === 0) {
      console.log("[snapshot] Brak userów do snapshotu");
      await writeCronLog(supabase, "snapshot-portfolio", { success: true, itemsProcessed: 0, errorMessage: null, warnings: null });
      return json({ success: true, snapshots: 0 });
    }

    const { error: insertError } = await supabase
      .from("portfolio_snapshots")
      .insert(snapshots);

    if (insertError) throw insertError;

    console.log(`[snapshot] Inserted ${snapshots.length} snapshots`);

    const warningsText = warnings.length > 0 ? warnings.join("\n") : null;
    await writeCronLog(supabase, "snapshot-portfolio", { success: true, itemsProcessed: snapshots.length, errorMessage: null, warnings: warningsText });

    console.log("=== snapshot-portfolio DONE ===");
    return json({ success: true, snapshots: snapshots.length, warnings });
  } catch (err) {
    const errorMsg = String(err);
    console.error(`[snapshot] ERROR: ${errorMsg}`);
    await Promise.all([
      writeCronLog(supabase, "snapshot-portfolio", { success: false, itemsProcessed: null, errorMessage: errorMsg, warnings: null }),
      sendAlertEmail("❌ abundapp: błąd snapshot-portfolio", errorMsg),
    ]);
    console.log("=== snapshot-portfolio FAILED ===");
    return json({ success: false, error: errorMsg }, 500);
  }
});
