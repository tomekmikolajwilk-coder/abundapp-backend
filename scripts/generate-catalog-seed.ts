// Generator seeda katalogu (Faza 3 pricing redesign) — odpalany RAZ, lokalnie.
//
// FILOZOFIA: katalog ⊆ wyceniarne. Zamiast wrzucać całą listę TD (~17k, w tym śmieci i
// pozycje bez ceny na free tierze), seedujemy tylko POPULARNE instrumenty, których metadane
// potwierdza Twelve Data. Ostatecznym testem ceny jest add-time (holdings POST market: brak
// ceny → blokada). Tu chodzi o czysty, sensowny picker — nie o kompletność giełdy.
//
// PIPELINE:
//   1. Lista popularnych: akcje = S&P 500 (CSV) + EXTRA_STOCK_TICKERS; ETF = ETF_TICKERS (curated).
//   2. Cross-check z referencyjnymi listami TD (/stocks, /etf) — to METADANE, ZERO kredytów /price.
//   3. Seed = przecięcie (popularne ∩ zna-TD), z metadanymi TD (api_symbol, exchange, country, nazwa).
//   4. Raport: które popularne tickery NIE są w TD (luka pokrycia).
//
// ─────────────────────────────────────────────────────────────────────────────
// JAK ROZSZERZYĆ KATALOG W PRZYSZŁOŚCI (czytaj też docs/PRICING_REDESIGN.md §Katalog):
//   • więcej akcji  → dopisz tickery do EXTRA_STOCK_TICKERS, albo podmień/dodaj źródło indeksu
//                     (np. Nasdaq-100, Russell 1000) w loadPopularStocks().
//   • więcej ETF    → dopisz tickery do ETF_TICKERS.
//   • inne giełdy   → rozszerz US_EXCHANGES (uwaga: EU niewyceniarne na TD free tierze!).
//   • po zmianie    → odpal ponownie z --write; ON CONFLICT DO NOTHING nie ruszy istniejących.
// ─────────────────────────────────────────────────────────────────────────────
//
// Użycie:
//   export TWELVE_DATA_API_KEY=...   (albo --env-file=.env)
//   deno run --allow-net --allow-env --allow-write --env-file=.env scripts/generate-catalog-seed.ts          # dry-run
//   deno run --allow-net --allow-env --allow-write --env-file=.env scripts/generate-catalog-seed.ts --write   # zapis migracji

// Giełdy US, z których czytamy metadane TD. US bez sufiksu (api_symbol = ticker).
// EU świadomie poza zakresem — TD free tier nie wycenia XETRA/LSE (stąd VWCE/IWDA active=false).
const US_EXCHANGES = ["NASDAQ", "NYSE"];

// Źródło popularnych akcji: konstytuenci S&P 500 (publiczny, stabilny CSV datahub).
const SP500_CSV_URL =
  "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";

// Popularne akcje SPOZA S&P 500 (retail-favourites, growth, krypto-proxy). Punkt rozszerzenia.
const EXTRA_STOCK_TICKERS = [
  "RIVN", "LCID", "HOOD", "COIN", "SOFI", "MARA", "RIOT", "PLTR", "RBLX", "SNAP",
  "U", "DKNG", "AFRM", "UPST", "DELL", "SMCI", "ARM", "MSTR", "CVNA", "TTD",
];

// Curated top ETF wg AUM/popularności (~120). Punkt rozszerzenia: dopisz tickery.
const ETF_TICKERS = [
  // Core US equity
  "SPY", "IVV", "VOO", "VTI", "QQQ", "QQQM", "ITOT", "SCHX", "SCHB", "VV", "SPLG", "RSP",
  // Growth / value / size
  "VUG", "VTV", "IWF", "IWD", "VO", "VB", "VBR", "VBK", "IJH", "IJR", "MGK", "SCHG", "SCHD",
  "SPYG", "SPYV", "VOOG", "VOOV", "DGRO", "VYM", "VIG", "DVY", "SDY", "HDV", "SPHD", "NOBL", "MOAT", "COWZ", "AVUV",
  // International
  "VEA", "IEFA", "VWO", "IEMG", "EFA", "EEM", "VXUS", "IXUS", "VEU", "VT", "ACWI", "SCHF", "VGK", "EWJ", "FXI", "EWZ", "INDA", "VPL",
  // Bonds
  "BND", "AGG", "BNDX", "BNDW", "TLT", "IEF", "SHY", "GOVT", "LQD", "VCIT", "VCSH", "BSV", "MUB", "VTEB", "HYG", "JNK", "EMB", "TIP", "SCHP", "BIL", "SGOV", "SHV", "MBB", "VMBS",
  // Sectors (SPDR + Vanguard)
  "XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU", "XLB", "XLRE", "XLC", "VGT", "VHT", "VFH", "SMH", "SOXX", "IBB", "XBI", "KRE", "XOP",
  // Thematic / commodities / income
  "GLD", "IAU", "SLV", "GDX", "USO", "ARKK", "ARKG", "ARKW", "BOTZ", "ICLN", "TAN", "LIT", "URA", "PAVE", "JEPI", "JEPQ", "SCHH", "VNQ", "REET", "PFF",
  // Index proxies
  "DIA", "IWM", "IWB", "MDY", "QID", "SH",
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

// Referencyjna lista TD (metadane, nie kredyty /price). exchange opcjonalny — bez niego cała lista.
async function fetchTdList(kind: "stocks" | "etf", exchange?: string): Promise<TdSymbol[]> {
  const url = new URL(`https://api.twelvedata.com/${kind}`);
  if (exchange) url.searchParams.set("exchange", exchange);
  url.searchParams.set("apikey", API_KEY!);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`${kind}${exchange ? "@" + exchange : ""}: HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.data)) throw new Error(`${kind}: zły kształt (${JSON.stringify(body).slice(0, 160)})`);
  return body.data as TdSymbol[];
}

// Wstawia symbol pod jego kluczem ORAZ aliasem kropka↔myślnik (BRK.B ↔ BRK-B — różne źródła
// używają różnej konwencji). preferUS=true pozwala notowaniu US nadpisać nie-US (dla globalnej
// listy ETF, gdzie ten sam ticker bywa na wielu giełdach).
function addEntry(map: Map<string, TdSymbol>, td: TdSymbol, preferUS: boolean) {
  const sym = (td.symbol ?? "").trim();
  if (!sym) return;
  const isUS = (td.country ?? "United States") === "United States";
  for (const key of new Set([sym, sym.replace(/\./g, "-")])) {
    const cur = map.get(key);
    if (!cur || (preferUS && isUS && (cur.country ?? "") !== "United States")) map.set(key, td);
  }
}

// Akcje: per giełda US (NASDAQ/NYSE). Pierwsze wystąpienie wygrywa.
async function buildStockMap(): Promise<Map<string, TdSymbol>> {
  const map = new Map<string, TdSymbol>();
  for (const exchange of US_EXCHANGES) {
    try {
      const list = await fetchTdList("stocks", exchange);
      for (const s of list) addEntry(map, s, false);
      console.log(`TD stocks@${exchange}: ${list.length} symboli`);
    } catch (err) {
      console.error(`⚠️  ${String(err)} — pomijam`);
    }
  }
  return map;
}

// ETF: jeden globalny fetch (US ETF-y listują się na NYSE Arca / Cboe BATS — filtr per-giełda
// gubiłby IEFA/ARKK/GOVT…). Przy duplikacie tickera preferujemy notowanie US.
async function buildEtfMap(): Promise<Map<string, TdSymbol>> {
  const map = new Map<string, TdSymbol>();
  const list = await fetchTdList("etf");
  for (const s of list) addEntry(map, s, true);
  console.log(`TD etf (global): ${list.length} symboli`);
  return map;
}

// Popularne akcje = S&P 500 (CSV) ∪ EXTRA_STOCK_TICKERS.
async function loadPopularStocks(): Promise<string[]> {
  const res = await fetch(SP500_CSV_URL);
  if (!res.ok) throw new Error(`S&P 500 CSV: HTTP ${res.status}`);
  const csv = await res.text();
  const lines = csv.trim().split("\n");
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const symCol = header.findIndex((h) => h === "symbol");
  if (symCol < 0) throw new Error(`S&P 500 CSV: brak kolumny 'symbol' (header: ${header.join(",")})`);
  const sp500 = lines.slice(1)
    .map((l) => l.split(",")[symCol]?.trim().replace(/"/g, ""))
    .filter((s): s is string => !!s)
    .map((s) => s.replace(".", "-")); // BRK.B → BRK-B (konwencja TD/US)
  console.log(`S&P 500: ${sp500.length} tickerów z CSV`);
  return [...new Set([...sp500, ...EXTRA_STOCK_TICKERS])];
}

// PostgreSQL string literal.
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function main() {
  const [stockMap, etfMap, popularStocks] = await Promise.all([
    buildStockMap(),
    buildEtfMap(),
    loadPopularStocks(),
  ]);

  const rows: Row[] = [];
  const seen = new Set<string>();
  const missing: { ticker: string; kind: string }[] = [];

  const take = (ticker: string, kind: "stock" | "etf", map: Map<string, TdSymbol>) => {
    if (seen.has(ticker)) return;
    const td = map.get(ticker);
    if (!td) {
      missing.push({ ticker, kind });
      return;
    }
    seen.add(ticker);
    rows.push({
      asset_id: ticker,
      category: kind,
      api_symbol: ticker, // US bez sufiksu
      display_name: (td.name ?? ticker).trim(),
      exchange: td.exchange ?? "",
      country: td.country ?? "US",
    });
  };

  for (const t of popularStocks) take(t, "stock", stockMap);
  for (const t of ETF_TICKERS) take(t, "etf", etfMap);

  const byCat = rows.reduce((m, r) => ((m[r.category] = (m[r.category] ?? 0) + 1), m), {} as Record<string, number>);
  console.log(`\nSeed: ${rows.length} wierszy (${Object.entries(byCat).map(([k, v]) => `${k}=${v}`).join(", ")}).`);
  console.log(`Nie znalezione w TD: ${missing.length}${missing.length ? " → " + missing.map((m) => m.ticker).join(", ") : ""}`);

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
    `-- Faza 3: seed katalogu — popularne akcje (S&P 500 + extras) i ETF-y (curated top wg AUM),\n` +
    `-- przefiltrowane przez metadane Twelve Data (${rows.length} wierszy). Wygenerowane przez\n` +
    `-- scripts/generate-catalog-seed.ts (patrz tam: jak rozszerzyć). ON CONFLICT DO NOTHING.\n` +
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
