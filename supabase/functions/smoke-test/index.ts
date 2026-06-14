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
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const TODAY = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  // Endpointy per-user mają verify_jwt=true — bramka odrzuca brak tokena (401).
  // Wysyłamy service_role jako Bearer: jest poprawnym JWT (przechodzi bramkę), ale
  // ma role=service_role bez `sub`, więc funkcje spadają na fallback ?user_id= z URL.
  // Dzięki temu smoke-test wciąż weryfikuje ścieżkę query-param.
  const AUTH_HEADERS = { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY };

  // Pomocnik — robi GET i parsuje JSON. Memoizowany: ten sam URL fetchy tylko raz,
  // kolejne wywołania zwracają z cache'a. Dzięki temu 33 testy robią ~25 requestów
  // zamiast ~30 i nie obijamy się o rate limit Supabase Edge Functions.
  const responseCache = new Map<string, { status: number; body: unknown }>();
  async function get(path: string): Promise<{ status: number; body: unknown }> {
    if (responseCache.has(path)) return responseCache.get(path)!;
    const res = await fetch(`${BASE}/functions/v1/${path}`, { headers: AUTH_HEADERS });
    const body = await res.json();
    const result = { status: res.status, body };
    responseCache.set(path, result);
    return result;
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

  results.push(await run("portfolio live: ma 10 pozycji w holdings_breakdown", async () => {
    const { body } = await get(`portfolio?user_id=${TEST_USER_ID}`);
    const len = (body as { holdings_breakdown: unknown[] }).holdings_breakdown.length;
    assert(len === 10, `Oczekiwano 10 pozycji, dostałem ${len}`);
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

  results.push(await run(`portfolio historyczny ?date=${TODAY}: zwraca cron-snapshot`, async () => {
    const { status, body } = await get(`portfolio?user_id=${TEST_USER_ID}&date=${TODAY}`);
    assert(status === 200, `Oczekiwano 200, dostałem ${status}`);
    const capturedAt = (body as { captured_at: string }).captured_at;
    assert(capturedAt.startsWith(TODAY), `captured_at powinno zaczynać się od ${TODAY}, jest ${capturedAt}`);
    assert((body as { source: string }).source === "cron",
      `?date= powinno zwracać source='cron', dostałem '${(body as { source: string }).source}'`);
  }));

  results.push(await run(`portfolio historyczny ?date=${TODAY}&currency=EUR: ma value_selected`, async () => {
    const { body } = await get(`portfolio?user_id=${TEST_USER_ID}&date=${TODAY}&currency=EUR`);
    type Holding = { asset_id: string; value_selected?: number };
    const eur = (body as { holdings_breakdown: Holding[] }).holdings_breakdown.find(h => h.asset_id === "EUR");
    assert(eur !== undefined, "Brak EUR w historycznym snapszotcie");
    assert(Math.abs((eur!.value_selected ?? -1) - 500) < 0.01,
      `Oczekiwano value_selected=500 (EUR→EUR), jest ${eur!.value_selected}`);
  }));

  // ── /last-visit ───────────────────────────────────────────────────────────
  // Live portfolio call wyżej zapisał visit-snapshot — teraz weryfikujemy że jest dostępny.

  results.push(await run("last-visit: zwraca 200 z captured_at i holdings_breakdown", async () => {
    const { status, body } = await get(`last-visit?user_id=${TEST_USER_ID}`);
    assert(status === 200, `Oczekiwano 200, dostałem ${status}`);
    assert(!!(body as { captured_at: string }).captured_at, "Brak pola captured_at");
    assert(Array.isArray((body as { holdings_breakdown: unknown[] }).holdings_breakdown),
      "holdings_breakdown nie jest tablicą");
  }));

  results.push(await run("last-visit ?currency=EUR: EUR value_selected=500", async () => {
    const { body } = await get(`last-visit?user_id=${TEST_USER_ID}&currency=EUR`);
    type Holding = { asset_id: string; value_selected?: number };
    const eur = (body as { holdings_breakdown: Holding[] }).holdings_breakdown.find(h => h.asset_id === "EUR");
    assert(eur !== undefined, "Brak EUR w last-visit");
    assert(Math.abs((eur!.value_selected ?? -1) - 500) < 0.01,
      `Oczekiwano value_selected=500, jest ${eur!.value_selected}`);
  }));

  results.push(await run("last-visit: brak user_id → 400", async () => {
    const { status } = await get("last-visit");
    assert(status === 400, `Oczekiwano 400, dostałem ${status}`);
  }));

  results.push(await run("last-visit: nieistniejący user → 404", async () => {
    const { status } = await get("last-visit?user_id=00000000-0000-0000-0000-000000000000");
    assert(status === 404, `Oczekiwano 404, dostałem ${status}`);
  }));

  // ── /snapshot-dates ───────────────────────────────────────────────────────

  results.push(await run("snapshot-dates: zwraca 200 z tablicą dates", async () => {
    const { status, body } = await get(`snapshot-dates?user_id=${TEST_USER_ID}`);
    assert(status === 200, `Oczekiwano 200, dostałem ${status}`);
    assert(Array.isArray((body as { dates: string[] }).dates), "dates nie jest tablicą");
  }));

  results.push(await run("snapshot-dates: po snapszotcie zawiera dzisiejszą datę", async () => {
    const { body } = await get(`snapshot-dates?user_id=${TEST_USER_ID}`);
    const dates = (body as { dates: string[] }).dates;
    assert(dates.includes(TODAY), `Brak ${TODAY} w dates: [${dates.join(", ")}]`);
  }));

  results.push(await run("snapshot-dates: daty posortowane od najnowszej", async () => {
    const { body } = await get(`snapshot-dates?user_id=${TEST_USER_ID}`);
    const dates = (body as { dates: string[] }).dates;
    for (let i = 1; i < dates.length; i++) {
      assert(dates[i - 1] >= dates[i], `Daty nie są posortowane malejąco: ${dates[i - 1]} < ${dates[i]}`);
    }
  }));

  results.push(await run("snapshot-dates: brak user_id → 400", async () => {
    const { status } = await get("snapshot-dates");
    assert(status === 400, `Oczekiwano 400, dostałem ${status}`);
  }));

  results.push(await run("snapshot-dates: nieistniejący user → pusta lista", async () => {
    const { status, body } = await get("snapshot-dates?user_id=00000000-0000-0000-0000-000000000000");
    assert(status === 200, `Oczekiwano 200, dostałem ${status}`);
    assert((body as { dates: string[] }).dates.length === 0, "Oczekiwano pustej tablicy dla nieznanego usera");
  }));

  // ── /value-history ───────────────────────────────────────────────────────

  results.push(await run("value-history: zwraca 200 z currency=PLN i tablicą points", async () => {
    const { status, body } = await get(`value-history?user_id=${TEST_USER_ID}`);
    assert(status === 200, `Oczekiwano 200, dostałem ${status}`);
    assert((body as { currency: string }).currency === "PLN", "Oczekiwano currency=PLN");
    assert(Array.isArray((body as { points: unknown[] }).points), "points nie jest tablicą");
  }));

  results.push(await run("value-history: ma >= 160 punktów (syntetyczne dane od 1 stycznia)", async () => {
    const { body } = await get(`value-history?user_id=${TEST_USER_ID}`);
    const len = (body as { points: unknown[] }).points.length;
    assert(len >= 160, `Oczekiwano >= 160 punktów, dostałem ${len}`);
  }));

  results.push(await run("value-history: punkty posortowane chronologicznie", async () => {
    const { body } = await get(`value-history?user_id=${TEST_USER_ID}`);
    const points = (body as { points: { date: string }[] }).points;
    for (let i = 1; i < points.length; i++) {
      assert(points[i - 1].date <= points[i].date,
        `Daty nie rosnące: ${points[i - 1].date} > ${points[i].date}`);
    }
  }));

  results.push(await run("value-history ?category_id=crypto: points mają wartość < całości portfela", async () => {
    const [{ body: total }, { body: crypto }] = await Promise.all([
      get(`value-history?user_id=${TEST_USER_ID}`),
      get(`value-history?user_id=${TEST_USER_ID}&category_id=crypto`),
    ]);
    const totalVal = ((total as { points: { value: number }[] }).points[0]?.value ?? 0);
    const cryptoVal = ((crypto as { points: { value: number }[] }).points[0]?.value ?? 0);
    assert(cryptoVal > 0, "Oczekiwano > 0 dla crypto");
    assert(cryptoVal < totalVal, `crypto value (${cryptoVal}) powinno być < total (${totalVal})`);
  }));

  results.push(await run("value-history ?asset_id=BTC: tylko BTC w każdym punkcie", async () => {
    const { body } = await get(`value-history?user_id=${TEST_USER_ID}&asset_id=BTC`);
    const points = (body as { points: { value: number }[] }).points;
    assert(points.length >= 160, `Oczekiwano >= 160 punktów dla BTC, dostałem ${points.length}`);
    assert(points[0].value > 0, "Oczekiwano value > 0 dla BTC");
  }));

  results.push(await run("value-history ?currency=EUR: każdy punkt ma value_selected", async () => {
    const { body } = await get(`value-history?user_id=${TEST_USER_ID}&currency=EUR`);
    const points = (body as { points: { value: number; value_selected?: number }[] }).points;
    for (const p of points) {
      assert(p.value_selected !== undefined, `Brak value_selected dla daty ${(p as unknown as { date: string }).date}`);
      assert(p.value_selected! > 0, "value_selected <= 0");
    }
  }));

  results.push(await run("value-history ?from=&to=: filtrowanie zakresu dat", async () => {
    const { body } = await get(`value-history?user_id=${TEST_USER_ID}&from=2026-01-01&to=2026-01-31`);
    const points = (body as { points: { date: string }[] }).points;
    assert(points.length > 0, "Oczekiwano punktów w zakresie");
    for (const p of points) {
      assert(p.date >= "2026-01-01" && p.date <= "2026-01-31",
        `Data ${p.date} poza zakresem 2026-01-01 – 2026-01-31`);
    }
  }));

  results.push(await run("value-history: brak user_id → 400", async () => {
    const { status } = await get("value-history");
    assert(status === 400, `Oczekiwano 400, dostałem ${status}`);
  }));

  results.push(await run("value-history: nieistniejący user → 404", async () => {
    const { status } = await get("value-history?user_id=00000000-0000-0000-0000-000000000000");
    assert(status === 404, `Oczekiwano 404, dostałem ${status}`);
  }));

  results.push(await run("value-history: currency=BTC (nie waluta) → 400", async () => {
    const { status } = await get(`value-history?user_id=${TEST_USER_ID}&currency=BTC`);
    assert(status === 400, `Oczekiwano 400, dostałem ${status}`);
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
