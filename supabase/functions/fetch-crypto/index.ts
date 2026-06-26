import { getServiceClient, type Supa } from "../_shared/supabase.ts";
import { json } from "../_shared/http.ts";
import { sendAlertEmail, writeCronLog } from "../_shared/alerts.ts";
import type { PriceRow } from "../_shared/types.ts";

// Osobna funkcja dla krypto, bo CoinGecko daje bulk (1 call = 100 cen) — nie pasuje do
// rotacyjnego silnika fetch-prices (budżet Twelve Data / batch po 8). Tu jedno żądanie
// /coins/markets pobiera całe top-100 naraz, mapujemy po coingecko `id` (api_symbol).
//
// Polityka alertów dostosowana do cyklu co 5 min (≠ fetch-metals co 2 dni):
//   - totalna porażka (0 cen) → mail od razu,
//   - braki pojedynczych coinów (def poza top-100) → tylko warnings w cron_logs, BEZ maila
//     (przy 288 runach/dobę mail per-coin byłby spamem).

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
      // Żaden zdefiniowany coin nie znalazł się w odpowiedzi — to anomalia, mail od razu.
      await Promise.all([
        writeCronLog(supabase, "fetch-crypto", { success: false, itemsProcessed: 0, errorMessage: "Nie pobrano żadnego kursu krypto", warnings: warningsText }),
        sendAlertEmail("❌ abundapp: błąd fetch-crypto (0 kursów)", warningsText ?? "—"),
      ]);
    } else {
      // Sukces (z ew. brakami pojedynczych coinów — tylko log, bez maila przez cykl co 5 min).
      await writeCronLog(supabase, "fetch-crypto", { success: true, itemsProcessed: rows.length, errorMessage: null, warnings: warningsText });
    }

    console.log("=== fetch-crypto DONE ===");
    return json({ success: true, updated: rows.length, warnings: missing });
  } catch (err) {
    const errorMsg = String(err);
    console.error(`[ERROR] ${errorMsg}`);
    await Promise.all([
      writeCronLog(supabase, "fetch-crypto", { success: false, itemsProcessed: null, errorMessage: errorMsg, warnings: null }),
      sendAlertEmail("❌ abundapp: błąd fetch-crypto", errorMsg),
    ]);
    console.log("=== fetch-crypto FAILED ===");
    return json({ success: false, error: errorMsg }, 500);
  }
});
