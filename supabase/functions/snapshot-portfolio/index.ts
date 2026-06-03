import { createClient } from "npm:@supabase/supabase-js@2";

type HoldingEntry = {
  asset_id: string;
  category: string;
  amount: number;
  price_usd: number;  // kurs z dnia snapshotu — dzięki temu historia jest wierna
  value_usd: number;
  value_ccy: number;  // wartość w preferred_currency usera z dnia snapshotu
};

// Wywoływana przez pg_cron raz dziennie — zapisuje stan portfela każdego usera.
// Dzięki temu nawet jeśli user nie logował się przez miesiąc, może zobaczyć historię.
Deno.serve(async () => {
  console.log("=== snapshot-portfolio START ===");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // Pobieramy ceny i profile równolegle — oba są potrzebne do kalkulacji.
    const [pricesResult, profilesResult] = await Promise.all([
      supabase.from("price_cache").select("asset_id, price_usd, category"),
      supabase.from("profiles").select("id, preferred_currency, holdings"),
    ]);

    if (pricesResult.error || !pricesResult.data) {
      throw new Error(`Failed to fetch prices: ${pricesResult.error?.message}`);
    }
    if (profilesResult.error || !profilesResult.data) {
      throw new Error(`Failed to fetch profiles: ${profilesResult.error?.message}`);
    }

    const prices = pricesResult.data;
    const profiles = profilesResult.data;

    console.log(`[snapshot] ${profiles.length} users, ${prices.length} assets in price_cache`);

    // Słownik asset_id → kurs — żeby szybko wyszukiwać przy iteracji po holdings każdego usera.
    const priceMap: Record<string, { price_usd: number; category: string }> = {};
    for (const p of prices) {
      priceMap[p.asset_id] = { price_usd: p.price_usd, category: p.category };
    }

    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

    // Dla każdego usera budujemy snapshot z wykalkulowanymi wartościami.
    const snapshots = profiles.map((profile) => {
      const currency = profile.preferred_currency as string;
      const holdings = profile.holdings as Record<string, number>;

      // Kurs preferred_currency usera potrzebny do przeliczenia value_usd → value_ccy.
      const ccyPrice = priceMap[currency]?.price_usd ?? null;
      if (!ccyPrice) {
        console.warn(`[snapshot] Currency ${currency} not in price_cache for user ${profile.id}`);
      }

      const breakdown: HoldingEntry[] = [];
      for (const [asset_id, amount] of Object.entries(holdings)) {
        const info = priceMap[asset_id];

        // Pomijamy aktywa bez kursu — nie blokujemy snapshotu z powodu jednego brakującego tickera.
        if (!info) {
          console.warn(`[snapshot] No price for ${asset_id} (user ${profile.id}), skipping`);
          continue;
        }

        const value_usd = amount * info.price_usd;
        const value_ccy = ccyPrice != null ? value_usd / ccyPrice : value_usd;

        breakdown.push({
          asset_id,
          category: info.category,
          amount,
          price_usd: info.price_usd, // zapisujemy kurs z dzisiaj — historyczne snapshoty będą wiarygodne
          value_usd,
          value_ccy,
        });
      }

      return {
        user_id: profile.id,
        currency,
        holdings_breakdown: breakdown,
        captured_at: today,
      };
    });

    if (snapshots.length === 0) {
      console.log("[snapshot] No users to snapshot");
      return new Response(
        JSON.stringify({ success: true, snapshots: 0, date: today }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Upsert zamiast insert — jeśli cron odpalił się dwa razy tego samego dnia,
    // nadpisujemy snapshot zamiast rzucać błąd o duplikacie.
    const { error: upsertError } = await supabase
      .from("portfolio_snapshots")
      .upsert(snapshots, { onConflict: "user_id,captured_at" });

    if (upsertError) throw upsertError;

    console.log(`[snapshot] Upserted ${snapshots.length} snapshots for ${today}`);
    console.log("=== snapshot-portfolio DONE ===");

    return new Response(
      JSON.stringify({ success: true, snapshots: snapshots.length, date: today }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    const errorMsg = String(err);
    console.error(`[snapshot] ERROR: ${errorMsg}`);
    console.log("=== snapshot-portfolio FAILED ===");

    return new Response(
      JSON.stringify({ success: false, error: errorMsg }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
