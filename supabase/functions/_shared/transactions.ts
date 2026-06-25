import type { Supa } from "./supabase.ts";

// Ledger przepływów. Wpis powstaje przy mutacji holdings (POST / PATCH amount / DELETE);
// rewaluacja manual (PATCH unit_value) to NIE transakcja. value_usd jest PODPISANA
// (+ buy, − sell), liczona z dodatniego amount × exec_price_usd.

export type TxnSide = "buy" | "sell";

// Minimalny kształt holdingu potrzebny do ustalenia ceny wykonania.
type PricedHolding = {
  price_source: string;
  asset_id: string | null;
  unit_value: number | null;
  currency: string | null;
};

// Cena 1 jednostki w USD w momencie transakcji.
//   market → kurs z price_cache (null gdy brak — np. uszkodzony asset).
//   manual → unit_value × fx waluty (USD=1; null gdy waluty nie ma w price_cache).
// unitValueOverride pozwala policzyć cenę po NOWYM unit_value, gdy PATCH zmienia
// jednocześnie amount i unit_value (delta ilości wykonuje się po cenie po rewaluacji).
export async function execPriceUsd(
  supabase: Supa,
  holding: PricedHolding,
  unitValueOverride?: number,
): Promise<number | null> {
  if (holding.price_source === "market") {
    if (!holding.asset_id) return null;
    const { data } = await supabase
      .from("price_cache").select("price_usd").eq("asset_id", holding.asset_id).single();
    return (data?.price_usd as number | undefined) ?? null;
  }

  const unit = unitValueOverride ?? holding.unit_value;
  if (unit == null) return null;
  if (holding.currency === "USD") return unit;

  const { data } = await supabase
    .from("price_cache").select("price_usd").eq("asset_id", holding.currency ?? "").single();
  const fx = data?.price_usd as number | undefined;
  return fx != null ? unit * fx : null;
}

// Wpis do ledgera. Best-effort: błąd logujemy, ale NIE wywracamy mutacji holdings
// (tak jak /portfolio traktuje zapis visit-snapshotu). Dla usera ważniejsze, że
// dodanie/edycja pozycji się udały, niż żeby pochodny ledger był zawsze kompletny.
export async function recordTransaction(
  supabase: Supa,
  args: {
    userId: string;
    holdingId: string | null;
    assetId: string | null;
    name: string | null;
    category: string;
    side: TxnSide;
    amount: number;        // dodatnia
    execPriceUsd: number;
  },
): Promise<void> {
  const signed = args.side === "buy" ? 1 : -1;
  const { error } = await supabase.from("transactions").insert({
    user_id: args.userId,
    holding_id: args.holdingId,
    asset_id: args.assetId,
    name: args.name,
    category: args.category,
    side: args.side,
    amount: args.amount,
    exec_price_usd: args.execPriceUsd,
    value_usd: signed * args.amount * args.execPriceUsd,
  });
  if (error) console.error(`[transactions] zapis wpisu nie powiódł się: ${error.message}`);
}
