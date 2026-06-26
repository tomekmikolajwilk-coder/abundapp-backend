import { getServiceClient, type Supa } from "../_shared/supabase.ts";
import { json } from "../_shared/http.ts";
import { sendAlertEmail, writeCronLog } from "../_shared/alerts.ts";
import type { PriceRow } from "../_shared/types.ts";
import { getProvider } from "../_shared/price_providers/index.ts";
import {
  applyOutcomes,
  type AssetCandidate,
  type DamagedRecord,
  type FetchOutcome,
  pickAssets,
} from "./logic.ts";

// Silnik rotacji cen — DEMAND-DRIVEN: pobiera tylko aktywa, które ktoś faktycznie trzyma
// (∪ holdings market wszystkich userów), nie cały katalog. Kandydaci grupowani per api_source;
// każdy provider ma własny kursor i budżet (batchSize). Sam request siedzi w providerze
// (_shared/price_providers), wspólna logika kursora/awarii w logic.ts.
//
// Źródła z własną funkcją (coingecko → fetch-crypto, metals_dev → fetch-metals) nie mają
// providera w rejestrze, więc trzymane aktywa z tych źródeł rotacja po prostu pomija.

// ── Wczytanie stanu z bazy ──────────────────────────────────────────────────
// Kandydaci = DISTINCT asset_id z holdings (price_source='market') ∩ aktywne asset_definitions,
// z updated_at z price_cache. Pogrupowani per api_source (klucz rejestru providerów).
async function loadState(supabase: Supa): Promise<{
  groups: Map<string, AssetCandidate[]>;
  damaged: DamagedRecord[];
}> {
  const [heldRes, defsRes, pricesRes, damagedRes] = await Promise.all([
    supabase.from("holdings").select("asset_id").eq("price_source", "market").not("asset_id", "is", null),
    supabase.from("asset_definitions").select("asset_id, api_source, api_symbol, category").eq("active", true),
    supabase.from("price_cache").select("asset_id, updated_at"),
    supabase.from("damaged_assets").select("asset_id, fail_count, last_failed_at"),
  ]);

  if (heldRes.error) throw new Error(`Failed to load holdings: ${heldRes.error.message}`);
  if (defsRes.error) throw new Error(`Failed to load asset_definitions: ${defsRes.error.message}`);
  if (pricesRes.error) throw new Error(`Failed to load price_cache: ${pricesRes.error.message}`);
  if (damagedRes.error) throw new Error(`Failed to load damaged_assets: ${damagedRes.error.message}`);

  // asset_id → {api_source, api_symbol} (tylko aktywne definicje).
  const defById = new Map(
    (defsRes.data ?? []).map((d) => [
      d.asset_id as string,
      { api_source: d.api_source as string, api_symbol: d.api_symbol as string },
    ]),
  );
  const updatedAt = new Map<string, string>(
    (pricesRes.data ?? []).map((r) => [r.asset_id as string, r.updated_at as string]),
  );

  // Kandydaci = trzymane aktywa (demand-driven) ∪ wszystkie aktywne waluty. Waluty bierzemy
  // niezależnie od holdings, bo to FX-szkielet każdej konwersji portfela (preferred_currency,
  // ?currency=) — gdyby leciały tylko gdy ktoś je „trzyma", przeliczenia robiłyby się nieświeże.
  const heldIds = new Set((heldRes.data ?? []).map((h) => h.asset_id as string));
  const fxIds = (defsRes.data ?? []).filter((d) => d.category === "currency").map((d) => d.asset_id as string);
  const candidateIds = new Set([...heldIds, ...fxIds]);

  const groups = new Map<string, AssetCandidate[]>();
  for (const asset_id of candidateIds) {
    const def = defById.get(asset_id);
    if (!def) continue; // trzymane, ale definicja nieaktywna/usunięta → pomijamy
    const candidate: AssetCandidate = {
      asset_id,
      api_symbol: def.api_symbol,
      updated_at: updatedAt.get(asset_id) ?? null,
    };
    const arr = groups.get(def.api_source);
    if (arr) arr.push(candidate);
    else groups.set(def.api_source, [candidate]);
  }

  const damaged = (damagedRes.data ?? []) as DamagedRecord[];
  const summary = [...groups].map(([s, c]) => `${s}:${c.length}`).join(", ") || "—";
  console.log(`[state] trzymane wg źródła: ${summary}; ${damaged.length} w damaged_assets`);
  return { groups, damaged };
}

// Zapisuje do damaged_assets decyzje z applyOutcomes: kasuje wpisy po sukcesie, upsertuje liczniki po porażce.
async function persistDamaged(
  supabase: Supa,
  updates: ReturnType<typeof applyOutcomes>["updates"],
): Promise<void> {
  const toClear = updates.filter((u) => u.op === "clear").map((u) => u.asset_id);
  const toSet = updates
    .filter((u): u is { op: "set"; asset_id: string; fail_count: number; last_failed_at: string } => u.op === "set")
    .map(({ asset_id, fail_count, last_failed_at }) => ({ asset_id, fail_count, last_failed_at }));

  const ops: PromiseLike<unknown>[] = [];
  if (toClear.length > 0) ops.push(supabase.from("damaged_assets").delete().in("asset_id", toClear));
  if (toSet.length > 0) ops.push(supabase.from("damaged_assets").upsert(toSet, { onConflict: "asset_id" }));
  await Promise.all(ops);
}

Deno.serve(async () => {
  console.log("=== fetch-prices START ===");
  const now = new Date();
  const supabase = getServiceClient();

  try {
    const { groups, damaged } = await loadState(supabase);

    // Per provider: własny kursor (pickAssets z jego budżetem) + własny request (fetchBatch).
    const allSelected: AssetCandidate[] = [];
    const allRows: PriceRow[] = [];
    const allFailed: string[] = [];
    const allErrors: string[] = [];

    for (const [source, candidates] of groups) {
      const provider = getProvider(source);
      if (!provider) {
        // Źródło z własną funkcją (coingecko/metals_dev) — nie rotujemy go tutaj.
        console.log(`[skip] ${source}: brak providera w rejestrze (${candidates.length} aktywów) — własna funkcja`);
        continue;
      }
      const selected = pickAssets(candidates, damaged, now, provider.batchSize);
      console.log(`[pick] ${source}: ${selected.length}/${candidates.length}: ${selected.map((s) => s.asset_id).join(", ")}`);
      if (selected.length === 0) continue;

      const res = await provider.fetchBatch(selected);
      allSelected.push(...selected);
      allRows.push(...res.rows);
      allFailed.push(...res.failed);
      allErrors.push(...res.errors);
    }

    // Aktualizacja licznika awarii na podstawie wyników wszystkich providerów.
    const failedSet = new Set(allFailed);
    const outcomes: FetchOutcome[] = allSelected.map((s) => ({ asset_id: s.asset_id, ok: !failedSet.has(s.asset_id) }));
    const { updates, alerts } = applyOutcomes(outcomes, damaged, now);
    await persistDamaged(supabase, updates);

    // Zapis cen.
    if (allRows.length > 0) {
      const { error } = await supabase.from("price_cache").upsert(allRows, { onConflict: "asset_id" });
      if (error) throw error;
      console.log(`[DB] price_cache: zapisano ${allRows.length} kursów`);
    }

    const warningsText = allErrors.join("\n") || null;

    // Alert tylko gdy jakiś asset DOBIŁ limitu prób tego dnia (po MAX_FAILS_PER_DAY).
    // Zwykłe pojedyncze porażki idą do warnings w cron_logs — bez maila (to cel damaged_assets).
    if (alerts.length > 0) {
      const list = alerts.map((a) => `${a.asset_id} (${a.fail_count} prób)`).join(", ");
      const errMsg = `Assety z wyczerpanym limitem prób: ${list}`;
      console.error(`[ALERT] ${errMsg}`);
      await Promise.all([
        writeCronLog(supabase, "fetch-prices", { success: false, itemsProcessed: allRows.length, errorMessage: errMsg, warnings: warningsText }),
        sendAlertEmail(
          `❌ abundapp: asset niedostępny (${list})`,
          `Następujące assety dobiły dziennego limitu prób pobrania:\n${list}\n\n` +
          `Zostały wykluczone z rotacji do północy UTC.\n\nOstatnie błędy:\n${warningsText ?? "—"}`,
        ),
      ]);
    } else {
      await writeCronLog(supabase, "fetch-prices", { success: true, itemsProcessed: allRows.length, errorMessage: null, warnings: warningsText });
    }

    console.log("=== fetch-prices DONE ===");
    return json({
      success: true,
      attempted: allSelected.map((s) => s.asset_id),
      updated: allRows.length,
      failed: allFailed,
      alerts: alerts.map((a) => a.asset_id),
      warnings: allErrors,
    });
  } catch (err) {
    const errorMsg = String(err);
    console.error(`[ERROR] ${errorMsg}`);
    await Promise.all([
      writeCronLog(supabase, "fetch-prices", { success: false, itemsProcessed: null, errorMessage: errorMsg, warnings: null }),
      sendAlertEmail("❌ abundapp: błąd fetch-prices", errorMsg),
    ]);
    console.log("=== fetch-prices FAILED ===");
    return json({ success: false, error: errorMsg }, 500);
  }
});
