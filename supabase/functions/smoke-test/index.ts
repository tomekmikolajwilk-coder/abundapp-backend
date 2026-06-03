// Smoke testy — odpala jeden curl po deploy i dostajesz raport.
// Zwraca HTTP 200 jeśli wszystko przeszło, HTTP 500 jeśli cokolwiek padło.
//
// Użycie:
//   curl https://mrcjjyaljautuylpsssp.supabase.co/functions/v1/smoke-test | jq .

const TEST_USER_ID = "4ff2377f-a833-4a05-9930-391d84d4182d"; // testowy user (PLN, BTC/AAPL/XAU/EUR)

type TestResult = {
  name: string;
  passed: boolean;
  error?: string;
};

// Uruchamia jeden test. Jeśli funkcja rzuci błąd — test failed.
async function run(name: string, fn: () => Promise<void>): Promise<TestResult> {
  try {
    await fn();
    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  }
}

// Rzuca błąd z czytelnym komunikatem jeśli warunek nie jest spełniony.
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

Deno.serve(async () => {
  const BASE = Deno.env.get("SUPABASE_URL")!;
  const TODAY = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  // Pomocnik — robi GET i parsuje JSON.
  // Zwraca { status, body } żeby testy mogły sprawdzać zarówno kod HTTP jak i treść.
  async function get(path: string): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${BASE}/functions/v1/${path}`);
    const body = await res.json();
    return { status: res.status, body };
  }

  const results: TestResult[] = [];

  // ── /assets ───────────────────────────────────────────────────────────────

  results.push(await run("assets: zwraca 200", async () => {
    const { status } = await get("assets");
    assert(status === 200, `Oczekiwano 200, dostałem ${status}`);
  }));

  results.push(await run("assets: ma wszystkie 4 kategorie (crypto, stock, metal, currency)", async () => {
    const { body } = await get("assets");
    const b = body as Record<string, unknown[]>;
    for (const cat of ["crypto", "stock", "metal", "currency"]) {
      assert(Array.isArray(b[cat]) && b[cat].length > 0, `Brak kategorii ${cat} lub pusta`);
    }
  }));

  // ── /portfolio live ───────────────────────────────────────────────────────

  results.push(await run("portfolio live: zwraca 200 i currency=PLN", async () => {
    const { status, body } = await get(`portfolio?user_id=${TEST_USER_ID}`);
    assert(status === 200, `Oczekiwano 200, dostałem ${status}`);
    assert((body as { currency: string }).currency === "PLN", "Oczekiwano currency=PLN");
  }));

  results.push(await run("portfolio live: ma 4 pozycje w holdings_breakdown", async () => {
    const { body } = await get(`portfolio?user_id=${TEST_USER_ID}`);
    const len = (body as { holdings_breakdown: unknown[] }).holdings_breakdown.length;
    assert(len === 4, `Oczekiwano 4 pozycji, dostałem ${len}`);
  }));

  results.push(await run("portfolio live: value_usd = amount * price_usd dla każdej pozycji", async () => {
    const { body } = await get(`portfolio?user_id=${TEST_USER_ID}`);
    type Holding = { asset_id: string; amount: number; price_usd: number; value_usd: number };
    const breakdown = (body as { holdings_breakdown: Holding[] }).holdings_breakdown;
    for (const h of breakdown) {
      const expected = h.amount * h.price_usd;
      const diff = Math.abs(expected - h.value_usd);
      assert(diff < 0.01, `${h.asset_id}: oczekiwano value_usd=${expected.toFixed(4)}, jest ${h.value_usd}`);
    }
  }));

  results.push(await run("portfolio live ?currency=EUR: EUR holdings=500 → value_selected=500", async () => {
    // Klasyczny self-check: 500 EUR przeliczone na EUR musi dać dokładnie 500.
    const { body } = await get(`portfolio?user_id=${TEST_USER_ID}&currency=EUR`);
    type Holding = { asset_id: string; value_selected?: number };
    const eur = (body as { holdings_breakdown: Holding[] }).holdings_breakdown.find(h => h.asset_id === "EUR");
    assert(eur !== undefined, "Brak EUR w holdings_breakdown");
    assert(Math.abs((eur!.value_selected ?? -1) - 500) < 0.01,
      `Oczekiwano value_selected=500, jest ${eur!.value_selected}`);
  }));

  results.push(await run("portfolio live ?currency=EUR: wszystkie pozycje mają value_selected", async () => {
    const { body } = await get(`portfolio?user_id=${TEST_USER_ID}&currency=EUR`);
    type Holding = { asset_id: string; value_selected?: number };
    const breakdown = (body as { holdings_breakdown: Holding[] }).holdings_breakdown;
    for (const h of breakdown) {
      assert(h.value_selected !== undefined, `Brak value_selected dla ${h.asset_id}`);
      assert(h.value_selected! > 0, `value_selected <= 0 dla ${h.asset_id}`);
    }
  }));

  // ── /portfolio — obsługa błędów ───────────────────────────────────────────

  results.push(await run("portfolio: brak user_id → 400", async () => {
    const { status } = await get("portfolio");
    assert(status === 400, `Oczekiwano 400, dostałem ${status}`);
  }));

  results.push(await run("portfolio: currency=BTC (kategoria crypto, nie currency) → 400", async () => {
    const { status } = await get(`portfolio?user_id=${TEST_USER_ID}&currency=BTC`);
    assert(status === 400, `Oczekiwano 400, dostałem ${status}`);
  }));

  results.push(await run("portfolio: nieistniejący user_id → 404", async () => {
    const { status } = await get("portfolio?user_id=00000000-0000-0000-0000-000000000000");
    assert(status === 404, `Oczekiwano 404, dostałem ${status}`);
  }));

  results.push(await run("portfolio: data bez snapshotu → 404", async () => {
    const { status } = await get(`portfolio?user_id=${TEST_USER_ID}&date=2000-01-01`);
    assert(status === 404, `Oczekiwano 404, dostałem ${status}`);
  }));

  // ── /snapshot-portfolio + weryfikacja historycznego widoku ────────────────

  results.push(await run("snapshot-portfolio: zwraca success=true i snapshots >= 1", async () => {
    const { status, body } = await get("snapshot-portfolio");
    assert(status === 200, `Oczekiwano 200, dostałem ${status}`);
    assert((body as { success: boolean }).success === true, "success !== true");
    assert((body as { snapshots: number }).snapshots >= 1,
      `Oczekiwano co najmniej 1 snapshot, jest ${(body as { snapshots: number }).snapshots}`);
  }));

  results.push(await run(`portfolio historyczny ?date=${TODAY}: zwraca 200 po snapszotcie`, async () => {
    const { status, body } = await get(`portfolio?user_id=${TEST_USER_ID}&date=${TODAY}`);
    assert(status === 200, `Oczekiwano 200, dostałem ${status}`);
    assert((body as { captured_at: string }).captured_at === TODAY,
      `captured_at powinno być ${TODAY}, jest ${(body as { captured_at: string }).captured_at}`);
  }));

  results.push(await run(`portfolio historyczny ?date=${TODAY}&currency=EUR: ma value_selected`, async () => {
    const { body } = await get(`portfolio?user_id=${TEST_USER_ID}&date=${TODAY}&currency=EUR`);
    type Holding = { asset_id: string; value_selected?: number };
    const eur = (body as { holdings_breakdown: Holding[] }).holdings_breakdown.find(h => h.asset_id === "EUR");
    assert(eur !== undefined, "Brak EUR w historycznym snapszotcie");
    assert(Math.abs((eur!.value_selected ?? -1) - 500) < 0.01,
      `Oczekiwano value_selected=500 (EUR→EUR), jest ${eur!.value_selected}`);
  }));

  // ── Podsumowanie ──────────────────────────────────────────────────────────

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log(`[smoke-test] ${passed}/${results.length} passed, ${failed} failed`);
  for (const r of results) {
    if (r.passed) {
      console.log(`  ✅ ${r.name}`);
    } else {
      console.error(`  ❌ ${r.name}: ${r.error}`);
    }
  }

  return new Response(
    JSON.stringify({ passed, failed, total: results.length, results }, null, 2),
    {
      status: failed > 0 ? 500 : 200,
      headers: { "Content-Type": "application/json" },
    }
  );
});
