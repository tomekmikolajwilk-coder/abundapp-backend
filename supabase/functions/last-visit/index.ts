import { createClient } from "npm:@supabase/supabase-js@2";

type HoldingEntry = {
  asset_id: string;
  category: string;
  amount: number;
  price_usd: number;
  value_usd: number;
  value_ccy: number;
  value_selected?: number;
};

// GET /last-visit?user_id=UUID
// GET /last-visit?user_id=UUID&currency=EUR
//
// Zwraca ostatni visit-snapshot — kiedy user ostatnio otworzył aplikację
// i jakie były wtedy wartości portfela. Frontend może porównać to z live
// żeby pokazać "od ostatniej wizyty portfel zmienił się o X%".
Deno.serve(async (req) => {
  console.log("=== last-visit START ===");

  const url = new URL(req.url);
  const userId = url.searchParams.get("user_id");
  const currencyParam = url.searchParams.get("currency")?.toUpperCase() ?? null;

  if (!userId) {
    return new Response(JSON.stringify({ error: "Missing user_id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Jeśli podano ?currency=X — walidujemy kategorię przez asset_definitions,
  // kurs pobieramy z price_cache.
  let selectedCurrencyPrice: number | null = null;
  if (currencyParam) {
    const [defResult, priceResult] = await Promise.all([
      supabase.from("asset_definitions").select("asset_id").eq("asset_id", currencyParam).eq("category", "currency").eq("active", true).single(),
      supabase.from("price_cache").select("price_usd").eq("asset_id", currencyParam).single(),
    ]);

    if (defResult.error || !defResult.data || priceResult.error || !priceResult.data) {
      return new Response(
        JSON.stringify({ error: `Currency ${currencyParam} not found` }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    selectedCurrencyPrice = priceResult.data.price_usd;
  }

  // Szukamy najnowszego snapshotu z wizyty usera.
  const { data: snapshot, error: snapErr } = await supabase
    .from("portfolio_snapshots")
    .select("currency, holdings_breakdown, captured_at")
    .eq("user_id", userId)
    .eq("source", "visit")
    .order("captured_at", { ascending: false })
    .limit(1)
    .single();

  if (snapErr || !snapshot) {
    return new Response(
      JSON.stringify({ error: "No visit snapshot found — user has not opened the app yet" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  let holdings = snapshot.holdings_breakdown as HoldingEntry[];

  if (selectedCurrencyPrice !== null) {
    holdings = holdings.map((h) => ({
      ...h,
      value_selected: h.value_usd / selectedCurrencyPrice!,
    }));
  }

  console.log(
    `[last-visit] user=${userId} last visit=${snapshot.captured_at} assets=${holdings.length}`
  );
  console.log("=== last-visit DONE ===");

  return new Response(
    JSON.stringify({
      currency: snapshot.currency,
      captured_at: snapshot.captured_at,   // kiedy user ostatnio otworzył apkę
      holdings_breakdown: holdings,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
