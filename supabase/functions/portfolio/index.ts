import { getServiceClient } from "../_shared/supabase.ts";
import { badRequest, json, notFound, serverError } from "../_shared/http.ts";
import { resolveSelectedCurrency } from "../_shared/currency.ts";
import { resolveUserId } from "../_shared/auth.ts";
import { buildPriceMap } from "../_shared/pricing.ts";
import { buildBreakdown, HOLDINGS_COLUMNS } from "../_shared/holdings.ts";
import type { HoldingEntry } from "../_shared/types.ts";

// GET /portfolio?user_id=UUID
// GET /portfolio?user_id=UUID&date=2026-06-03              → ostatni snapshot z tego dnia
// GET /portfolio?user_id=UUID&date=2026-06-03T10:30:00Z    → ostatni snapshot przed tym momentem
// GET /portfolio?user_id=UUID&currency=EUR                 → dodatkowe przeliczenie na EUR
Deno.serve(async (req) => {
 try {
  console.log("=== portfolio START ===");

  const url = new URL(req.url);
  const userId = resolveUserId(req);
  const dateParam = url.searchParams.get("date");
  const currencyParam = url.searchParams.get("currency")?.toUpperCase() ?? null;

  if (!userId) return badRequest("Missing user_id");

  console.log(
    `[portfolio] user_id=${userId} date=${dateParam ?? "live"} currency=${currencyParam ?? "none"}`
  );

  const supabase = getServiceClient();

  // Walidacja ?currency=X — musi być aktywną walutą; zwraca kurs USD lub null.
  const selected = await resolveSelectedCurrency(supabase, currencyParam);
  if (!selected.ok) return selected.error;
  const selectedCurrencyPrice = selected.price;

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

    if (snapErr || !snapshot) return notFound(`No snapshot found for date ${dateParam}`);

    let holdings = snapshot.holdings_breakdown as HoldingEntry[];

    if (selectedCurrencyPrice !== null) {
      holdings = holdings.map((h) => ({
        ...h,
        value_selected: h.value_usd / selectedCurrencyPrice,
      }));
    }

    console.log(
      `[portfolio] snapshot ${snapshot.captured_at} (${snapshot.source}) — ${holdings.length} assets`
    );
    console.log("=== portfolio DONE ===");

    return json({
      currency: snapshot.currency,
      captured_at: snapshot.captured_at,
      source: snapshot.source,
      holdings_breakdown: holdings,
    });
  }

  // ── LIVE: liczymy na bieżąco z holdings + price_cache + asset_definitions ──
  const [profileResult, pricesResult, holdingsResult] = await Promise.all([
    supabase.from("profiles").select("preferred_currency").eq("id", userId).single(),
    supabase.from("price_cache").select("asset_id, price_usd"),
    supabase.from("holdings").select(HOLDINGS_COLUMNS).eq("user_id", userId),
  ]);

  if (profileResult.error || !profileResult.data) return notFound("User profile not found");
  if (pricesResult.error || !pricesResult.data) return serverError("Failed to fetch prices");
  if (holdingsResult.error) return serverError("Failed to fetch holdings");

  const { preferred_currency } = profileResult.data;

  // Kategorie pobieramy TYLKO dla assetów z price_cache (zbiór ograniczony: trzymane +
  // krypto + waluty + metale), nie z całego katalogu — ten po cutoverze EODHD przekracza
  // domyślny limit 1000 wierszy PostgREST, przez co assety spoza pierwszego tysiąca dostawały
  // category="unknown". Bez .eq(active) — chcemy kategorię też dla ewentualnie wyłączonych.
  const priceIds = pricesResult.data.map((p) => p.asset_id as string);
  const defsResult = await supabase
    .from("asset_definitions").select("asset_id, category, display_name")
    .in("asset_id", priceIds.length > 0 ? priceIds : ["__none__"]);

  // Mapa asset_id → { price_usd, category } (category z asset_definitions — źródła prawdy).
  const priceMap = buildPriceMap(pricesResult.data, defsResult.data ?? []);

  const { breakdown, warnings } = buildBreakdown(
    holdingsResult.data ?? [],
    priceMap,
    preferred_currency,
    selectedCurrencyPrice,
    new Date(),
  );
  for (const w of warnings) console.warn(`[portfolio] ${w}`);

  // Zapisujemy snapshot wizyty — dokładnie jeden wiersz na usera. Pilnuje tego partial
  // unique index `(user_id) where source='visit'`, dlatego MUSIMY skasować poprzedni
  // ZANIM wstawimy nowy (insert-przed-delete złamałby ten index).
  //
  // Robimy to SYNCHRONICZNIE (await), nie w tle. Wcześniej szło to przez EdgeRuntime.waitUntil,
  // ale na cold-starcie runtime potrafił ubić workera tuż po wysłaniu odpowiedzi — delete się
  // commitował, insert już nie → user zostawał z ZEREM wierszy visit (i "PnL od ostatniej
  // wizyty" przestawał działać). Koszt to jeden dodatkowy round-trip do DB; w zamian zapis
  // jest pewny, a ewentualny błąd widać od razu w logach.
  const { error: delErr } = await supabase
    .from("portfolio_snapshots")
    .delete()
    .eq("user_id", userId)
    .eq("source", "visit");

  if (delErr) console.warn(`[portfolio] Nie udało się skasować starego visit snapshot: ${delErr.message}`);

  const { error: insErr } = await supabase.from("portfolio_snapshots").insert({
    user_id: userId,
    currency: preferred_currency,
    holdings_breakdown: breakdown,
    captured_at: new Date().toISOString(),
    source: "visit",
  });

  if (insErr) console.warn(`[portfolio] Nie udało się zapisać visit snapshot: ${insErr.message}`);
  else console.log(`[portfolio] Visit snapshot saved`);

  console.log(`[portfolio] live — ${breakdown.length} assets, currency=${preferred_currency}`);
  console.log("=== portfolio DONE ===");

  return json({ currency: preferred_currency, holdings_breakdown: breakdown });
 } catch (err) {
  // Bez tego runtime zwracał plain-text "Internal Server Error" (nie-JSON), co wywracało
  // smoke-test i jq. Łapiemy, logujemy i oddajemy spójny 500 { error } z treścią błędu.
  console.error(`[portfolio] ERROR: ${String(err)}`);
  return serverError(String(err));
 }
});
