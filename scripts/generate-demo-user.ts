// Generator demo usera z realistyczną historią (do pokazywania aplikacji).
// Liczy spójny zestaw: auth.users → profiles → holdings → transactions → portfolio_snapshots
// i wypluwa migrację SQL. Ceny historyczne = deterministyczny random-walk wstecz od ceny „dziś"
// (anchor), per klasa inna zmienność. Manual (mieszkanie, obligacje…) mają stałą cenę.
//
// Spójność: holdings.amount = netto z transakcji; każdy dzienny snapshot liczy stan posiadania
// JAKI BYŁ w tym dniu (suma tx do tego dnia) wyceniony ceną z tego dnia → portfel rośnie w czasie.
//
// Użycie:
//   deno run --allow-write scripts/generate-demo-user.ts        # zapis migracji
//
// Demo user jest osobny od testowego (4ff2377f…) — tamtego zostawiamy czystego.

// ── Parametry ─────────────────────────────────────────────────────────────
// User tworzony ręcznie w dashboardzie (Auth → Add user) → tu tylko jego dane.
const DEMO_UUID = "b2bb90dc-4304-41c7-821a-1cb966d30cce";
const PREFERRED = "PLN";
const DAYS = 240; // długość historii konta (dni wstecz od dziś)

// Deterministyczny PRNG (mulberry32) — seed stały → ta sama migracja przy każdym uruchomieniu.
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Market = {
  kind: "market"; asset_id: string; category: string; display_category?: string;
  display_name: string; currentUsd: number; vol: number;
};
type Manual = {
  kind: "manual"; key: string; category: string; display_category?: string;
  name: string; unit_value: number; currency: string; interest_rate?: number; start_offset?: number;
};
type Asset = Market | Manual;

// currentUsd = anchor (cena „dziś"), vol = dzienne sigma random-walku.
const ASSETS: Asset[] = [
  { kind: "market", asset_id: "BTC", category: "crypto", display_name: "Bitcoin", currentUsd: 96000, vol: 0.030 },
  { kind: "market", asset_id: "ETH", category: "crypto", display_name: "Ethereum", currentUsd: 3400, vol: 0.035 },
  { kind: "market", asset_id: "SOL", category: "crypto", display_name: "Solana", currentUsd: 150, vol: 0.050 },
  { kind: "market", asset_id: "AAPL", category: "stock", display_name: "Apple", currentUsd: 230, vol: 0.015 },
  { kind: "market", asset_id: "MSFT", category: "stock", display_name: "Microsoft", currentUsd: 430, vol: 0.013 },
  { kind: "market", asset_id: "NVDA", category: "stock", display_name: "NVIDIA", currentUsd: 140, vol: 0.025 },
  { kind: "market", asset_id: "SPY", category: "etf", display_name: "S&P 500 ETF", currentUsd: 600, vol: 0.010 },
  { kind: "market", asset_id: "QQQ", category: "etf", display_name: "Nasdaq 100 ETF", currentUsd: 520, vol: 0.012 },
  // ETF obligacyjny pokazywany w kategorii „obligacje" (display_category)
  { kind: "market", asset_id: "TLT", category: "etf", display_category: "bonds", display_name: "US 20+ Treasury ETF", currentUsd: 88, vol: 0.008 },
  // Manual (cena stała, w PLN)
  { kind: "manual", key: "flat", category: "real_estate", name: "Mieszkanie — Wrocław", unit_value: 850000, currency: "PLN" },
  { kind: "manual", key: "edo", category: "bonds", name: "Obligacje EDO", unit_value: 100, currency: "PLN", interest_rate: 6.55, start_offset: 60 },
  { kind: "manual", key: "deposit", category: "deposits", name: "Lokata Santander", unit_value: 10000, currency: "PLN" },
  { kind: "manual", key: "gold", category: "valuables", name: "Krugerrand 1oz", unit_value: 9000, currency: "PLN" },
];

// Transakcje (dayOffset 0..DAYS, ref do asset_id market lub key manual). Netto = stan holdings.
type Tx = { day: number; ref: string; side: "buy" | "sell"; amount: number };
const TXS: Tx[] = [
  { day: 0, ref: "BTC", side: "buy", amount: 0.10 },
  { day: 0, ref: "AAPL", side: "buy", amount: 5 },
  { day: 0, ref: "SPY", side: "buy", amount: 2 },
  { day: 0, ref: "flat", side: "buy", amount: 1 },
  { day: 15, ref: "ETH", side: "buy", amount: 0.8 },
  { day: 15, ref: "MSFT", side: "buy", amount: 2 },
  { day: 30, ref: "SOL", side: "buy", amount: 8 },
  { day: 40, ref: "QQQ", side: "buy", amount: 2 },
  { day: 55, ref: "NVDA", side: "buy", amount: 3 },
  { day: 60, ref: "edo", side: "buy", amount: 150 },
  { day: 80, ref: "BTC", side: "buy", amount: 0.08 },
  { day: 90, ref: "TLT", side: "buy", amount: 12 },
  { day: 110, ref: "AAPL", side: "sell", amount: 2 },
  { day: 120, ref: "deposit", side: "buy", amount: 3 },
  { day: 140, ref: "ETH", side: "buy", amount: 0.5 },
  { day: 150, ref: "SOL", side: "sell", amount: 3 },
  { day: 170, ref: "gold", side: "buy", amount: 2 },
  { day: 185, ref: "NVDA", side: "buy", amount: 2 },
  { day: 205, ref: "MSFT", side: "buy", amount: 1 },
  { day: 220, ref: "BTC", side: "sell", amount: 0.05 },
  { day: 230, ref: "SPY", side: "buy", amount: 1 },
];

const refOf = (a: Asset) => (a.kind === "market" ? a.asset_id : a.key);

// ── Serie cen ───────────────────────────────────────────────────────────────
// Dla każdego market assetu: random-walk USD[0..DAYS] z USD[DAYS] = currentUsd (kotwiczymy „dziś").
// Budujemy do przodu z losowej ceny startowej, potem skalujemy tak, by ostatni dzień = anchor.
function buildMarketSeries(a: Market, rand: () => number): number[] {
  const steps: number[] = [];
  let p = 1;
  steps.push(p);
  for (let d = 1; d <= DAYS; d++) {
    const drift = 0.0003; // lekki trend wzrostowy
    const shock = (rand() - 0.5) * 2 * a.vol;
    p = Math.max(0.05, p * (1 + drift + shock));
    steps.push(p);
  }
  const scale = a.currentUsd / steps[DAYS];
  return steps.map((x) => +(x * scale).toFixed(8));
}

// PLN→USD: lekki walk wokół 0.25 (1 PLN ≈ 0.25 USD), zakotwiczony na dziś.
function buildPlnUsd(rand: () => number): number[] {
  const steps: number[] = [1];
  for (let d = 1; d <= DAYS; d++) steps.push(Math.max(0.1, steps[d - 1] * (1 + (rand() - 0.5) * 0.01)));
  const scale = 0.25 / steps[DAYS];
  return steps.map((x) => +(x * scale).toFixed(8));
}

// ── Helpery SQL ───────────────────────────────────────────────────────────
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const num = (n: number) => (Number.isFinite(n) ? n.toString() : "0");
// timestamptz dla dnia d (offset wstecz): today - (DAYS-d) dni, godzina 7:00 jak cron-snapshoty.
const tsExpr = (d: number) => `now() - interval '${DAYS - d} days'`;

function main() {
  const rand = rng(20260627);
  const plnUsd = buildPlnUsd(rand);
  const seriesByRef = new Map<string, number[]>();
  for (const a of ASSETS) if (a.kind === "market") seriesByRef.set(a.asset_id, buildMarketSeries(a, rand));

  // Cena 1 jednostki w USD danego refa w dniu d.
  const unitUsd = (a: Asset, d: number): number => {
    if (a.kind === "market") return seriesByRef.get(a.asset_id)![d];
    const fx = a.currency === "USD" ? 1 : plnUsd[d];
    return a.unit_value * fx;
  };

  // Stan posiadania refa w dniu d = suma buy − sell do dnia d włącznie.
  const heldAt = (ref: string, d: number): number =>
    TXS.filter((t) => t.ref === ref && t.day <= d).reduce((s, t) => s + (t.side === "buy" ? t.amount : -t.amount), 0);

  // Stabilne UUID holdingów (żeby transactions.holding_id mogło je referować).
  const holdingId = new Map<string, string>();
  ASSETS.forEach((a, i) => holdingId.set(refOf(a), `d3309000-0000-4000-b000-${String(i + 1).padStart(12, "0")}`));

  const out: string[] = [];
  out.push(`-- Demo user (pokazowy) z realistyczną historią ${DAYS} dni. Wygenerowane przez`);
  out.push(`-- scripts/generate-demo-user.ts (deterministycznie). Osobny od testowego usera.`);
  out.push(`-- Konto auth (${DEMO_UUID}) utworzone ręcznie w dashboardzie — tu tylko dane portfela.`);
  out.push(``);

  // 1. Profil — trigger on_auth_user_created już wstawił wiersz przy tworzeniu usera w dashboardzie.
  //    Tu tylko ustawiamy preferred_currency=PLN i cofamy created_at (realizm „konto sprzed ${DAYS} dni").
  out.push(`-- 1. Profil (wiersz istnieje z triggera; ustawiamy walutę i datę założenia)`);
  out.push(`insert into public.profiles (id, preferred_currency, created_at)`);
  out.push(`values (${lit(DEMO_UUID)}, ${lit(PREFERRED)}, ${tsExpr(0)})`);
  out.push(`on conflict (id) do update set preferred_currency = excluded.preferred_currency, created_at = excluded.created_at;`);
  out.push(``);

  // 3. Holdings (stan końcowy = netto z transakcji). Pomijamy refy z netto = 0.
  out.push(`-- 2. Holdings (stan na dziś)`);
  out.push(`delete from public.holdings where user_id = ${lit(DEMO_UUID)};`);
  const hRows: string[] = [];
  for (const a of ASSETS) {
    const ref = refOf(a);
    const amt = heldAt(ref, DAYS);
    if (amt <= 0) continue;
    const id = holdingId.get(ref)!;
    if (a.kind === "market") {
      const dc = a.display_category ? lit(a.display_category) : "null";
      hRows.push(`  (${lit(id)}, ${lit(DEMO_UUID)}, 'market', ${lit(a.category)}, ${num(amt)}, ${lit(a.asset_id)}, null, null, null, ${dc}, null, null)`);
    } else {
      const ir = a.interest_rate != null ? num(a.interest_rate) : "null";
      const sd = a.start_offset != null ? `(${tsExpr(a.start_offset)})::date` : "null";
      const dc = a.display_category ? lit(a.display_category) : "null";
      hRows.push(`  (${lit(id)}, ${lit(DEMO_UUID)}, 'manual', ${lit(a.category)}, ${num(amt)}, null, ${lit(a.name)}, ${num(a.unit_value)}, ${lit(a.currency)}, ${dc}, ${ir}, ${sd})`);
    }
  }
  out.push(`insert into public.holdings (id, user_id, price_source, category, amount, asset_id, name, unit_value, currency, display_category, interest_rate, start_date) values`);
  out.push(hRows.join(",\n") + ";");
  out.push(``);

  // 4. Transactions (ledger). exec_price_usd = cena 1 jednostki w USD w dniu transakcji.
  out.push(`-- 3. Transakcje (historia ledgera)`);
  out.push(`delete from public.transactions where user_id = ${lit(DEMO_UUID)};`);
  const byRef = new Map(ASSETS.map((a) => [refOf(a), a]));
  const tRows: string[] = [];
  for (const t of TXS) {
    const a = byRef.get(t.ref)!;
    const px = unitUsd(a, t.day);
    const value = (t.side === "buy" ? 1 : -1) * t.amount * px;
    const assetId = a.kind === "market" ? lit(a.asset_id) : "null";
    const name = a.kind === "manual" ? lit(a.name) : "null";
    tRows.push(`  (${lit(DEMO_UUID)}, ${lit(holdingId.get(t.ref)!)}, ${assetId}, ${name}, ${lit(a.category)}, ${lit(t.side)}, ${num(t.amount)}, ${num(+px.toFixed(8))}, ${num(+value.toFixed(8))}, ${tsExpr(t.day)})`);
  }
  out.push(`insert into public.transactions (user_id, holding_id, asset_id, name, category, side, amount, exec_price_usd, value_usd, created_at) values`);
  out.push(tRows.join(",\n") + ";");
  out.push(``);

  // 5. Dzienne cron-snapshoty (stan posiadania w danym dniu × cena tego dnia).
  out.push(`-- 4. Dzienne cron-snapshoty (${DAYS} dni historii wartości portfela)`);
  out.push(`delete from public.portfolio_snapshots where user_id = ${lit(DEMO_UUID)};`);
  const sRows: string[] = [];
  for (let d = 0; d <= DAYS; d++) {
    const breakdown: Record<string, unknown>[] = [];
    for (const a of ASSETS) {
      const ref = refOf(a);
      const amt = heldAt(ref, d);
      if (amt <= 0) continue;
      const px = unitUsd(a, d);
      const valueUsd = amt * px;
      const valueCcy = valueUsd / plnUsd[d]; // preferred = PLN
      breakdown.push({
        id: holdingId.get(ref),
        asset_id: a.kind === "market" ? a.asset_id : null,
        category: a.category,
        amount: +amt.toFixed(8),
        price_usd: +px.toFixed(8),
        value_usd: +valueUsd.toFixed(4),
        value_ccy: +valueCcy.toFixed(4),
        price_source: a.kind === "market" ? "market" : "manual",
        name: a.kind === "manual" ? a.name : null,
        display_category: a.display_category ?? null,
        ...(a.kind === "manual" ? { unit_value: a.unit_value, unit_currency: a.currency } : {}),
      });
    }
    if (breakdown.length === 0) continue;
    sRows.push(`  (${lit(DEMO_UUID)}, ${lit(PREFERRED)}, ${lit(JSON.stringify(breakdown))}::jsonb, ${tsExpr(d)}, 'cron')`);
  }
  out.push(`insert into public.portfolio_snapshots (user_id, currency, holdings_breakdown, captured_at, source) values`);
  out.push(sRows.join(",\n") + ";");
  out.push(``);

  // 6. Visit-snapshot (ostatnia wizyta = dziś, stan = jak ostatni cron). Jeden na usera.
  out.push(`-- 5. Visit-snapshot (ostatnia wizyta)`);
  out.push(`insert into public.portfolio_snapshots (user_id, currency, holdings_breakdown, captured_at, source)`);
  out.push(`select user_id, currency, holdings_breakdown, now(), 'visit'`);
  out.push(`from public.portfolio_snapshots where user_id = ${lit(DEMO_UUID)} and source = 'cron'`);
  out.push(`order by captured_at desc limit 1`);
  out.push(`on conflict (user_id) where source = 'visit' do nothing;`);
  out.push(``);

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const path = `supabase/migrations/${stamp}000020_demo_user.sql`;
  Deno.writeTextFileSync(path, out.join("\n") + "\n");

  // Statystyki na stdout.
  const finalHoldings = ASSETS.filter((a) => heldAt(refOf(a), DAYS) > 0).length;
  console.log(`✅ ${path}`);
  console.log(`Holdings: ${finalHoldings}, transakcje: ${TXS.length}, snapshoty: ${sRows.length}`);
}

main();
