import { getServiceClient } from "../_shared/supabase.ts";
import { json } from "../_shared/http.ts";
import { sendAlertEmail, writeCronLog } from "../_shared/alerts.ts";
import { buildPriceMap } from "../_shared/pricing.ts";
import type { HoldingEntry } from "../_shared/types.ts";

// Wywoływana przez pg_cron raz dziennie — zapisuje stan portfela wszystkich userów.
Deno.serve(async () => {
  console.log("=== snapshot-portfolio START ===");

  const supabase = getServiceClient();

  try {
    const [pricesResult, profilesResult, defsResult] = await Promise.all([
      supabase.from("price_cache").select("asset_id, price_usd"),
      supabase.from("profiles").select("id, preferred_currency, holdings"),
      supabase.from("asset_definitions").select("asset_id, category").eq("active", true),
    ]);

    if (pricesResult.error || !pricesResult.data) {
      throw new Error(`Failed to fetch prices: ${pricesResult.error?.message}`);
    }
    if (profilesResult.error || !profilesResult.data) {
      throw new Error(`Failed to fetch profiles: ${profilesResult.error?.message}`);
    }

    const profiles = profilesResult.data;
    console.log(`[snapshot] ${profiles.length} users, ${pricesResult.data.length} assets in price_cache`);

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
      const holdings = profile.holdings as Record<string, number>;
      const ccyPrice = priceMap[currency]?.price_usd ?? null;

      if (!ccyPrice) {
        const w = `User ${profile.id}: currency ${currency} not in price_cache`;
        console.warn(`[snapshot] ⚠️ ${w}`);
        warnings.push(w);
      }

      const breakdown: HoldingEntry[] = [];
      for (const [asset_id, amount] of Object.entries(holdings)) {
        const info = priceMap[asset_id];
        if (!info) {
          const w = `User ${profile.id}: brak kursu dla ${asset_id}`;
          console.warn(`[snapshot] ⚠️ ${w}`);
          warnings.push(w);
          continue;
        }
        const value_usd = amount * info.price_usd;
        const value_ccy = ccyPrice != null ? value_usd / ccyPrice : value_usd;
        breakdown.push({ asset_id, category: info.category, amount, price_usd: info.price_usd, value_usd, value_ccy });
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
