import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyOutcomes,
  type AssetCandidate,
  type DamagedRecord,
  MAX_FAILS_PER_DAY,
  pickAssets,
} from "./logic.ts";

const NOW = new Date("2026-06-14T12:00:00.000Z");
const TODAY = "2026-06-14T09:00:00.000Z";
const YESTERDAY = "2026-06-13T23:00:00.000Z";

function asset(asset_id: string, updated_at: string | null): AssetCandidate {
  return { asset_id, api_symbol: asset_id, updated_at };
}

// ── pickAssets: kolejność ────────────────────────────────────────────────────

Deno.test("pickAssets: nowe tickery (updated_at=null) idą pierwsze", () => {
  const candidates = [
    asset("BTC", "2026-06-14T06:00:00Z"),
    asset("SPY", null),   // nowy ETF
    asset("AAPL", "2026-06-14T05:00:00Z"),
    asset("QQQ", null),   // nowy ETF
  ];
  const picked = pickAssets(candidates, [], NOW).map((c) => c.asset_id);
  assertEquals(picked.slice(0, 2).sort(), ["QQQ", "SPY"]); // oba null przed resztą
  assertEquals(picked.slice(2), ["AAPL", "BTC"]);           // potem najstarsze
});

Deno.test("pickAssets: najstarszy updated_at idzie przed nowszym", () => {
  const candidates = [
    asset("A", "2026-06-14T10:00:00Z"),
    asset("B", "2026-06-14T08:00:00Z"),
    asset("C", "2026-06-14T09:00:00Z"),
  ];
  const picked = pickAssets(candidates, [], NOW).map((c) => c.asset_id);
  assertEquals(picked, ["B", "C", "A"]);
});

Deno.test("pickAssets: zwraca maksymalnie `limit` pozycji", () => {
  const candidates = Array.from({ length: 20 }, (_, i) =>
    asset(`A${i}`, `2026-06-14T0${i % 9}:00:00Z`));
  assertEquals(pickAssets(candidates, [], NOW).length, 8);
  assertEquals(pickAssets(candidates, [], NOW, 5).length, 5);
});

// ── pickAssets: wykluczanie uszkodzonych ────────────────────────────────────

Deno.test("pickAssets: asset z limitem prób DZIŚ wypada z kolejki", () => {
  const candidates = [asset("BTC", "2026-06-14T01:00:00Z"), asset("ETH", "2026-06-14T02:00:00Z")];
  const damaged: DamagedRecord[] = [
    { asset_id: "BTC", fail_count: MAX_FAILS_PER_DAY, last_failed_at: TODAY },
  ];
  const picked = pickAssets(candidates, damaged, NOW).map((c) => c.asset_id);
  assertEquals(picked, ["ETH"]); // BTC pominięty mimo że najstarszy
});

Deno.test("pickAssets: asset który dobił limitu WCZORAJ wraca do kolejki (reset dzienny)", () => {
  const candidates = [asset("BTC", "2026-06-14T01:00:00Z")];
  const damaged: DamagedRecord[] = [
    { asset_id: "BTC", fail_count: MAX_FAILS_PER_DAY, last_failed_at: YESTERDAY },
  ];
  const picked = pickAssets(candidates, damaged, NOW).map((c) => c.asset_id);
  assertEquals(picked, ["BTC"]); // wczorajsze awarie nie blokują
});

Deno.test("pickAssets: asset poniżej limitu prób DZIŚ nadal jest brany", () => {
  const candidates = [asset("BTC", "2026-06-14T01:00:00Z")];
  const damaged: DamagedRecord[] = [
    { asset_id: "BTC", fail_count: MAX_FAILS_PER_DAY - 1, last_failed_at: TODAY },
  ];
  const picked = pickAssets(candidates, damaged, NOW).map((c) => c.asset_id);
  assertEquals(picked, ["BTC"]);
});

// ── applyOutcomes: licznik i alerty ─────────────────────────────────────────

Deno.test("applyOutcomes: pierwsza porażka → licznik=1, bez alertu", () => {
  const { updates, alerts } = applyOutcomes([{ asset_id: "BTC", ok: false }], [], NOW);
  assertEquals(updates, [{ op: "set", asset_id: "BTC", fail_count: 1, last_failed_at: NOW.toISOString() }]);
  assertEquals(alerts, []);
});

Deno.test("applyOutcomes: porażka przy liczniku 2 z dziś → licznik=3 + dokładnie jeden alert", () => {
  const damaged: DamagedRecord[] = [{ asset_id: "BTC", fail_count: 2, last_failed_at: TODAY }];
  const { updates, alerts } = applyOutcomes([{ asset_id: "BTC", ok: false }], damaged, NOW);
  assertEquals(updates, [{ op: "set", asset_id: "BTC", fail_count: 3, last_failed_at: NOW.toISOString() }]);
  assertEquals(alerts, [{ asset_id: "BTC", fail_count: 3 }]);
});

Deno.test("applyOutcomes: porażka gdy ostatnia była WCZORAJ → licznik resetuje się do 1", () => {
  const damaged: DamagedRecord[] = [{ asset_id: "BTC", fail_count: 2, last_failed_at: YESTERDAY }];
  const { updates, alerts } = applyOutcomes([{ asset_id: "BTC", ok: false }], damaged, NOW);
  assertEquals(updates, [{ op: "set", asset_id: "BTC", fail_count: 1, last_failed_at: NOW.toISOString() }]);
  assertEquals(alerts, []); // nie 3 → bez maila
});

Deno.test("applyOutcomes: sukces na uszkodzonym assecie → kasujemy wpis (reset po sukcesie)", () => {
  const damaged: DamagedRecord[] = [{ asset_id: "BTC", fail_count: 2, last_failed_at: TODAY }];
  const { updates, alerts } = applyOutcomes([{ asset_id: "BTC", ok: true }], damaged, NOW);
  assertEquals(updates, [{ op: "clear", asset_id: "BTC" }]);
  assertEquals(alerts, []);
});

Deno.test("applyOutcomes: sukces na zdrowym assecie → żadnej zmiany w damaged_assets", () => {
  const { updates, alerts } = applyOutcomes([{ asset_id: "AAPL", ok: true }], [], NOW);
  assertEquals(updates, []);
  assertEquals(alerts, []);
});

Deno.test("applyOutcomes: miks sukcesów i porażek w jednym wywołaniu", () => {
  const damaged: DamagedRecord[] = [
    { asset_id: "BTC", fail_count: 2, last_failed_at: TODAY },  // padnie → 3 + alert
    { asset_id: "ETH", fail_count: 1, last_failed_at: TODAY },  // wejdzie → clear
  ];
  const outcomes = [
    { asset_id: "BTC", ok: false },
    { asset_id: "ETH", ok: true },
    { asset_id: "SPY", ok: true },   // zdrowy, brak wpisu → nic
  ];
  const { updates, alerts } = applyOutcomes(outcomes, damaged, NOW);
  assertEquals(updates, [
    { op: "set", asset_id: "BTC", fail_count: 3, last_failed_at: NOW.toISOString() },
    { op: "clear", asset_id: "ETH" },
  ]);
  assertEquals(alerts, [{ asset_id: "BTC", fail_count: 3 }]);
});
