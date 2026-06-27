import { getServiceClient, type Supa } from "../_shared/supabase.ts";
import { json } from "../_shared/http.ts";
import { sendAlertEmail, writeCronLog } from "../_shared/alerts.ts";
import type { PriceRow } from "../_shared/types.ts";

// Źródło cen akcji/ETF/FX z EODHD (zastępuje Twelve Data). Osobna funkcja standalone, bo model
// jest inny niż rotacja TD: dane EOD (raz dziennie), pobierane BULKIEM per giełda. Patrz
// docs/PRICING_REDESIGN.md (Faza 4). Krypto (CoinGecko) i metale (Metals.Dev) bez zmian.
//
// Model błędów (turbo prosty, cron co godzinę — pełny run za każdym razem):
//   - FX nie pobrane CAŁY dzień → mail.
//   - trzymany ticker nie pobrany CAŁY dzień → mail.
//   - transient (jeden run padł) → cicho, następny run za godzinę ponawia.
// „Cały dzień" wykrywamy z price_cache.updated_at (audyt w runie o 23:00 UTC) — bez nowej tabeli.
//
// EODHD api_symbol NIE jest czytany — wyprowadzamy go z metadanych (exchange/country/category).
// Dzięki temu kolumna api_symbol zostaje w formacie TD → revert do TD = sam flip api_source.

const AUDIT_HOUR_UTC = 23; // w tym runie sprawdzamy „co nie weszło cały dzień" i mailujemy

// Mapowanie giełdy (asset_definitions.exchange) → kod bulk EODHD + waluta notowania.
// pence=true: LSE kwotuje w pensach (GBX) → cena ÷100 przed przeliczeniem przez kurs GBP.
// Na start ćwiczone jest tylko US; reszta dormant do seedu EU/PL/Azji.
const EXCHANGE_MAP: Record<string, { eodhd: string; ccy: string; pence?: boolean }> = {
  NASDAQ: { eodhd: "US", ccy: "USD" },
  NYSE: { eodhd: "US", ccy: "USD" },
  US: { eodhd: "US", ccy: "USD" },
  WAR: { eodhd: "WAR", ccy: "PLN" },
  XETRA: { eodhd: "XETRA", ccy: "EUR" },
  PA: { eodhd: "PA", ccy: "EUR" },
  AS: { eodhd: "AS", ccy: "EUR" },
  LSE: { eodhd: "LSE", ccy: "GBP", pence: true },
  SW: { eodhd: "SW", ccy: "CHF" },
};

type EquityDef = { asset_id: string; exchange: string; eodhd_exchange: string; ccy: string; pence: boolean };

function eodhdBase(): string {
  return "https://eodhd.com/api";
}

// ── Wczytanie kandydatów ─────────────────────────────────────────────────────
// Equities: trzymane market assety z api_source='eodhd' (demand-driven). Currencies: WSZYSTKIE
// aktywne waluty eodhd (FX-szkielet konwersji — niezależnie od holdings, jak w Fazie 2).
async function loadState(supabase: Supa): Promise<{ equities: EquityDef[]; currencies: string[] }> {
  const [heldRes, defsRes] = await Promise.all([
    supabase.from("holdings").select("asset_id").eq("price_source", "market").not("asset_id", "is", null),
    supabase.from("asset_definitions").select("asset_id, category, exchange").eq("active", true).eq("api_source", "eodhd"),
  ]);
  if (heldRes.error) throw new Error(`Failed to load holdings: ${heldRes.error.message}`);
  if (defsRes.error) throw new Error(`Failed to load asset_definitions: ${defsRes.error.message}`);

  const heldIds = new Set((heldRes.data ?? []).map((h) => h.asset_id as string));
  const defs = defsRes.data ?? [];

  const currencies = defs.filter((d) => d.category === "currency").map((d) => d.asset_id as string);

  const equities: EquityDef[] = [];
  for (const d of defs) {
    if (d.category === "currency") continue;
    if (!heldIds.has(d.asset_id as string)) continue; // tylko trzymane
    const ex = (d.exchange as string) ?? "";
    const m = EXCHANGE_MAP[ex];
    if (!m) {
      console.warn(`[fetch-eod] nieznana giełda '${ex}' dla ${d.asset_id} — pomijam`);
      continue;
    }
    equities.push({ asset_id: d.asset_id as string, exchange: ex, eodhd_exchange: m.eodhd, ccy: m.ccy, pence: m.pence ?? false });
  }
  console.log(`[fetch-eod] equities trzymane: ${equities.length}, waluty: ${currencies.length}`);
  return { equities, currencies };
}

// ── FX: waluta→USD przez {CCY}USD.FOREX. close = kurs wprost (np. PLN 0.2655). ───────────────
async function fetchFx(apiKey: string, currencies: string[]): Promise<{ rates: Map<string, number>; failed: string[]; rows: PriceRow[] }> {
  const rates = new Map<string, number>();
  const failed: string[] = [];
  const now = new Date().toISOString();
  const rows: PriceRow[] = [];

  for (const ccy of currencies) {
    try {
      const res = await fetch(`${eodhdBase()}/real-time/${ccy}USD.FOREX?api_token=${apiKey}&fmt=json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const close = typeof data.close === "number" ? data.close : NaN;
      if (!Number.isFinite(close)) throw new Error("brak close");
      rates.set(ccy, close);
      rows.push({ asset_id: ccy, price_usd: close, updated_at: now });
    } catch (err) {
      console.warn(`[fetch-eod] FX ${ccy} nieudane: ${String(err)}`);
      failed.push(ccy);
    }
  }
  return { rates, failed, rows };
}

// ── Equities: bulk per giełda. US → filtr symbols=; nie-US → pełny dump + filtr w kodzie. ────
async function fetchExchange(
  apiKey: string,
  eodhdExchange: string,
  defs: EquityDef[],
  fxRates: Map<string, number>,
): Promise<{ rows: PriceRow[]; failed: string[]; requestFailed: boolean }> {
  const now = new Date().toISOString();
  const url = new URL(`${eodhdBase()}/eod-bulk-last-day/${eodhdExchange}`);
  url.searchParams.set("api_token", apiKey);
  url.searchParams.set("fmt", "json");
  if (eodhdExchange === "US") url.searchParams.set("symbols", defs.map((d) => d.asset_id).join(","));

  let dump: { code: string; close: number | string }[];
  try {
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    dump = await res.json();
    if (!Array.isArray(dump)) throw new Error("odpowiedź nie jest tablicą");
  } catch (err) {
    console.error(`[fetch-eod] bulk ${eodhdExchange} padł: ${String(err)}`);
    return { rows: [], failed: defs.map((d) => d.asset_id), requestFailed: true };
  }

  const closeByCode = new Map<string, number>();
  for (const r of dump) {
    const c = typeof r.close === "number" ? r.close : parseFloat(String(r.close));
    if (Number.isFinite(c)) closeByCode.set(r.code, c);
  }

  const rows: PriceRow[] = [];
  const failed: string[] = [];
  for (const d of defs) {
    const close = closeByCode.get(d.asset_id);
    if (close === undefined) { failed.push(d.asset_id); continue; }
    // Konwersja na USD: cena × (÷100 jeśli pensy) × kurs(waluta→USD). USD = 1.
    const fx = d.ccy === "USD" ? 1 : fxRates.get(d.ccy);
    if (fx === undefined) { failed.push(d.asset_id); continue; } // brak kursu waluty → nie umiemy przeliczyć
    const priceUsd = close * (d.pence ? 0.01 : 1) * fx;
    rows.push({ asset_id: d.asset_id, price_usd: priceUsd, updated_at: now });
  }
  console.log(`[fetch-eod] ${eodhdExchange}: OK ${rows.length}, brak ${failed.length}`);
  return { rows, failed, requestFailed: false };
}

// ── Audyt „cały dzień bez sukcesu" → mail. Patrzymy na price_cache.updated_at. ───────────────
async function auditStale(
  supabase: Supa,
  currencies: string[],
  equities: EquityDef[],
): Promise<{ fxStale: string[]; tickerStale: string[] }> {
  const ids = [...currencies, ...equities.map((e) => e.asset_id)];
  if (ids.length === 0) return { fxStale: [], tickerStale: [] };
  const todayStart = new Date().toISOString().slice(0, 10) + "T00:00:00Z";

  const { data } = await supabase.from("price_cache").select("asset_id, updated_at").in("asset_id", ids);
  const updatedAt = new Map((data ?? []).map((r) => [r.asset_id as string, r.updated_at as string]));

  const isStale = (id: string) => {
    const u = updatedAt.get(id);
    return !u || u < todayStart; // brak wiersza lub nieodświeżony dzisiaj = cały dzień bez sukcesu
  };
  return {
    fxStale: currencies.filter(isStale),
    tickerStale: equities.map((e) => e.asset_id).filter(isStale),
  };
}

Deno.serve(async () => {
  console.log("=== fetch-eod START ===");
  const supabase = getServiceClient();

  try {
    const apiKey = Deno.env.get("EODHD_API_KEY");
    if (!apiKey) throw new Error("Brak EODHD_API_KEY");

    const { equities, currencies } = await loadState(supabase);

    // 1. FX najpierw — potrzebny do konwersji akcji nie-USD.
    const fx = await fetchFx(apiKey, currencies);
    if (fx.rows.length > 0) {
      const { error } = await supabase.from("price_cache").upsert(fx.rows, { onConflict: "asset_id" });
      if (error) throw error;
    }

    // 2. Equities bulkiem per giełda EODHD.
    const byExchange = new Map<string, EquityDef[]>();
    for (const e of equities) {
      const arr = byExchange.get(e.eodhd_exchange);
      if (arr) arr.push(e); else byExchange.set(e.eodhd_exchange, [e]);
    }
    const allRows: PriceRow[] = [];
    const allFailed: string[] = [];
    const exchangesFailed: string[] = [];
    for (const [exch, defs] of byExchange) {
      const r = await fetchExchange(apiKey, exch, defs, fx.rates);
      allRows.push(...r.rows);
      allFailed.push(...r.failed);
      if (r.requestFailed) exchangesFailed.push(exch);
    }
    if (allRows.length > 0) {
      const { error } = await supabase.from("price_cache").upsert(allRows, { onConflict: "asset_id" });
      if (error) throw error;
      console.log(`[fetch-eod] price_cache: zapisano ${allRows.length} akcji/ETF + ${fx.rows.length} FX`);
    }

    // 3. Audyt „cały dzień bez sukcesu" — tylko w runie o AUDIT_HOUR_UTC.
    let mailed = false;
    if (new Date().getUTCHours() === AUDIT_HOUR_UTC) {
      const { fxStale, tickerStale } = await auditStale(supabase, currencies, equities);
      const parts: string[] = [];
      if (fxStale.length > 0) parts.push(`FX bez kursu cały dzień: ${fxStale.join(", ")}`);
      if (tickerStale.length > 0) parts.push(`Trzymane tickery bez ceny cały dzień: ${tickerStale.join(", ")}`);
      if (parts.length > 0) {
        await sendAlertEmail("❌ abundapp: fetch-eod — pozycje bez ceny cały dzień", parts.join("\n\n"));
        mailed = true;
      }
    }

    const warnings = [
      exchangesFailed.length > 0 ? `Giełdy z błędem requestu: ${exchangesFailed.join(", ")}` : null,
      fx.failed.length > 0 ? `FX nieudane w tym runie: ${fx.failed.join(", ")}` : null,
      allFailed.length > 0 ? `Tickery bez ceny w tym runie: ${allFailed.join(", ")}` : null,
    ].filter(Boolean).join("\n") || null;

    await writeCronLog(supabase, "fetch-eod", {
      success: true,
      itemsProcessed: allRows.length + fx.rows.length,
      errorMessage: null,
      warnings,
    });

    console.log("=== fetch-eod DONE ===");
    return json({ success: true, equities: allRows.length, fx: fx.rows.length, failed: allFailed, exchangesFailed, mailed });
  } catch (err) {
    const errorMsg = String(err);
    console.error(`[ERROR] ${errorMsg}`);
    await Promise.all([
      writeCronLog(supabase, "fetch-eod", { success: false, itemsProcessed: null, errorMessage: errorMsg, warnings: null }),
      sendAlertEmail("❌ abundapp: błąd fetch-eod", errorMsg),
    ]);
    console.log("=== fetch-eod FAILED ===");
    return json({ success: false, error: errorMsg }, 500);
  }
});
