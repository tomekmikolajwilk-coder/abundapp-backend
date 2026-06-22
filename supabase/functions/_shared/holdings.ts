import type { HoldingEntry } from "./types.ts";
import type { PriceInfo } from "./pricing.ts";

// Wiersz z tabeli holdings w kształcie, w jakim czytają go /portfolio i snapshot-portfolio.
export type HoldingRow = {
  id: string;
  price_source: "market" | "manual";
  category: string;
  amount: number;
  asset_id: string | null;
  name: string | null;
  unit_value: number | null;
  currency: string | null;
  display_category: string | null;
  interest_rate: number | null;
  start_date: string | null;
};

const DAY_MS = 86_400_000;

// fx = ile USD kosztuje 1 jednostka danej waluty (price_usd z price_cache). USD = 1.
// null gdy waluty nie ma w price_cache (poza USD).
function fxRate(priceMap: Record<string, PriceInfo>, code: string): number | null {
  if (code === "USD") return 1;
  return priceMap[code]?.price_usd ?? null;
}

// Liniowe, deterministyczne naliczanie odsetek obligacji — liczone OD ZERA z liczby dni.
//   value = principal × (1 + rate/100 × dni/365)
// Idempotentne: nic nie inkrementujemy, więc pominięty albo podwójny cron nie ma znaczenia —
// wartość zawsze odtwarzana z principal + rate + start_date. days < 0 (data w przyszłości) → 0.
export function bondFactor(rate: number, startDate: string, now: Date): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const days = Math.max(0, Math.floor((now.getTime() - start) / DAY_MS));
  return 1 + (rate / 100) * (days / 365);
}

// Zamienia wiersze holdings na holdings_breakdown (wspólne dla /portfolio live i snapshotu).
// Dla manual price_usd to EFEKTYWNA cena jednostki w USD (z odsetkami dla obligacji),
// dzięki czemu niezmiennik value_usd = amount × price_usd trzyma się dla wszystkich klas.
export function buildBreakdown(
  rows: HoldingRow[],
  priceMap: Record<string, PriceInfo>,
  preferredCurrency: string,
  selectedCurrencyPrice: number | null,
  now: Date,
): { breakdown: HoldingEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const ccyPrice = fxRate(priceMap, preferredCurrency); // null → value_ccy = value_usd (fallback)
  const breakdown: HoldingEntry[] = [];

  for (const row of rows) {
    let priceUsd: number;
    let category = row.category;
    let interestRate: number | null = null;

    if (row.price_source === "market") {
      const info = priceMap[row.asset_id ?? ""];
      if (!info) {
        warnings.push(`Brak kursu dla ${row.asset_id}`);
        continue;
      }
      priceUsd = info.price_usd;
      category = info.category; // asset_definitions = źródło prawdy dla kategorii market
    } else {
      const fx = fxRate(priceMap, row.currency ?? "");
      if (fx === null) {
        warnings.push(`Brak kursu waluty ${row.currency} (holding ${row.id})`);
        continue;
      }
      let unit = row.unit_value as number;
      if (row.category === "bonds" && row.interest_rate != null && row.start_date) {
        unit *= bondFactor(row.interest_rate, row.start_date, now);
        interestRate = row.interest_rate;
      }
      priceUsd = unit * fx; // efektywna cena jednostki w USD (z odsetkami dla obligacji)
    }

    const valueUsd = row.amount * priceUsd;
    const valueCcy = ccyPrice != null ? valueUsd / ccyPrice : valueUsd;

    const entry: HoldingEntry = {
      id: row.id,
      asset_id: row.asset_id,
      category,
      amount: row.amount,
      price_usd: priceUsd,
      value_usd: valueUsd,
      value_ccy: valueCcy,
      price_source: row.price_source,
      name: row.price_source === "manual" ? row.name : null,
      display_category: row.display_category ?? null,
      interest_rate: interestRate,
    };
    if (selectedCurrencyPrice !== null) {
      entry.value_selected = valueUsd / selectedCurrencyPrice;
    }
    breakdown.push(entry);
  }

  return { breakdown, warnings };
}

// Kolumny tabeli holdings potrzebne do zbudowania breakdownu — jeden string SELECT,
// żeby /portfolio i snapshot-portfolio pytały o dokładnie ten sam kształt.
export const HOLDINGS_COLUMNS =
  "id, price_source, category, amount, asset_id, name, unit_value, currency, display_category, interest_rate, start_date";
