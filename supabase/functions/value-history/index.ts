import { getServiceClient } from "../_shared/supabase.ts";
import { badRequest, json, notFound, serverError } from "../_shared/http.ts";
import { resolveSelectedCurrency } from "../_shared/currency.ts";
import { resolveUserId } from "../_shared/auth.ts";
import type { HoldingEntry } from "../_shared/types.ts";

type Point = {
  date: string;
  value: number;
  value_selected?: number;
};

// GET /value-history?user_id=UUID
// GET /value-history?user_id=UUID&category_id=crypto   → tylko aktywa z tej kategorii
// GET /value-history?user_id=UUID&asset_id=BTC         → tylko konkretny asset
// GET /value-history?user_id=UUID&currency=EUR         → dodaje value_selected per punkt
// GET /value-history?user_id=UUID&from=2026-01-01&to=2026-03-31
//
// Zwraca szereg czasowy wartości portfela z cron-snapszotów.
// value = suma value_ccy (waluta preferowana usera) po przefiltrowanych holdingach.
// Zamiast N requestów ?date=... frontend dostaje wszystko naraz.
Deno.serve(async (req) => {
  console.log("=== value-history START ===");

  const url = new URL(req.url);
  const userId = resolveUserId(req, url);
  const categoryParam = url.searchParams.get("category_id");
  const assetIdParam = url.searchParams.get("asset_id");
  const currencyParam = url.searchParams.get("currency")?.toUpperCase() ?? null;
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  if (!userId) return badRequest("Missing user_id");

  const supabase = getServiceClient();

  // Walidacja ?currency=X — musi być walutą (nie krypto/akcją); zwraca kurs USD lub null.
  const selected = await resolveSelectedCurrency(supabase, currencyParam);
  if (!selected.ok) return selected.error;
  const selectedCurrencyPrice = selected.price;

  // Sprawdzamy czy user istnieje — potrzebujemy preferred_currency do opisu osi.
  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("preferred_currency")
    .eq("id", userId)
    .single();

  if (profileErr || !profile) return notFound("User profile not found");

  // Pobieramy cron-snapshoty w żądanym przedziale czasowym.
  let query = supabase
    .from("portfolio_snapshots")
    .select("captured_at, holdings_breakdown")
    .eq("user_id", userId)
    .eq("source", "cron")
    .order("captured_at", { ascending: true });

  if (fromParam) query = query.gte("captured_at", `${fromParam}T00:00:00Z`);
  if (toParam)   query = query.lte("captured_at", `${toParam}T23:59:59.999Z`);

  const { data: snapshots, error: snapErr } = await query;

  if (snapErr) return serverError("Failed to fetch snapshots");

  // Budujemy punkty wykresu — jeden punkt na dzień.
  const points: Point[] = (snapshots ?? []).map((snap) => {
    const holdings = snap.holdings_breakdown as HoldingEntry[];

    // Filtrujemy po categorii lub konkretnym assecie.
    const filtered = holdings.filter((h) => {
      if (assetIdParam)  return h.asset_id === assetIdParam;
      if (categoryParam) return h.category === categoryParam;
      return true;
    });

    const totalValueCcy = filtered.reduce((sum, h) => sum + h.value_ccy, 0);
    const totalValueUsd = filtered.reduce((sum, h) => sum + h.value_usd, 0);

    const point: Point = {
      date:  snap.captured_at.split("T")[0],
      value: Math.round(totalValueCcy * 100) / 100,
    };

    if (selectedCurrencyPrice !== null) {
      point.value_selected = Math.round(totalValueUsd / selectedCurrencyPrice * 100) / 100;
    }

    return point;
  });

  console.log(
    `[value-history] user=${userId} points=${points.length}` +
    (categoryParam ? ` category=${categoryParam}` : "") +
    (assetIdParam  ? ` asset_id=${assetIdParam}` : "") +
    (fromParam     ? ` from=${fromParam}` : "") +
    (toParam       ? ` to=${toParam}` : "")
  );
  console.log("=== value-history DONE ===");

  return json({
    currency: profile.preferred_currency,
    points,
  });
});
