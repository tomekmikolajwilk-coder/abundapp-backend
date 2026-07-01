import { getServiceClient } from "../_shared/supabase.ts";
import { badRequest, json, notFound, serverError } from "../_shared/http.ts";
import { resolveUserId } from "../_shared/auth.ts";

// GET /transactions               → przepływy w preferred_currency usera
// GET /transactions?currency=EUR  → przepływy przeliczone na EUR
//
// JWT (claim `sub`) — bez fallbacku na ?user_id=. Lista malejąco po created_at.
// value_usd jest PODPISANA (+ buy, − sell); value_ccy = value_usd / fx (fx = ile USD
// kosztuje 1 jednostka waluty, USD=1), żeby front sumował przepływy w swojej walucie
// i policzył „ruch ceny = ΔWartość − Σ value_ccy".
Deno.serve(async (req) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return badRequest("Missing user_id");

    const currencyParam = new URL(req.url).searchParams.get("currency")?.toUpperCase() ?? null;
    const supabase = getServiceClient();

    // Waluta przeliczenia: ?currency=X, a bez niej preferred_currency usera.
    let currency = currencyParam;
    if (!currency) {
      const { data: profile, error } = await supabase
        .from("profiles").select("preferred_currency").eq("id", userId).single();
      if (error || !profile) return notFound("User profile not found");
      currency = profile.preferred_currency as string;
    }

    // fx = ile USD kosztuje 1 jednostka waluty (USD=1). Nieznana waluta → 400.
    let fx: number;
    if (currency === "USD") {
      fx = 1;
    } else {
      const { data: price, error } = await supabase
        .from("price_cache").select("price_usd").eq("asset_id", currency).single();
      if (error || !price) return badRequest(`Currency ${currency} not found`);
      fx = price.price_usd as number;
    }

    const { data: rows, error } = await supabase
      .from("transactions")
      // holding_id: front kluczuje pozycje MANUAL (asset_id=null) po id wiersza holdingu
      // — bez tego rozbicie PnL nie dopina transakcji obligacji/nieruchomości do pozycji.
      .select("id, holding_id, asset_id, name, category, side, amount, exec_price_usd, value_usd, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) return serverError(error.message);

    // Nazwy katalogowe dla pozycji market (ledger trzyma name=null dla market) — żeby lista
    // pokazywała „PKN Orlen", nie ticker „PKN.WAR". .in() na asset_id z transakcji (zbiór ograniczony).
    const assetIds = [
      ...new Set((rows ?? []).map((r) => r.asset_id).filter((a): a is string => !!a)),
    ];
    const nameMap: Record<string, string> = {};
    if (assetIds.length > 0) {
      const { data: defs } = await supabase
        .from("asset_definitions").select("asset_id, display_name").in("asset_id", assetIds);
      for (const d of defs ?? []) {
        if (d.display_name) nameMap[d.asset_id as string] = d.display_name as string;
      }
    }

    const transactions = (rows ?? []).map((t) => ({
      id: t.id,
      holding_id: t.holding_id,
      asset_id: t.asset_id,
      // manual = własna nazwa usera; market = katalogowy display_name (fallback ticker na froncie).
      name: t.name ?? (t.asset_id ? nameMap[t.asset_id as string] ?? null : null),
      category: t.category,
      side: t.side,
      amount: t.amount,
      exec_price_usd: t.exec_price_usd,
      value_usd: t.value_usd,
      value_ccy: (t.value_usd as number) / fx,  // zachowuje znak (sell ujemny)
      created_at: t.created_at,
    }));

    return json({ currency, transactions });
  } catch (err) {
    console.error(`[transactions] ERROR: ${String(err)}`);
    return serverError(String(err));
  }
});
