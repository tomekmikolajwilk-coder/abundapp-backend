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

  // Jeśli user podał ?currency=X, pobieramy jej kurs żeby wyliczyć value_selected.
  let selectedCurrencyPrice: number | null = null;
  if (currencyParam) {
    const { data: ccyRow, error: ccyErr } = await supabase
      .from("price_cache")
      .select("price_usd")
      .eq("asset_id", currencyParam)
      .eq("category", "currency")
      .single();

    if (ccyErr || !ccyRow) {
      return new Response(
        JSON.stringify({ error: `Currency ${currencyParam} not found in price_cache` }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    selectedCurrencyPrice = ccyRow.price_usd;
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
      .lte("captured_at", before)        // snapshot musi być przed (lub równy) podanemu momentowi
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

  // ── LIVE: liczymy na bieżąco z profiles + price_cache ─────────────────────
  const [profileResult, pricesResult] = await Promise.all([
    supabase.from("profiles").select("preferred_currency, holdings").eq("id", userId).single(),
    supabase.from("price_cache").select("asset_id, price_usd, category"),
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

  const priceMap: Record<string, { price_usd: number; category: string }> = {};
  for (const p of pricesResult.data) {
    priceMap[p.asset_id] = { price_usd: p.price_usd, category: p.category };
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

  // Zapisujemy snapshot wizyty — user otworzył aplikację, zapamiętujemy stan portfela.
  // Nie failujemy całego requestu jeśli zapis się nie uda — dane live są ważniejsze.
  const visitSnapshot = {
    user_id: userId,
    currency: preferred_currency,
    holdings_breakdown: breakdown,
    captured_at: new Date().toISOString(),
    source: "visit",
  };
  supabase.from("portfolio_snapshots").insert(visitSnapshot).then(({ error }) => {
    if (error) console.warn(`[portfolio] Nie udało się zapisać visit snapshot: ${error.message}`);
    else console.log(`[portfolio] Visit snapshot saved`);
  });

  console.log(`[portfolio] live — ${breakdown.length} assets, currency=${preferred_currency}`);
  console.log("=== portfolio DONE ===");

  return new Response(
    JSON.stringify({ currency: preferred_currency, holdings_breakdown: breakdown }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
