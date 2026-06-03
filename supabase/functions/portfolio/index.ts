import { createClient } from "npm:@supabase/supabase-js@2";

type HoldingEntry = {
  asset_id: string;
  category: string;
  amount: number;         // ilość sztuk którą user posiada
  price_usd: number;      // aktualny kurs w USD
  value_usd: number;      // amount * price_usd
  value_ccy: number;      // wartość w preferred_currency usera (np. PLN)
  value_selected?: number; // wartość w walucie z ?currency=X — tylko jeśli podano
};

// GET /portfolio?user_id=UUID
// GET /portfolio?user_id=UUID&date=2026-01-01       → historyczny snapshot zamiast live
// GET /portfolio?user_id=UUID&currency=EUR          → dodatkowe przeliczenie na wybraną walutę
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

  // Jeśli user podał ?currency=X, sprawdzamy czy ta waluta istnieje w price_cache
  // i pobieramy jej kurs — posłuży do wyliczenia value_selected dla każdego aktywa.
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

  // ── HISTORYCZNY widok — dane z zapisanego snapshotu ────────────────────────
  if (dateParam) {
    const { data: snapshot, error: snapErr } = await supabase
      .from("portfolio_snapshots")
      .select("currency, holdings_breakdown, captured_at")
      .eq("user_id", userId)
      .eq("captured_at", dateParam)
      .single();

    if (snapErr || !snapshot) {
      return new Response(
        JSON.stringify({ error: `No snapshot found for date ${dateParam}` }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    let holdings = snapshot.holdings_breakdown as HoldingEntry[];

    // value_selected liczymy po AKTUALNYM kursie — snapshot nie przechowuje historycznych kursów
    // wszystkich walut, tylko preferred_currency usera z tamtego dnia.
    if (selectedCurrencyPrice !== null) {
      holdings = holdings.map((h) => ({
        ...h,
        value_selected: h.value_usd / selectedCurrencyPrice!,
      }));
    }

    console.log(
      `[portfolio] snapshot ${dateParam} — ${holdings.length} assets, currency=${snapshot.currency}`
    );
    console.log("=== portfolio DONE ===");

    return new Response(
      JSON.stringify({
        currency: snapshot.currency,
        captured_at: snapshot.captured_at,
        holdings_breakdown: holdings,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── LIVE widok — liczymy na bieżąco z profiles + price_cache ──────────────
  // Oba zapytania lecimy równolegle — nie ma powodu czekać na jedno przed drugim.
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

  // Zamieniamy tablicę z bazy na słownik asset_id → { price_usd, category }
  // żeby móc szybko wyszukiwać kurs po nazwie aktywa przy iteracji po holdings.
  const priceMap: Record<string, { price_usd: number; category: string }> = {};
  for (const p of pricesResult.data) {
    priceMap[p.asset_id] = { price_usd: p.price_usd, category: p.category };
  }

  // Kurs preferred_currency (np. PLN) potrzebny do przeliczenia value_usd → value_ccy.
  // Logika: 1 PLN = ccyPrice USD, więc X USD = X / ccyPrice PLN.
  const ccyPrice = priceMap[preferred_currency]?.price_usd ?? null;
  if (!ccyPrice) {
    console.warn(`[portfolio] preferred_currency ${preferred_currency} not found in price_cache`);
  }

  const breakdown: HoldingEntry[] = [];
  for (const [asset_id, amount] of Object.entries(holdings as Record<string, number>)) {
    const info = priceMap[asset_id];

    // Jeśli aktywo nie ma kursu w cache (np. nowy ticker jeszcze nie pobrany) — pomijamy je.
    // Nie failujemy całego requestu z powodu jednego brakującego kursu.
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

  console.log(
    `[portfolio] live — ${breakdown.length} assets, currency=${preferred_currency}`
  );
  console.log("=== portfolio DONE ===");

  return new Response(
    JSON.stringify({ currency: preferred_currency, holdings_breakdown: breakdown }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
