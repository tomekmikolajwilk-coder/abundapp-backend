import { getServiceClient, type Supa } from "../_shared/supabase.ts";
import { json } from "../_shared/http.ts";
import { sendAlertEmail, writeCronLog } from "../_shared/alerts.ts";
import { eodhdAssetId, eodhdTypeToCategory, EODHD_BASE, SUPPORTED_EODHD_EXCHANGES } from "../_shared/eodhd.ts";

// Mirror katalogu EODHD → asset_definitions. Demand-driven pricing (fetch-eod) i tak wycenia
// TYLKO trzymane aktywa, więc duży katalog jest darmowy (same metadane, zero kosztu wyceny).
// Dzięki temu picker = czysty lokalny search (pg_trgm) po WSZYSTKIM, co EODHD wspiera —
// bez calli do EODHD per wyszukanie, bez /discover, /request.
//
// Cron rzadki (np. raz w tygodniu) — lista EODHD zmienia się powoli (debiuty/delistingi).
// Bierzemy tylko typy Common Stock + ETF (reszta = FUND/Warrant/Preferred = szum).
// `?exchange=US` → tylko ta giełda (na wypadek timeoutu na pełnym przebiegu); brak → wszystkie.

const CHUNK = 1000; // wierszy na jeden upsert (PostgREST udźwignie, a nie zabija pamięci)

type SymbolRow = { Code: string; Name: string; Country?: string; Type: string };

async function syncExchange(supabase: Supa, apiKey: string, exch: string): Promise<{ upserted: number; error?: string }> {
  let list: SymbolRow[];
  try {
    const res = await fetch(`${EODHD_BASE}/exchange-symbol-list/${exch}?api_token=${apiKey}&fmt=json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    list = await res.json();
    if (!Array.isArray(list)) throw new Error("odpowiedź nie jest tablicą");
  } catch (err) {
    return { upserted: 0, error: `${exch}: ${String(err)}` };
  }

  // Filtr typów + budowa wierszy. asset_id = US bare / nie-US CODE.EXCHANGE (jak w eodhd.ts).
  const rows: Record<string, unknown>[] = [];
  for (const s of list) {
    const category = eodhdTypeToCategory(s.Type);
    if (!category || !s.Code || !s.Name) continue;
    rows.push({
      asset_id: eodhdAssetId(s.Code, exch),
      category,
      api_source: "eodhd",
      api_symbol: `${s.Code}.${exch}`, // EODHD nie czyta tego pola (NOT NULL); symbol EODHD jako placeholder
      display_name: s.Name,
      exchange: exch,
      country: s.Country ?? null,
      active: true,
    });
  }

  let upserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from("asset_definitions").upsert(chunk, { onConflict: "asset_id" });
    if (error) return { upserted, error: `${exch} upsert: ${error.message}` };
    upserted += chunk.length;
  }
  console.log(`[sync-catalog] ${exch}: ${upserted} (stock+etf z ${list.length})`);
  return { upserted };
}

Deno.serve(async (req) => {
  console.log("=== sync-catalog START ===");
  const supabase = getServiceClient();

  try {
    const apiKey = Deno.env.get("EODHD_API_KEY");
    if (!apiKey) throw new Error("Brak EODHD_API_KEY");

    const only = new URL(req.url).searchParams.get("exchange");
    const exchanges = only ? [only] : [...SUPPORTED_EODHD_EXCHANGES];

    let total = 0;
    const errors: string[] = [];
    for (const exch of exchanges) {
      const r = await syncExchange(supabase, apiKey, exch);
      total += r.upserted;
      if (r.error) errors.push(r.error);
    }

    const warnings = errors.length > 0 ? errors.join("\n") : null;
    await writeCronLog(supabase, "sync-catalog", {
      success: errors.length === 0,
      itemsProcessed: total,
      errorMessage: errors.length > 0 ? "Część giełd z błędem" : null,
      warnings,
    });
    // Błąd części giełd → mail (rzadki cron, brak ryzyka spamu).
    if (errors.length > 0) await sendAlertEmail("⚠️ abundapp: sync-catalog — błędy części giełd", warnings ?? "—");

    console.log(`=== sync-catalog DONE (${total} wierszy) ===`);
    return json({ success: errors.length === 0, upserted: total, errors });
  } catch (err) {
    const msg = String(err);
    console.error(`[ERROR] ${msg}`);
    await Promise.all([
      writeCronLog(supabase, "sync-catalog", { success: false, itemsProcessed: null, errorMessage: msg, warnings: null }),
      sendAlertEmail("❌ abundapp: błąd sync-catalog", msg),
    ]);
    return json({ success: false, error: msg }, 500);
  }
});
