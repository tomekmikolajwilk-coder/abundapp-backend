import { createClient } from "npm:@supabase/supabase-js@2";
import {
  applyOutcomes,
  type AssetCandidate,
  type DamagedRecord,
  type FetchOutcome,
  pickAssets,
  REQUEST_SIZE,
} from "./logic.ts";

type PriceRow = {
  asset_id: string;
  price_usd: number;
  updated_at: string;
};

// Tylko Twelve Data — metale mają własną funkcję fetch-metals (Metals.Dev, limit 100 req/mies.,
// wolny cron co 2 dni). Tutaj kursor co 15 min + licznik awarii w damaged_assets.

// Jedna fabryka klienta — typ Supa pochodzi z tego samego wywołania co instancja,
// dzięki czemu generyki supabase-js zgadzają się we wszystkich helperach.
function getClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}
type Supa = ReturnType<typeof getClient>;

// ── Wczytanie stanu z bazy ──────────────────────────────────────────────────
// Zwraca kandydatów Twelve Data (z updated_at) i tabelę awarii. Metale tu nie wchodzą.
async function loadState(supabase: Supa): Promise<{
  twelveCandidates: AssetCandidate[];
  damaged: DamagedRecord[];
}> {
  const [defsRes, pricesRes, damagedRes] = await Promise.all([
    supabase.from("asset_definitions").select("asset_id, api_symbol")
      .eq("active", true).eq("api_source", "twelve_data"),
    supabase.from("price_cache").select("asset_id, updated_at"),
    supabase.from("damaged_assets").select("asset_id, fail_count, last_failed_at"),
  ]);

  if (defsRes.error) throw new Error(`Failed to load asset_definitions: ${defsRes.error.message}`);
  if (pricesRes.error) throw new Error(`Failed to load price_cache: ${pricesRes.error.message}`);
  if (damagedRes.error) throw new Error(`Failed to load damaged_assets: ${damagedRes.error.message}`);

  const updatedAt = new Map<string, string>(
    (pricesRes.data ?? []).map((r) => [r.asset_id as string, r.updated_at as string]),
  );

  const twelveCandidates: AssetCandidate[] = (defsRes.data ?? []).map((def) => ({
    asset_id: def.asset_id as string,
    api_symbol: def.api_symbol as string,
    updated_at: updatedAt.get(def.asset_id as string) ?? null,
  }));

  const damaged = (damagedRes.data ?? []) as DamagedRecord[];
  console.log(`[state] ${twelveCandidates.length} Twelve Data, ${damaged.length} w damaged_assets`);
  return { twelveCandidates, damaged };
}

// ── Twelve Data: jedno żądanie na ≤8 symboli, bez sleepów ────────────────────
// Zwraca pobrane ceny oraz asset_id których nie udało się pobrać (do licznika awarii).
async function fetchTwelveData(
  apiKey: string,
  selected: AssetCandidate[],
): Promise<{ rows: PriceRow[]; failed: string[]; errors: string[] }> {
  if (selected.length === 0) return { rows: [], failed: [], errors: [] };

  const symbols = selected.map((s) => s.api_symbol);
  console.log(`[TwelveData] Pobieram ${symbols.length}: ${symbols.join(", ")}`);

  try {
    const url = new URL("https://api.twelvedata.com/price");
    url.searchParams.set("symbol", symbols.join(","));
    url.searchParams.set("apikey", apiKey);

    const res = await fetch(url.toString());
    console.log(`[TwelveData] HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    // Dla jednego symbolu API zwraca {price:"..."}, dla wielu {SYMBOL:{price:"..."}}.
    const normalized: Record<string, { price?: string; code?: number; message?: string }> =
      symbols.length === 1 ? { [symbols[0]]: data } : data;

    const rows: PriceRow[] = [];
    const failed: string[] = [];
    const errors: string[] = [];
    const now = new Date().toISOString();

    for (const def of selected) {
      const val = normalized[def.api_symbol];
      if (val?.price != null && val.code == null) {
        rows.push({ asset_id: def.asset_id, price_usd: parseFloat(val.price), updated_at: now });
      } else {
        const msg = `TwelveData: ${def.api_symbol} (${def.asset_id}) — ${val?.message ?? `code ${val?.code}`}`;
        console.warn(`[TwelveData] ⚠️ ${msg}`);
        failed.push(def.asset_id);
        errors.push(msg);
      }
    }
    console.log(`[TwelveData] OK: ${rows.length}, błędy: ${failed.length}`);
    return { rows, failed, errors };
  } catch (err) {
    // Żądanie padło w całości — wszystkie wybrane assety liczymy jako nieudane.
    const msg = `TwelveData request: ${String(err)}`;
    console.error(`[TwelveData] ❌ ${msg}`);
    return { rows: [], failed: selected.map((s) => s.asset_id), errors: [msg] };
  }
}

async function sendAlertEmail(subject: string, body: string): Promise<void> {
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const alertEmail = Deno.env.get("ALERT_EMAIL");
  if (!resendKey || !alertEmail) {
    console.warn("[Email] Brak RESEND_API_KEY lub ALERT_EMAIL — pomijam wysyłkę");
    return;
  }
  console.log(`[Email] Wysyłam alert na ${alertEmail}: "${subject}"`);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "abundapp <onboarding@resend.dev>",
      to: alertEmail,
      subject,
      html: `<p><strong>Czas:</strong> ${new Date().toISOString()}</p><pre style="background:#f4f4f4;padding:12px;line-height:2">${body.split("\n").join("<br>")}</pre>`,
    }),
  });
  console.log(`[Email] Resend HTTP ${res.status}`);
}

async function writeLog(
  supabase: Supa,
  success: boolean,
  itemsProcessed: number | null,
  errorMessage: string | null,
  warnings: string | null,
): Promise<void> {
  const { error } = await supabase.from("cron_logs").insert({
    function_name: "fetch-prices",
    success,
    items_processed: itemsProcessed,
    error_message: errorMessage,
    warnings,
  });
  if (error) console.error(`[DB] Błąd zapisu cron_logs: ${error.message}`);
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
  const supabase = getClient();

  try {
    const twelveApiKey = Deno.env.get("TWELVE_DATA_API_KEY");
    if (!twelveApiKey) throw new Error("Brak TWELVE_DATA_API_KEY");

    const { twelveCandidates, damaged } = await loadState(supabase);

    // Kursor: 8 najstarszych Twelve Data assetów, z pominięciem uszkodzonych dzisiaj.
    const selected = pickAssets(twelveCandidates, damaged, now, REQUEST_SIZE);
    console.log(`[pick] ${selected.length}/${twelveCandidates.length}: ${selected.map((s) => s.asset_id).join(", ")}`);

    const twelve = await fetchTwelveData(twelveApiKey, selected);

    // Aktualizacja licznika awarii na podstawie wyniku Twelve Data.
    const failedSet = new Set(twelve.failed);
    const outcomes: FetchOutcome[] = selected.map((s) => ({ asset_id: s.asset_id, ok: !failedSet.has(s.asset_id) }));
    const { updates, alerts } = applyOutcomes(outcomes, damaged, now);
    await persistDamaged(supabase, updates);

    // Zapis cen.
    if (twelve.rows.length > 0) {
      const { error } = await supabase.from("price_cache").upsert(twelve.rows, { onConflict: "asset_id" });
      if (error) throw error;
      console.log(`[DB] price_cache: zapisano ${twelve.rows.length} kursów`);
    }

    const warningsText = twelve.errors.join("\n") || null;

    // Alert tylko gdy jakiś asset DOBIŁ limitu prób tego dnia (po MAX_FAILS_PER_DAY).
    // Zwykłe pojedyncze porażki idą do warnings w cron_logs — bez maila (to cel damaged_assets).
    if (alerts.length > 0) {
      const list = alerts.map((a) => `${a.asset_id} (${a.fail_count} prób)`).join(", ");
      const errMsg = `Assety z wyczerpanym limitem prób: ${list}`;
      console.error(`[ALERT] ${errMsg}`);
      await Promise.all([
        writeLog(supabase, false, twelve.rows.length, errMsg, warningsText),
        sendAlertEmail(
          `❌ abundapp: asset niedostępny (${list})`,
          `Następujące assety dobiły dziennego limitu prób pobrania:\n${list}\n\n` +
          `Zostały wykluczone z rotacji do północy UTC.\n\nOstatnie błędy:\n${warningsText ?? "—"}`,
        ),
      ]);
    } else {
      await writeLog(supabase, true, twelve.rows.length, null, warningsText);
    }

    console.log("=== fetch-prices DONE ===");
    return new Response(
      JSON.stringify({
        success: true,
        attempted: selected.map((s) => s.asset_id),
        updated: twelve.rows.length,
        failed: twelve.failed,
        alerts: alerts.map((a) => a.asset_id),
        warnings: twelve.errors,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const errorMsg = String(err);
    console.error(`[ERROR] ${errorMsg}`);
    await Promise.all([
      writeLog(supabase, false, null, errorMsg, null),
      sendAlertEmail("❌ abundapp: błąd fetch-prices", errorMsg),
    ]);
    console.log("=== fetch-prices FAILED ===");
    return new Response(
      JSON.stringify({ success: false, error: errorMsg }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
