// Generator seeda katalogu (Faza 3 pricing redesign) — odpalany RAZ, lokalnie.
// Ciągnie listy symboli z Twelve Data (/stocks + /etf), filtruje do wybranych giełd
// i wypluwa migrację SQL z insertami do asset_definitions (ON CONFLICT DO NOTHING).
//
// Dlaczego generator, a nie ręczna migracja: katalog = dokładnie to, co nasz provider
// (Twelve Data) potrafi wycenić — więc źródłem prawdy jest lista symboli TD, nie ręczna.
// Sam IMPORT zostaje statyczną migracją (zgodnie z decyzją), generator tylko ją produkuje.
//
// Użycie:
//   export TWELVE_DATA_API_KEY=...
//   deno run --allow-net --allow-env --allow-write scripts/generate-catalog-seed.ts            # dry-run (tylko statystyki)
//   deno run --allow-net --allow-env --allow-write scripts/generate-catalog-seed.ts --write     # zapis migracji
//
// Po wygenerowaniu: PRZEJRZYJ migrację (liczba wierszy, sensowność) przed commitem.

// Giełdy do zaciągnięcia, w kolejności priorytetu (przy kolizji tickera wygrywa pierwsza).
// US bez sufiksu (api_symbol = ticker); EU z sufiksem giełdy (api_symbol = TICKER:EXCHANGE),
// jak istniejące ETF-y (VWCE:XETRA). country = ISO.
const EXCHANGES: { exchange: string; country: string; suffix: boolean }[] = [
  { exchange: "NASDAQ", country: "US", suffix: false },
  { exchange: "NYSE", country: "US", suffix: false },
  { exchange: "XETRA", country: "DE", suffix: true },
  { exchange: "LSE", country: "GB", suffix: true },
];

type TdSymbol = { symbol: string; name: string; exchange: string; country?: string };
type Row = {
  asset_id: string;
  category: "stock" | "etf";
  api_symbol: string;
  display_name: string;
  exchange: string;
  country: string;
};

const API_KEY = Deno.env.get("TWELVE_DATA_API_KEY");
if (!API_KEY) {
  console.error("Brak TWELVE_DATA_API_KEY w env.");
  Deno.exit(1);
}
const WRITE = Deno.args.includes("--write");

async function fetchList(kind: "stocks" | "etf", exchange: string): Promise<TdSymbol[]> {
  const url = new URL(`https://api.twelvedata.com/${kind}`);
  url.searchParams.set("exchange", exchange);
  url.searchParams.set("apikey", API_KEY!);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`${kind}@${exchange}: HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.data)) throw new Error(`${kind}@${exchange}: nieoczekiwany kształt (${JSON.stringify(body).slice(0, 200)})`);
  return body.data as TdSymbol[];
}

// PostgreSQL string literal — pojedyncze apostrofy podwajamy.
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function main() {
  const seen = new Set<string>(); // asset_id już dodane — kolizje tickerów między giełdami pomijamy
  const rows: Row[] = [];
  const skipped: string[] = [];

  for (const { exchange, country, suffix } of EXCHANGES) {
    for (const kind of ["stocks", "etf"] as const) {
      const category = kind === "stocks" ? "stock" : "etf";
      let list: TdSymbol[];
      try {
        list = await fetchList(kind, exchange);
      } catch (err) {
        console.error(`⚠️  ${String(err)} — pomijam`);
        continue;
      }
      let added = 0;
      for (const s of list) {
        const ticker = (s.symbol ?? "").trim();
        const name = (s.name ?? "").trim();
        if (!ticker || !name) continue;
        if (seen.has(ticker)) {
          skipped.push(`${ticker}@${exchange}`);
          continue;
        }
        seen.add(ticker);
        rows.push({
          asset_id: ticker,
          category,
          api_symbol: suffix ? `${ticker}:${exchange}` : ticker,
          display_name: name,
          exchange,
          country: s.country ?? country,
        });
        added++;
      }
      console.log(`${kind}@${exchange}: ${list.length} z API, +${added} nowych`);
    }
  }

  console.log(`\nRazem: ${rows.length} wierszy, ${skipped.length} pominiętych (kolizje tickera).`);
  const byCat = rows.reduce((m, r) => ((m[r.category] = (m[r.category] ?? 0) + 1), m), {} as Record<string, number>);
  console.log(`Podział: ${Object.entries(byCat).map(([k, v]) => `${k}=${v}`).join(", ")}`);

  if (!WRITE) {
    console.log("\n(dry-run) — dodaj --write żeby zapisać migrację.");
    return;
  }

  // Sekwencja 000010 → sortuje się po migracjach schematu Fazy 3 (…000002/000003).
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const path = `supabase/migrations/${stamp}000010_catalog_seed.sql`;
  const values = rows
    .map((r) => `  (${lit(r.asset_id)}, ${lit(r.category)}, 'twelve_data', ${lit(r.api_symbol)}, ${lit(r.display_name)}, ${lit(r.exchange)}, ${lit(r.country)})`)
    .join(",\n");
  const sql =
    `-- Faza 3: seed katalogu stock/ETF z Twelve Data (${rows.length} wierszy). Wygenerowane przez\n` +
    `-- scripts/generate-catalog-seed.ts. ON CONFLICT DO NOTHING — nie nadpisuje istniejących definicji.\n` +
    `insert into public.asset_definitions (asset_id, category, api_source, api_symbol, display_name, exchange, country) values\n` +
    `${values}\n` +
    `on conflict (asset_id) do nothing;\n`;
  await Deno.writeTextFile(path, sql);
  console.log(`\n✅ Zapisano ${path}`);
}

main().catch((err) => {
  console.error(err);
  Deno.exit(1);
});
