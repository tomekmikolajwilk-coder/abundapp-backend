import type { Supa } from "./supabase.ts";
import { badRequest } from "./http.ts";

// Wynik walidacji parametru ?currency=X:
//   ok=true, price=null   → nie podano waluty (brak przeliczenia value_selected)
//   ok=true, price=number → poprawna waluta, kurs USD pobrany
//   ok=false              → niepoprawna waluta, gotowa odpowiedź 400 do zwrócenia
export type CurrencyResult =
  | { ok: true; price: number | null }
  | { ok: false; error: Response };

// Sprawdza, że ?currency=X to faktycznie aktywna waluta (kategoria 'currency' w asset_definitions),
// i zwraca jej kurs USD z price_cache. Wspólne dla /portfolio, /last-visit, /value-history.
export async function resolveSelectedCurrency(
  supabase: Supa,
  param: string | null,
): Promise<CurrencyResult> {
  if (!param) return { ok: true, price: null };

  // USD = waluta bazowa: nie ma jej w asset_definitions/price_cache, kurs = 1 z definicji.
  // Bez tego /portfolio?currency=USD (i /last-visit, /value-history) zwracało 400, mimo że
  // front celowo oferuje USD w pickerze. /transactions obsługiwało USD osobno — teraz spójnie.
  if (param === "USD") return { ok: true, price: 1 };

  const [defResult, priceResult] = await Promise.all([
    supabase.from("asset_definitions").select("asset_id")
      .eq("asset_id", param).eq("category", "currency").eq("active", true).single(),
    supabase.from("price_cache").select("price_usd").eq("asset_id", param).single(),
  ]);

  if (defResult.error || !defResult.data || priceResult.error || !priceResult.data) {
    return { ok: false, error: badRequest(`Currency ${param} not found`) };
  }
  return { ok: true, price: priceResult.data.price_usd as number };
}
