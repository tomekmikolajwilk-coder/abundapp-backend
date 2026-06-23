// Smoke testy — odpala jeden curl po deploy i dostajesz raport.
// Zwraca HTTP 200 jeśli wszystko przeszło, HTTP 500 jeśli cokolwiek padło.
//
// Użycie:
//   curl https://mrcjjyaljautuylpsssp.supabase.co/functions/v1/smoke-test | jq .
//
// Endpointy per-user mają verify_jwt=true i czytają user_id z claim `sub` (bez
// fallbacku na ?user_id=). Dlatego smoke-test loguje się jako testowy user
// (password grant) i odpytuje endpointy jego tokenem — czyli dokładnie tą samą
// ścieżką auth co produkcyjny frontend. Sekrety: SMOKE_TEST_EMAIL (opcjonalny,
// domyślnie konto testowe) + SMOKE_TEST_PASSWORD (wymagany).

const TEST_EMAIL = Deno.env.get("SMOKE_TEST_EMAIL") ?? "tomekmikolajwilk@gmail.com";

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

// Logowanie testowego usera przez password grant → access_token (JWT z `sub`).
async function signIn(base: string, anonKey: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Logowanie testowego usera nie powiodło się (HTTP ${res.status}): ${JSON.stringify(body)}`);
  }
  return body.access_token as string;
}

Deno.serve(async () => {
  const BASE = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const PASSWORD = Deno.env.get("SMOKE_TEST_PASSWORD");
  const TODAY = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  // Bez hasła nie zalogujemy testowego usera — cała reszta i tak by padła. Jasny błąd.
  if (!PASSWORD) {
    return new Response(
      JSON.stringify({ error: "Brak sekretu SMOKE_TEST_PASSWORD — ustaw go w Supabase (Edge Functions → Secrets)." }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  let userToken: string;
  try {
    userToken = await signIn(BASE, ANON_KEY, TEST_EMAIL, PASSWORD);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // Wszystkie wywołania jako zalogowany user — token w Authorization, anon w apikey.
  const AUTH_HEADERS = { Authorization: `Bearer ${userToken}`, apikey: ANON_KEY };

  // Pomocnik — robi GET i parsuje JSON. Memoizowany: ten sam URL fetchy tylko raz,
  // kolejne wywołania zwracają z cache'a — mniej requestów, mniej rate-limitu.
  // Parsuje odpowiedź jako JSON, ale NIGDY nie rzuca — gdy funkcja padnie i zwróci
  // czysty tekst (np. runtime'owe "Internal Server Error"), oddajemy { __nonJson, status }
  // zamiast wywalać cały smoke-test. Dzięki temu konkretny test złapie błąd i go zaraportuje.
  async function readBody(res: Response): Promise<unknown> {
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      // Połączenie zerwane w trakcie czytania (np. wywołana funkcja padła twardo).
      return { __readError: String(e), __status: res.status };
    }
    try {
      return JSON.parse(text);
    } catch {
      return { __nonJson: text, __status: res.status };
    }
  }

  // Jeden punkt fetchowania, który NIGDY nie rzuca: błąd sieciowy (odrzucony fetch)
  // zwracamy jako { status:0, body }. Bez tego niezabezpieczony fetch ubijał cały
  // smoke-test (HTTP 500 plain-text). BEZ retry — Supabase rate-limituje wywołania
  // funkcja→funkcja per-przebieg, więc ponawianie tylko potrajało rate-limitowane calle.
  async function safeFetch(
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: unknown }> {
    // Mała pauza, by nie wystrzeliwać wywołań seriami (chroni przed burst rate-limitem).
    await new Promise((r) => setTimeout(r, 150));
    try {
      const res = await fetch(`${BASE}/functions/v1/${path}`, init);
      return { status: res.status, body: await readBody(res) };
    } catch (e) {
      return { status: 0, body: { __fetchError: String(e) } };
    }
  }

  const responseCache = new Map<string, { status: number; body: unknown }>();
  async function get(path: string): Promise<{ status: number; body: unknown }> {
    if (responseCache.has(path)) return responseCache.get(path)!;
    const result = await safeFetch(path, { headers: AUTH_HEADERS });
    responseCache.set(path, result);
    return result;
  }

  // Wywołanie BEZ żadnego tokena — sprawdza, że bramka verify_jwt odrzuca (401).
  async function statusNoAuth(path: string): Promise<number> {
    try {
      const res = await fetch(`${BASE}/functions/v1/${path}`);
      await res.text(); // drain
      return res.status;
    } catch {
      return 0;
    }
  }

  // GET z pominięciem cache'a get() — potrzebne po mutacji holdings, żeby zobaczyć świeży stan.
  async function freshGet(path: string): Promise<{ status: number; body: unknown }> {
    return await safeFetch(path, { headers: AUTH_HEADERS });
  }

  // POST/PATCH/DELETE z body JSON.
  async function send(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    return await safeFetch(path, {
      method,
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  // Mirror backendowego naliczania liniowego (musi zgadzać się z _shared/holdings.ts).
  function bondFactor(rate: number, startDate: string, now: Date): number {
    const start = Date.parse(`${startDate}T00:00:00Z`);
    const days = Math.max(0, Math.floor((now.getTime() - start) / 86_400_000));
    return 1 + (rate / 100) * (days / 365);
  }

  // Testowa obligacja ma nazwę z tym prefiksem — pozwala odróżnić ją od realnych
  // pozycji usera (np. przy zliczaniu „10 pozycji", odpornym na ewentualny wyciek).
  const SMOKE_PREFIX = "__SMOKE__";
  type Holding = { id?: string; asset_id: string | null; name?: string | null; price_source?: string };

  const results: TestResult[] = [];
 try {
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
  // user_id bierze się z tokena (sub), nie z URL.

  results.push(await run("portfolio live: zwraca 200 i currency=PLN", async () => {
    const { status, body } = await get("portfolio");
    assert(status === 200, `Oczekiwano 200, dostałem ${status} — body: ${JSON.stringify(body)}`);
    assert((body as { currency: string }).currency === "PLN", "Oczekiwano currency=PLN");
  }));

  results.push(await run("portfolio live: ma 10 pozycji w holdings_breakdown", async () => {
    const { body } = await get("portfolio");
    // Liczymy tylko realne pozycje usera — pomijamy ewentualną testową obligację
    // (gdyby DELETE z poprzedniego przebiegu nie zdążył), żeby liczba była stabilna.
    const real = (body as { holdings_breakdown: Holding[] }).holdings_breakdown
      .filter((h) => !(typeof h.name === "string" && h.name.startsWith(SMOKE_PREFIX)));
    assert(real.length === 10, `Oczekiwano 10 realnych pozycji, dostałem ${real.length}`);
  }));

  results.push(await run("portfolio live: value_usd = amount * price_usd dla każdej pozycji", async () => {
    const { body } = await get("portfolio");
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
    const { body } = await get("portfolio?currency=EUR");
    type Holding = { asset_id: string; value_selected?: number };
    const eur = (body as { holdings_breakdown: Holding[] }).holdings_breakdown.find(h => h.asset_id === "EUR");
    assert(eur !== undefined, "Brak EUR w holdings_breakdown");
    assert(Math.abs((eur!.value_selected ?? -1) - 500) < 0.01,
      `Oczekiwano value_selected=500, jest ${eur!.value_selected}`);
  }));

  results.push(await run("portfolio live ?currency=EUR: wszystkie pozycje mają value_selected", async () => {
    const { body } = await get("portfolio?currency=EUR");
    type Holding = { asset_id: string; value_selected?: number };
    const breakdown = (body as { holdings_breakdown: Holding[] }).holdings_breakdown;
    for (const h of breakdown) {
      assert(h.value_selected !== undefined, `Brak value_selected dla ${h.asset_id}`);
      assert(h.value_selected! > 0, `value_selected <= 0 dla ${h.asset_id}`);
    }
  }));

  // ── /portfolio — obsługa błędów ───────────────────────────────────────────

  results.push(await run("portfolio: brak tokena → 401 (bramka verify_jwt)", async () => {
    const status = await statusNoAuth("portfolio");
    assert(status === 401, `Oczekiwano 401, dostałem ${status}`);
  }));

  results.push(await run("portfolio: currency=BTC (kategoria crypto, nie currency) → 400", async () => {
    const { status } = await get("portfolio?currency=BTC");
    assert(status === 400, `Oczekiwano 400, dostałem ${status}`);
  }));

  results.push(await run("portfolio: data bez snapshotu → 404", async () => {
    const { status } = await get("portfolio?date=2000-01-01");
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
    const { status, body } = await get(`portfolio?date=${TODAY}`);
    assert(status === 200, `Oczekiwano 200, dostałem ${status}`);
    const capturedAt = (body as { captured_at: string }).captured_at;
    assert(capturedAt.startsWith(TODAY), `captured_at powinno zaczynać się od ${TODAY}, jest ${capturedAt}`);
    assert((body as { source: string }).source === "cron",
      `?date= powinno zwracać source='cron', dostałem '${(body as { source: string }).source}'`);
  }));

  results.push(await run(`portfolio historyczny ?date=${TODAY}&currency=EUR: ma value_selected`, async () => {
    const { body } = await get(`portfolio?date=${TODAY}&currency=EUR`);
    type Holding = { asset_id: string; value_selected?: number };
    const eur = (body as { holdings_breakdown: Holding[] }).holdings_breakdown.find(h => h.asset_id === "EUR");
    assert(eur !== undefined, "Brak EUR w historycznym snapszotcie");
    assert(Math.abs((eur!.value_selected ?? -1) - 500) < 0.01,
      `Oczekiwano value_selected=500 (EUR→EUR), jest ${eur!.value_selected}`);
  }));

  // ── /last-visit ───────────────────────────────────────────────────────────
  // Live portfolio call wyżej zapisał visit-snapshot — teraz weryfikujemy że jest dostępny.

  results.push(await run("last-visit: zwraca 200 z captured_at i holdings_breakdown", async () => {
    const { status, body } = await get("last-visit");
    assert(status === 200, `Oczekiwano 200, dostałem ${status}`);
    assert(!!(body as { captured_at: string }).captured_at, "Brak pola captured_at");
    assert(Array.isArray((body as { holdings_breakdown: unknown[] }).holdings_breakdown),
      "holdings_breakdown nie jest tablicą");
  }));

  results.push(await run("last-visit ?currency=EUR: EUR value_selected=500", async () => {
    const { body } = await get("last-visit?currency=EUR");
    type Holding = { asset_id: string; value_selected?: number };
    const eur = (body as { holdings_breakdown: Holding[] }).holdings_breakdown.find(h => h.asset_id === "EUR");
    assert(eur !== undefined, "Brak EUR w last-visit");
    assert(Math.abs((eur!.value_selected ?? -1) - 500) < 0.01,
      `Oczekiwano value_selected=500, jest ${eur!.value_selected}`);
  }));

  results.push(await run("last-visit: brak tokena → 401 (bramka verify_jwt)", async () => {
    const status = await statusNoAuth("last-visit");
    assert(status === 401, `Oczekiwano 401, dostałem ${status}`);
  }));

  // ── /snapshot-dates ───────────────────────────────────────────────────────

  results.push(await run("snapshot-dates: zwraca 200 z tablicą dates", async () => {
    const { status, body } = await get("snapshot-dates");
    assert(status === 200, `Oczekiwano 200, dostałem ${status}`);
    assert(Array.isArray((body as { dates: string[] }).dates), "dates nie jest tablicą");
  }));

  results.push(await run("snapshot-dates: po snapszotcie zawiera dzisiejszą datę", async () => {
    const { body } = await get("snapshot-dates");
    const dates = (body as { dates: string[] }).dates;
    assert(dates.includes(TODAY), `Brak ${TODAY} w dates: [${dates.join(", ")}]`);
  }));

  results.push(await run("snapshot-dates: daty posortowane od najnowszej", async () => {
    const { body } = await get("snapshot-dates");
    const dates = (body as { dates: string[] }).dates;
    for (let i = 1; i < dates.length; i++) {
      assert(dates[i - 1] >= dates[i], `Daty nie są posortowane malejąco: ${dates[i - 1]} < ${dates[i]}`);
    }
  }));

  // ── /value-history ───────────────────────────────────────────────────────

  results.push(await run("value-history: zwraca 200 z currency=PLN i tablicą points", async () => {
    const { status, body } = await get("value-history");
    assert(status === 200, `Oczekiwano 200, dostałem ${status}`);
    assert((body as { currency: string }).currency === "PLN", "Oczekiwano currency=PLN");
    assert(Array.isArray((body as { points: unknown[] }).points), "points nie jest tablicą");
  }));

  results.push(await run("value-history: ma >= 160 punktów (syntetyczne dane od 1 stycznia)", async () => {
    const { body } = await get("value-history");
    const len = (body as { points: unknown[] }).points.length;
    assert(len >= 160, `Oczekiwano >= 160 punktów, dostałem ${len}`);
  }));

  results.push(await run("value-history: punkty posortowane chronologicznie", async () => {
    const { body } = await get("value-history");
    const points = (body as { points: { date: string }[] }).points;
    for (let i = 1; i < points.length; i++) {
      assert(points[i - 1].date <= points[i].date,
        `Daty nie rosnące: ${points[i - 1].date} > ${points[i].date}`);
    }
  }));

  results.push(await run("value-history ?category_id=crypto: points mają wartość < całości portfela", async () => {
    const [{ body: total }, { body: crypto }] = await Promise.all([
      get("value-history"),
      get("value-history?category_id=crypto"),
    ]);
    const totalVal = ((total as { points: { value: number }[] }).points[0]?.value ?? 0);
    const cryptoVal = ((crypto as { points: { value: number }[] }).points[0]?.value ?? 0);
    assert(cryptoVal > 0, "Oczekiwano > 0 dla crypto");
    assert(cryptoVal < totalVal, `crypto value (${cryptoVal}) powinno być < total (${totalVal})`);
  }));

  results.push(await run("value-history ?asset_id=BTC: tylko BTC w każdym punkcie", async () => {
    const { body } = await get("value-history?asset_id=BTC");
    const points = (body as { points: { value: number }[] }).points;
    assert(points.length >= 160, `Oczekiwano >= 160 punktów dla BTC, dostałem ${points.length}`);
    assert(points[0].value > 0, "Oczekiwano value > 0 dla BTC");
  }));

  results.push(await run("value-history ?currency=EUR: każdy punkt ma value_selected", async () => {
    const { body } = await get("value-history?currency=EUR");
    const points = (body as { points: { value: number; value_selected?: number }[] }).points;
    for (const p of points) {
      assert(p.value_selected !== undefined, `Brak value_selected dla daty ${(p as unknown as { date: string }).date}`);
      assert(p.value_selected! > 0, "value_selected <= 0");
    }
  }));

  results.push(await run("value-history ?from=&to=: filtrowanie zakresu dat", async () => {
    const { body } = await get("value-history?from=2026-01-01&to=2026-01-31");
    const points = (body as { points: { date: string }[] }).points;
    assert(points.length > 0, "Oczekiwano punktów w zakresie");
    for (const p of points) {
      assert(p.date >= "2026-01-01" && p.date <= "2026-01-31",
        `Data ${p.date} poza zakresem 2026-01-01 – 2026-01-31`);
    }
  }));

  results.push(await run("value-history: currency=BTC (nie waluta) → 400", async () => {
    const { status } = await get("value-history?currency=BTC");
    assert(status === 400, `Oczekiwano 400, dostałem ${status}`);
  }));

  // ── /holdings — CRUD + naliczanie obligacji ───────────────────────────────
  // Minimalny zestaw wywołań (Supabase rate-limituje calle funkcja→funkcja per-przebieg):
  // 2 szybkie testy błędów + jeden pełny cykl POST→/portfolio→PATCH→DELETE na obligacji.

  results.push(await run("holdings: brak tokena → 401 (bramka verify_jwt)", async () => {
    const res = await fetch(`${BASE}/functions/v1/holdings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "crypto", asset_id: "BTC", amount: 1 }),
    });
    await res.text();
    assert(res.status === 401, `Oczekiwano 401, dostałem ${res.status}`);
  }));

  results.push(await run("holdings: nieprawidłowa kategoria → 400", async () => {
    const { status } = await send("POST", "holdings", { category: "spaceships", amount: 1 });
    assert(status === 400, `Oczekiwano 400, dostałem ${status}`);
  }));

  results.push(await run("holdings: cykl obligacji POST→/portfolio→PATCH→DELETE (liniowe odsetki)", async () => {
    const START = "2025-06-22";       // ~rok wstecz względem dzisiaj
    const RATE = 5;
    const name = `${SMOKE_PREFIX} EDO`;

    // POST manual bond
    const created = await send("POST", "holdings", {
      category: "bonds",
      amount: 100,
      custom: { name, unit_value: 1, currency: "PLN", interest_rate: RATE, start_date: START },
    });
    assert(created.status === 201, `POST: oczekiwano 201, dostałem ${created.status}`);
    const h = created.body as { id: string; price_source: string; interest_rate: number };
    assert(typeof h.id === "string" && h.id.length > 0, "POST: brak id w odpowiedzi");
    assert(h.price_source === "manual", `POST: oczekiwano price_source=manual, jest ${h.price_source}`);
    assert(h.interest_rate === RATE, `POST: oczekiwano interest_rate=${RATE}, jest ${h.interest_rate}`);
    const id = h.id;

    try {
      // /portfolio pokazuje pozycję z poprawnie naliczoną wartością (PLN→USD→PLN się znosi)
      const factor = bondFactor(RATE, START, new Date());
      const pRes = await freshGet("portfolio");
      const pBody = pRes.body as { holdings_breakdown?: (Holding & { value_ccy: number; value_usd: number; price_usd: number; amount: number; interest_rate?: number })[] };
      assert(Array.isArray(pBody.holdings_breakdown),
        `/portfolio nie zwrócił holdings_breakdown — status ${pRes.status}, body: ${JSON.stringify(pRes.body)}`);
      const pos = pBody.holdings_breakdown!.find((x) => x.id === id);
      assert(pos !== undefined, "/portfolio: brak utworzonej pozycji");
      assert(pos!.name === name, "/portfolio: zła nazwa pozycji");
      assert(pos!.interest_rate === RATE, `/portfolio: oczekiwano interest_rate=${RATE}, jest ${pos!.interest_rate}`);
      const expectedCcy = 100 * 1 * factor;
      assert(Math.abs(pos!.value_ccy - expectedCcy) < 0.05,
        `/portfolio: oczekiwano value_ccy≈${expectedCcy.toFixed(2)}, jest ${pos!.value_ccy}`);
      assert(Math.abs(pos!.value_usd - pos!.amount * pos!.price_usd) < 0.01,
        "/portfolio: niezmiennik value_usd = amount × price_usd złamany dla obligacji");

      // PATCH amount=200 → weryfikujemy z ODPOWIEDZI PATCH (zwraca zaktualizowany
      // wiersz), bez dodatkowego wywołania /portfolio — oszczędzamy call na rate-limit.
      const patched = await send("PATCH", `holdings/${id}`, { amount: 200 });
      assert(patched.status === 200, `PATCH: oczekiwano 200, dostałem ${patched.status} — body: ${JSON.stringify(patched.body)}`);
      const amt = Number((patched.body as { amount: number }).amount);
      assert(amt === 200, `PATCH: oczekiwano amount=200 w odpowiedzi, jest ${amt}`);
    } finally {
      // Idempotentnie: 200 = usunięto teraz, 404 = pozycja już nie istnieje. Oba OK.
      const del = await send("DELETE", `holdings/${id}`);
      assert(del.status === 200 || del.status === 404, `DELETE: oczekiwano 200/404, dostałem ${del.status} — body: ${JSON.stringify(del.body)}`);
    }
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
 } catch (err) {
  // Siatka bezpieczeństwa: cokolwiek nieprzewidzianego rzuci poza run(), i tak oddajemy
  // JSON z dotychczasowymi wynikami — CI dostaje parsowalny raport zamiast plain-text 500.
  console.error(`[smoke-test] FATAL: ${String(err)}`);
  return new Response(
    JSON.stringify({
      fatal: String(err),
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      total: results.length,
      results,
    }, null, 2),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );
 }
});
