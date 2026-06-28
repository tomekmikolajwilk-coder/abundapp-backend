import { getServiceClient, type Supa } from "../_shared/supabase.ts";
import { json } from "../_shared/http.ts";
import { sendAlertEmail, writeCronLog } from "../_shared/alerts.ts";
import type { PriceRow } from "../_shared/types.ts";

// Osobna funkcja dla krypto, bo CoinGecko daje bulk (1 call = 100 cen) — nie pasuje do
// rotacyjnego silnika fetch-prices (budżet Twelve Data / batch po 8). Tu jedno żądanie
// /coins/markets pobiera całe top-100 naraz, mapujemy po coingecko `id` (api_symbol).
//
// Cron co 15 min. Bez klucza (płatny) jedziemy na publicznym limicie CoinGecko z dzielonego
// IP Edge Functions → sporadyczny 429 jest transient. Polityka alertów:
//   - awaria/0 cen → mail dopiero po ALERT_AFTER_FAILS runach Z RZĘDU (pojedynczy 429 = cisza),
//   - braki pojedynczych coinów (def poza top-100) → tylko warnings w cron_logs, BEZ maila.

type CryptoDef = { asset_id: string; api_symbol: string };

// Pojedynczy wiersz z /coins/markets — interesuje nas tylko id + current_price.
type MarketCoin = { id: string; current_price: number | null };

const MARKETS_URL =
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1";

async function loadCryptoDefs(supabase: Supa): Promise<CryptoDef[]> {
  const { data, error } = await supabase
    .from("asset_definitions")
    .select("asset_id, api_symbol")
    .eq("active", true)
    .eq("api_source", "coingecko");
  if (error) throw new Error(`Failed to load crypto defs: ${error.message}`);
  return (data ?? []).map((d) => ({ asset_id: d.asset_id as string, api_symbol: d.api_symbol as string }));
}

async function fetchCoinGecko(
  defs: CryptoDef[],
): Promise<{ rows: PriceRow[]; missing: string[] }> {
  const now = new Date().toISOString();
  console.log(`[CoinGecko] Pobieram top-100; mapuję na ${defs.length} zdefiniowanych krypto`);

  // Demo plan ma klucz w nagłówku x-cg-demo-api-key; bez klucza działa na publicznym limicie.
  const headers: Record<string, string> = { "Accept": "application/json" };
  const apiKey = Deno.env.get("COINGECKO_API_KEY");
  if (apiKey) headers["x-cg-demo-api-key"] = apiKey;

  const res = await fetch(MARKETS_URL, { headers });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const coins = (await res.json()) as MarketCoin[];

  // id (coingecko) → current_price z odpowiedzi.
  const priceById = new Map<string, number>();
  for (const c of coins) {
    if (typeof c.current_price === "number") priceById.set(c.id, c.current_price);
  }

  const rows: PriceRow[] = [];
  const missing: string[] = [];
  for (const d of defs) {
    const price = priceById.get(d.api_symbol);
    if (price === undefined) {
      missing.push(`${d.api_symbol} (${d.asset_id})`);
      continue;
    }
    rows.push({ asset_id: d.asset_id, price_usd: price, updated_at: now });
  }

  console.log(`[CoinGecko] Zmapowano: ${rows.length}, brak w top-100: ${missing.length}`);
  return { rows, missing };
}

const ALERT_AFTER_FAILS = 3; // mail dopiero gdy tyle runów Z RZĘDU padło (transient się sam załata)

// Czy bieżąca porażka to już ALERT_AFTER_FAILS-ta z rzędu? Liczymy z cron_logs (wpis bieżącej
// porażki musi być JUŻ zapisany przed wywołaniem). Bez klucza CoinGecko jedzie na publicznym
// limicie z dzielonego IP → pojedynczy 429 jest normalny i transient → nie mailujemy od razu.
async function shouldAlert(supabase: Supa): Promise<boolean> {
  const { data } = await supabase
    .from("cron_logs").select("success")
    .eq("function_name", "fetch-crypto")
    .order("ran_at", { ascending: false })
    .limit(ALERT_AFTER_FAILS);
  const recent = data ?? [];
  return recent.length >= ALERT_AFTER_FAILS && recent.every((r) => r.success === false);
}

Deno.serve(async () => {
  console.log("=== fetch-crypto START ===");
  const supabase = getServiceClient();

  try {
    const defs = await loadCryptoDefs(supabase);
    if (defs.length === 0) {
      console.log("[CoinGecko] Brak zdefiniowanych krypto (api_source=coingecko) — nic do roboty");
      await writeCronLog(supabase, "fetch-crypto", { success: true, itemsProcessed: 0, errorMessage: null, warnings: null });
      return json({ success: true, updated: 0, warnings: [] });
    }

    const { rows, missing } = await fetchCoinGecko(defs);

    if (rows.length > 0) {
      const { error } = await supabase.from("price_cache").upsert(rows, { onConflict: "asset_id" });
      if (error) throw error;
      console.log(`[DB] price_cache: zapisano ${rows.length} kursów`);
    }

    const warningsText = missing.length > 0 ? `Brak w top-100:\n${missing.join("\n")}` : null;

    if (rows.length === 0) {
      // Żaden coin się nie pobrał — log od razu, ale mail dopiero gdy to N-ty pusty run z rzędu.
      await writeCronLog(supabase, "fetch-crypto", { success: false, itemsProcessed: 0, errorMessage: "Nie pobrano żadnego kursu krypto", warnings: warningsText });
      if (await shouldAlert(supabase)) {
        await sendAlertEmail("❌ abundapp: fetch-crypto — 0 kursów przez kilka runów z rzędu", warningsText ?? "—");
      }
    } else {
      // Sukces (z ew. brakami pojedynczych coinów — tylko log, bez maila przez cykl co 5 min).
      await writeCronLog(supabase, "fetch-crypto", { success: true, itemsProcessed: rows.length, errorMessage: null, warnings: warningsText });
    }

    console.log("=== fetch-crypto DONE ===");
    return json({ success: true, updated: rows.length, warnings: missing });
  } catch (err) {
    const errorMsg = String(err);
    console.error(`[ERROR] ${errorMsg}`);
    // Log od razu; mail dopiero gdy padło N runów z rzędu (pojedynczy 429 z CoinGecko = transient).
    await writeCronLog(supabase, "fetch-crypto", { success: false, itemsProcessed: null, errorMessage: errorMsg, warnings: null });
    if (await shouldAlert(supabase)) {
      await sendAlertEmail("❌ abundapp: fetch-crypto — błąd przez kilka runów z rzędu", errorMsg);
    }
    console.log("=== fetch-crypto FAILED ===");
    return json({ success: false, error: errorMsg }, 500);
  }
});
