// Probe pokrycia Twelve Data dla zseedowanego katalogu (Faza 3).
// Cel: dowiedzieć się, które z dodanych akcji/ETF TD realnie wycenia przez /price (metadane
// w /stocks,/etf nie gwarantują ceny). Wynik → follow-up migracja active=false dla niewspieranych.
//
// Limit free: 8 kredytów/min, 800/dobę. /price liczy 1 kredyt per symbol → paczki po 8, ~60 s
// przerwy. 643 symbole ≈ 80 min. Wyniki zapisywane przyrostowo do /tmp/td_coverage.txt
// (można podglądać w trakcie). NIE rusza demand-driven (to jednorazowy sweep, nie fejk-user).
//
// Użycie:
//   deno run --allow-net --allow-env --allow-read --allow-write --env-file=.env scripts/probe-td-coverage.ts

const API_KEY = Deno.env.get("TWELVE_DATA_API_KEY");
if (!API_KEY) { console.error("Brak TWELVE_DATA_API_KEY"); Deno.exit(1); }

const SEED = "supabase/migrations/20260626000010_catalog_seed.sql";
const OUT = "/tmp/td_coverage.txt";
const BATCH = 8;
const DELAY_MS = 60_000;

// Wyciąga (asset_id, api_symbol) z wierszy INSERT migracji seeda.
function loadSeed(): { asset_id: string; api_symbol: string }[] {
  const sql = Deno.readTextFileSync(SEED);
  const rows: { asset_id: string; api_symbol: string }[] = [];
  const re = /\(\s*'([^']+)',\s*'[^']+',\s*'twelve_data',\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(sql)) !== null) rows.push({ asset_id: m[1], api_symbol: m[2] });
  return rows;
}

async function probeBatch(symbols: string[]): Promise<Record<string, { price?: string; code?: number; message?: string }>> {
  const url = new URL("https://api.twelvedata.com/price");
  url.searchParams.set("symbol", symbols.join(","));
  url.searchParams.set("apikey", API_KEY!);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return symbols.length === 1 ? { [symbols[0]]: data } : data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const seed = loadSeed();
  console.log(`Probe ${seed.length} symboli, paczki po ${BATCH}, ~${Math.ceil(seed.length / BATCH)} min.`);
  const ok: string[] = [];
  const failed: string[] = [];

  for (let i = 0; i < seed.length; i += BATCH) {
    const batch = seed.slice(i, i + BATCH);
    const symbols = batch.map((b) => b.api_symbol);
    try {
      const data = await probeBatch(symbols);
      for (const b of batch) {
        const v = data[b.api_symbol];
        if (v?.price != null && v.code == null) ok.push(b.asset_id);
        else failed.push(b.asset_id);
      }
    } catch (err) {
      // Cała paczka padła (rate-limit/sieć) — nie liczymy jako brak pokrycia, oznaczamy do retry.
      console.error(`⚠️  batch ${i}: ${String(err)} — oznaczam paczkę jako RETRY`);
      for (const b of batch) failed.push(`${b.asset_id}?`); // ? = niepewne (błąd, nie brak ceny)
    }

    const done = Math.min(i + BATCH, seed.length);
    const summary = `[${done}/${seed.length}] ok=${ok.length} failed=${failed.length}\nFAILED: ${failed.join(", ")}\n`;
    Deno.writeTextFileSync(OUT, summary);
    console.log(`[${done}/${seed.length}] ok=${ok.length} failed=${failed.length}`);

    if (done < seed.length) await sleep(DELAY_MS);
  }

  const final = `\n=== KONIEC ===\nWspierane: ${ok.length}/${seed.length}\nNIEwspierane (${failed.length}): ${failed.join(", ")}\n`;
  Deno.writeTextFileSync(OUT, final);
  console.log(final);
}

main().catch((e) => { console.error(e); Deno.exit(1); });
