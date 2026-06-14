import { getServiceClient } from "../_shared/supabase.ts";
import { badRequest, json, notFound } from "../_shared/http.ts";
import { resolveSelectedCurrency } from "../_shared/currency.ts";
import type { HoldingEntry } from "../_shared/types.ts";

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

  if (!userId) return badRequest("Missing user_id");

  const supabase = getServiceClient();

  // Walidacja ?currency=X — musi być aktywną walutą; zwraca kurs USD lub null.
  const selected = await resolveSelectedCurrency(supabase, currencyParam);
  if (!selected.ok) return selected.error;
  const selectedCurrencyPrice = selected.price;

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
    return notFound("No visit snapshot found — user has not opened the app yet");
  }

  let holdings = snapshot.holdings_breakdown as HoldingEntry[];

  if (selectedCurrencyPrice !== null) {
    holdings = holdings.map((h) => ({
      ...h,
      value_selected: h.value_usd / selectedCurrencyPrice,
    }));
  }

  console.log(
    `[last-visit] user=${userId} last visit=${snapshot.captured_at} assets=${holdings.length}`
  );
  console.log("=== last-visit DONE ===");

  return json({
    currency: snapshot.currency,
    captured_at: snapshot.captured_at,   // kiedy user ostatnio otworzył apkę
    holdings_breakdown: holdings,
  });
});
