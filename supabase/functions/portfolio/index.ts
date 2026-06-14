import { createClient } from "npm:@supabase/supabase-js@2";

// Globalny obiekt runtime'u Supabase Edge — pozwala dokończyć zadanie w tle po wysłaniu odpowiedzi.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

type HoldingEntry = {
  asset_id: string;
  category: string;
  amount: number;
  price_usd: number;
  value_usd: number;
  value_ccy: number;
  value_selected?: number;
};

// GET /portfolio?user_id=UUID
// GET /portfolio?user_id=UUID&date=2026-06-03              → ostatni snapshot z tego dnia
// GET /portfolio?user_id=UUID&date=2026-06-03T10:30:00Z    → ostatni snapshot przed tym momentem
// GET /portfolio?user_id=UUID&currency=EUR                 → dodatkowe przeliczenie na EUR
Deno.serve(async (req) => {
  console.log("=== portfolio START ===");

  const url = new URL(req.url);
  const userId = url.searchParams.get("user_id");
  const dateParam = url.searchParams.get("date");
  const currencyParam = url.searchParams.get("currency")?.toUpperCase() ?? null;

  if (!userId) {
    return new Response(JSON.stringify({ error: "Missing user_id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log(
    `[portfolio] user_id=${userId} date=${dateParam ?? "live"} currency=${currencyParam ?? "none"}`
  );

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Jeśli user podał ?currency=X, walidujemy że to waluta (nie np. akcja)
  // sprawdzając asset_definitions, a kurs pobieramy z price_cache.
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
    console.log(`[portfolio] selected currency ${currencyParam} = $${selectedCurrencyPrice} USD`);
  }

  // ── HISTORYCZNY: szukamy ostatniego snapshotu przed podanym momentem ──────
  if (dateParam) {
    // Jeśli podano samą datę (YYYY-MM-DD), szukamy do końca tego dnia.
    // Jeśli podano pełny timestamp, szukamy do tego dokładnego momentu.
    const before = dateParam.length === 10
      ? `${dateParam}T23:59:59.999Z`
      : dateParam;

    const { data: snapshot, error: snapErr } = await supabase
      .from("portfolio_snapshots")
      .select("currency, holdings_breakdown, captured_at, source")
      .eq("user_id", userId)
      .eq("source", "cron")              // tylko stabilne cron-snapshoty, nie visit
      .lte("captured_at", before)
      .order("captured_at", { ascending: false })
      .limit(1)
      .single();

    if (snapErr || !snapshot) {
      return new Response(
        JSON.stringify({ error: `No snapshot found for date ${dateParam}` }),
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
      `[portfolio] snapshot ${snapshot.captured_at} (${snapshot.source}) — ${holdings.length} assets`
    );
    console.log("=== portfolio DONE ===");

    return new Response(
      JSON.stringify({
        currency: snapshot.currency,
        captured_at: snapshot.captured_at,
        source: snapshot.source,
        holdings_breakdown: holdings,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── LIVE: liczymy na bieżąco z profiles + price_cache + asset_definitions ──
  const [profileResult, pricesResult, defsResult] = await Promise.all([
    supabase.from("profiles").select("preferred_currency, holdings").eq("id", userId).single(),
    supabase.from("price_cache").select("asset_id, price_usd"),
    supabase.from("asset_definitions").select("asset_id, category").eq("active", true),
  ]);

  if (profileResult.error || !profileResult.data) {
    return new Response(JSON.stringify({ error: "User profile not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (pricesResult.error || !pricesResult.data) {
    return new Response(JSON.stringify({ error: "Failed to fetch prices" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { preferred_currency, holdings } = profileResult.data;

  // category pochodzi z asset_definitions — źródła prawdy
  const categoryMap: Record<string, string> = {};
  for (const d of defsResult.data ?? []) {
    categoryMap[d.asset_id] = d.category;
  }

  const priceMap: Record<string, { price_usd: number; category: string }> = {};
  for (const p of pricesResult.data) {
    priceMap[p.asset_id] = { price_usd: p.price_usd, category: categoryMap[p.asset_id] ?? "unknown" };
  }

  const ccyPrice = priceMap[preferred_currency]?.price_usd ?? null;
  if (!ccyPrice) {
    console.warn(`[portfolio] preferred_currency ${preferred_currency} not found in price_cache`);
  }

  const breakdown: HoldingEntry[] = [];
  for (const [asset_id, amount] of Object.entries(holdings as Record<string, number>)) {
    const info = priceMap[asset_id];
    if (!info) {
      console.warn(`[portfolio] No price for ${asset_id}, skipping`);
      continue;
    }
    const value_usd = (amount as number) * info.price_usd;
    const value_ccy = ccyPrice != null ? value_usd / ccyPrice : value_usd;
    const entry: HoldingEntry = {
      asset_id,
      category: info.category,
      amount: amount as number,
      price_usd: info.price_usd,
      value_usd,
      value_ccy,
    };
    if (selectedCurrencyPrice !== null) {
      entry.value_selected = value_usd / selectedCurrencyPrice;
    }
    breakdown.push(entry);
  }

  // Zapisujemy snapshot wizyty — zawsze tylko jeden wiersz na usera (ostatnia wizyta).
  // Najpierw usuwamy poprzedni, potem wstawiamy nowy.
  // Tło — nie blokujemy odpowiedzi, błąd zapisu nie failuje requestu. EdgeRuntime.waitUntil
  // trzyma workera przy życiu aż delete+insert się dokończą; bez tego runtime ubija
  // niezakończoną promesę zaraz po response (gubiony visit-snapshot, zwłaszcza na cold-starcie).
  const saveVisitSnapshot = (async () => {
    await supabase
      .from("portfolio_snapshots")
      .delete()
      .eq("user_id", userId)
      .eq("source", "visit");

    const { error } = await supabase.from("portfolio_snapshots").insert({
      user_id: userId,
      currency: preferred_currency,
      holdings_breakdown: breakdown,
      captured_at: new Date().toISOString(),
      source: "visit",
    });

    if (error) console.warn(`[portfolio] Nie udało się zapisać visit snapshot: ${error.message}`);
    else console.log(`[portfolio] Visit snapshot saved`);
  })();

  // EdgeRuntime to globalny obiekt środowiska Supabase (poza nim — np. w testach — nie istnieje).
  if (typeof EdgeRuntime !== "undefined") {
    EdgeRuntime.waitUntil(saveVisitSnapshot);
  }

  console.log(`[portfolio] live — ${breakdown.length} assets, currency=${preferred_currency}`);
  console.log("=== portfolio DONE ===");

  return new Response(
    JSON.stringify({ currency: preferred_currency, holdings_breakdown: breakdown }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
