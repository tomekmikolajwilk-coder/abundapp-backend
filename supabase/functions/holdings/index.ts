import { getServiceClient, type Supa } from "../_shared/supabase.ts";
import { badRequest, json, notFound, serverError, serviceUnavailable } from "../_shared/http.ts";
import { resolveUserId } from "../_shared/auth.ts";
import { execPriceUsd, recordTransaction } from "../_shared/transactions.ts";
import { getProvider } from "../_shared/price_providers/index.ts";

// Dodawanie / edycja / usuwanie pozycji portfela. user_id z JWT (claim `sub`).
//
//   POST   /holdings        market: { category, asset_id, amount, display_category? }
//                           manual: { category, amount, custom: { name, unit_value, currency,
//                                                                  display_category?, interest_rate?, start_date? } }
//   PATCH  /holdings/:id     { amount?, unit_value? }
//   DELETE /holdings/:id
//
// Kody błędów jak w reszcie API: 400 zła wejściówka, 404 brak pozycji usera, 500 błąd DB.

const MARKET_CATEGORIES = ["crypto", "stock", "etf", "metal", "currency"];
const MANUAL_CATEGORIES = ["real_estate", "valuables", "bonds", "deposits", "other"];

Deno.serve(async (req) => {
  const userId = resolveUserId(req);
  if (!userId) return badRequest("Missing user_id");

  // Ścieżka po nazwie funkcji: /holdings lub /holdings/:id.
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const idx = parts.lastIndexOf("holdings");
  const id = idx >= 0 ? parts[idx + 1] : undefined;

  const supabase = getServiceClient();

  try {
    switch (req.method) {
      case "POST":
        if (id) return badRequest("POST nie przyjmuje id w ścieżce");
        return await createHolding(supabase, userId, req);
      case "PATCH":
        if (!id) return badRequest("PATCH wymaga /holdings/:id");
        return await patchHolding(supabase, userId, id, req);
      case "DELETE":
        if (!id) return badRequest("DELETE wymaga /holdings/:id");
        return await deleteHolding(supabase, userId, id);
      default:
        return badRequest(`Nieobsługiwana metoda ${req.method}`);
    }
  } catch (err) {
    // Spójny 500 { error } zamiast plain-text "Internal Server Error" z runtime'u.
    console.error(`[holdings] ERROR: ${String(err)}`);
    return serverError(String(err));
  }
});

async function parseBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// On-demand pobranie ceny przy dodaniu pozycji, gdy nie ma jej jeszcze w price_cache.
// Best-effort: tylko dla źródeł z providerem rotacji (twelve_data). Źródła z własnym cronem
// (coingecko → fetch-crypto co 5 min) nie mają providera tutaj — cena dosypie się sama wkrótce.
// Porażka nie blokuje utworzenia pozycji (jak reszta przepływu ledgera).
// Zwraca cenę oraz `transient` — czy brak ceny wynika z czkawki źródła (cały request padł),
// czy z genuine braku notowań dla symbolu. To rozróżnienie steruje potem 503 vs 400.
async function fetchPriceOnDemand(
  supabase: Supa,
  assetId: string,
  apiSource: string,
  apiSymbol: string,
): Promise<{ price: number | null; transient: boolean }> {
  const provider = getProvider(apiSource);
  if (!provider) return { price: null, transient: false };
  try {
    const { rows, requestFailed } = await provider.fetchBatch([{ asset_id: assetId, api_symbol: apiSymbol }]);
    if (rows.length > 0) {
      await supabase.from("price_cache").upsert(rows, { onConflict: "asset_id" });
      console.log(`[holdings] on-demand: pobrano kurs ${assetId} = ${rows[0].price_usd}`);
      return { price: rows[0].price_usd, transient: false };
    }
    // Brak ceny: czkawka źródła (cały request padł) vs genuine brak notowań symbolu.
    return { price: null, transient: requestFailed === true };
  } catch (err) {
    // fetchBatch sam łapie błędy, ale gdyby coś przeszło — traktujemy jako przejściowe.
    console.warn(`[holdings] on-demand fetch ${assetId} nieudany: ${String(err)}`);
    return { price: null, transient: true };
  }
}

// Add-time guard ceny dla pozycji market. Zwraca wycenę (jeśli znana) oraz, gdy blokujemy,
// czy powód jest przejściowy (`transient`) — od tego zależy czy front pokaże „spróbuj ponownie".
//   - cache ma kurs            → { price, blocked:false }
//   - brak + provider rotacji  → on-demand; sukces → cena; brak → blocked (+ transient gdy czkawka)
//   - brak + brak providera    → { price:null, blocked:false } (crypto/metal: własny cron dosypie cenę)
async function resolveMarketPrice(
  supabase: Supa,
  assetId: string,
  apiSource: string,
  apiSymbol: string,
): Promise<{ price: number | null; blocked: boolean; transient: boolean }> {
  const cached = await execPriceUsd(supabase, { price_source: "market", asset_id: assetId, unit_value: null, currency: null });
  if (cached != null) return { price: cached, blocked: false, transient: false };
  if (!getProvider(apiSource)) return { price: null, blocked: false, transient: false };
  const { price, transient } = await fetchPriceOnDemand(supabase, assetId, apiSource, apiSymbol);
  if (price != null) return { price, blocked: false, transient: false };
  return { price: null, blocked: true, transient };
}

async function createHolding(supabase: Supa, userId: string, req: Request): Promise<Response> {
  const body = await parseBody(req);
  if (!body) return badRequest("Nieprawidłowy JSON");

  const { category, asset_id, amount, custom, display_category } = body;

  if (typeof amount !== "number" || !(amount > 0)) return badRequest("amount musi być liczbą > 0");

  // ── MARKET — cenę zna backend, user podaje tylko asset_id + amount ──────────
  if (typeof category === "string" && MARKET_CATEGORIES.includes(category)) {
    if (typeof asset_id !== "string") return badRequest("market: wymagany asset_id");

    const { data: def, error } = await supabase
      .from("asset_definitions").select("category, api_source, api_symbol")
      .eq("asset_id", asset_id).eq("active", true).single();
    if (error || !def) return badRequest(`Nieznany lub nieaktywny asset ${asset_id}`);
    if (def.category !== category) {
      return badRequest(`asset ${asset_id} ma kategorię ${def.category}, nie ${category}`);
    }

    // Add-time guard: wyceniamy PRZED insertem — pozycja bez kursu nie wchodzi do portfela.
    // Rozróżniamy: czkawka źródła (503, „spróbuj ponownie") vs trwały brak notowań (400, „wybierz inne").
    const { price, blocked, transient } = await resolveMarketPrice(supabase, asset_id, def.api_source as string, def.api_symbol as string);
    if (blocked) {
      return transient
        ? serviceUnavailable(`Chwilowy problem z pobraniem kursu dla ${asset_id} — spróbuj ponownie za chwilę.`)
        : badRequest(`Brak notowań dla ${asset_id} — nie można dodać pozycji (źródło ceny nie zwraca kursu).`);
    }

    // Merge: jedna pozycja market na (user, asset_id) — dodanie już trzymanego assetu
    // INKREMENTUJE ilość zamiast tworzyć duplikat (#7). Transakcja i tak buy na DODANĄ ilość.
    const existing = (await supabase
      .from("holdings").select("id, amount")
      .eq("user_id", userId).eq("asset_id", asset_id).eq("price_source", "market")
      .maybeSingle()).data;

    const saved = existing
      ? await supabase.from("holdings")
        .update({ amount: Number(existing.amount) + amount })
        .eq("id", existing.id).select().single()
      : await supabase.from("holdings").insert({
        user_id: userId,
        price_source: "market",
        category: def.category,
        asset_id,
        amount,
        display_category: typeof display_category === "string" ? display_category : null,
      }).select().single();
    if (saved.error) return serverError(saved.error.message);
    const data = saved.data;

    // Ledger: buy na DODANĄ ilość po wycenie sprzed zapisu. price bywa null tylko dla źródeł bez
    // providera (crypto/metal chwilowo bez cache) — wtedy pomijamy wpis, dosypie się z własnego cronu.
    if (price != null) {
      await recordTransaction(supabase, {
        userId, holdingId: data.id, assetId: asset_id, name: null,
        category: def.category, side: "buy", amount, execPriceUsd: price,
      });
    } else {
      console.warn(`[holdings] brak kursu dla ${asset_id} — pomijam wpis do ledgera`);
    }
    return json(data, existing ? 200 : 201);
  }

  // ── MANUAL — cenę podaje user przez custom.unit_value (w walucie custom.currency) ──
  if (typeof category === "string" && MANUAL_CATEGORIES.includes(category)) {
    if (!custom || typeof custom !== "object") return badRequest("manual: wymagany obiekt custom");
    const c = custom as Record<string, unknown>;

    const name = c.name;
    const unit_value = c.unit_value;
    const currency = c.currency;

    if (typeof name !== "string" || name.trim() === "") return badRequest("manual: wymagany name");
    if (typeof unit_value !== "number" || !(unit_value > 0)) return badRequest("manual: unit_value musi być > 0");
    if (typeof currency !== "string") return badRequest("manual: wymagana currency");

    // currency musi dać się przeliczyć na USD: USD wprost = 1, reszta = aktywna waluta z katalogu.
    if (currency !== "USD") {
      const { data: cur, error } = await supabase
        .from("asset_definitions").select("asset_id")
        .eq("asset_id", currency).eq("category", "currency").eq("active", true).single();
      if (error || !cur) return badRequest(`Nieznana waluta ${currency}`);
    }

    // Obligacje: opcjonalna stopa + start_date (domyślnie dziś). Reszta manual nie nalicza odsetek.
    let interestRate: number | null = null;
    let startDate: string | null = null;
    if (category === "bonds") {
      if (c.interest_rate != null) {
        if (typeof c.interest_rate !== "number") return badRequest("bonds: interest_rate musi być liczbą");
        interestRate = c.interest_rate;
      }
      startDate = typeof c.start_date === "string" ? c.start_date : new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return badRequest("bonds: start_date musi być w formacie YYYY-MM-DD");
    }

    // display_category może przyjść w custom albo (dla spójności) poza nim.
    const dc = typeof c.display_category === "string"
      ? c.display_category
      : (typeof display_category === "string" ? display_category : null);

    const { data, error: insErr } = await supabase.from("holdings").insert({
      user_id: userId,
      price_source: "manual",
      category,
      amount,
      name: name.trim(),
      unit_value,
      currency,
      display_category: dc,
      interest_rate: interestRate,
      start_date: startDate,
    }).select().single();
    if (insErr) return serverError(insErr.message);

    // Ledger: buy całości po cenie unit_value→USD. Brak kursu waluty → pomijamy.
    const price = await execPriceUsd(
      supabase,
      { price_source: "manual", asset_id: null, unit_value, currency },
    );
    if (price != null) {
      await recordTransaction(supabase, {
        userId, holdingId: data.id, assetId: null, name: name.trim(),
        category, side: "buy", amount, execPriceUsd: price,
      });
    } else {
      console.warn(`[holdings] brak kursu waluty ${currency} — pomijam wpis do ledgera`);
    }
    return json(data, 201);
  }

  return badRequest(`Nieprawidłowa kategoria ${category}`);
}

async function patchHolding(supabase: Supa, userId: string, id: string, req: Request): Promise<Response> {
  const body = await parseBody(req);
  if (!body) return badRequest("Nieprawidłowy JSON");

  const { amount, unit_value } = body;
  const update: Record<string, unknown> = {};

  if (amount !== undefined) {
    if (typeof amount !== "number" || !(amount > 0)) return badRequest("amount musi być liczbą > 0");
    update.amount = amount;
  }
  if (unit_value !== undefined) {
    if (typeof unit_value !== "number" || !(unit_value > 0)) return badRequest("unit_value musi być liczbą > 0");
    update.unit_value = unit_value;
  }
  if (Object.keys(update).length === 0) return badRequest("Brak pól do zmiany (amount/unit_value)");

  // Najpierw potwierdzamy własność i klasę pozycji — czysty 404/400 zamiast błędu constraintu.
  // Zaciągamy też pola do ledgera (stary amount na deltę + dane do wpisu).
  const { data: existing, error: findErr } = await supabase
    .from("holdings").select("price_source, category, amount, asset_id, name, unit_value, currency")
    .eq("id", id).eq("user_id", userId).single();
  if (findErr || !existing) return notFound(`Holding ${id} nie znaleziony`);
  if (update.unit_value !== undefined && existing.price_source !== "manual") {
    return badRequest("unit_value można zmienić tylko dla pozycji manual");
  }

  update.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("holdings").update(update)
    .eq("id", id).eq("user_id", userId)
    .select().single();
  if (error || !data) return serverError(error?.message ?? "Update failed");

  // Ledger: zmiana amount = przepływ (delta>0 buy, <0 sell) po bieżącej cenie.
  // Rewaluacja unit_value sama w sobie to NIE transakcja (to ruch ceny). Jeśli PATCH
  // zmienia oba naraz, delta ilości wykonuje się po cenie po rewaluacji (nowy unit_value).
  if (update.amount !== undefined) {
    const delta = (update.amount as number) - existing.amount;
    if (delta !== 0) {
      const effUnit = update.unit_value !== undefined
        ? (update.unit_value as number)
        : existing.unit_value;
      const price = await execPriceUsd(
        supabase,
        { price_source: existing.price_source, asset_id: existing.asset_id, unit_value: effUnit, currency: existing.currency },
      );
      if (price != null) {
        await recordTransaction(supabase, {
          userId, holdingId: id, assetId: existing.asset_id, name: existing.name,
          category: existing.category, side: delta > 0 ? "buy" : "sell",
          amount: Math.abs(delta), execPriceUsd: price,
        });
      }
    }
  }

  return json(data);
}

async function deleteHolding(supabase: Supa, userId: string, id: string): Promise<Response> {
  // Pobieramy wiersz PRZED kasowaniem — potrzebny do ledgera (sell całości) i do 404.
  const { data: row, error: findErr } = await supabase
    .from("holdings").select("price_source, category, amount, asset_id, name, unit_value, currency")
    .eq("id", id).eq("user_id", userId).single();
  if (findErr || !row) return notFound(`Holding ${id} nie znaleziony`);

  // Ledger: sell całej ilości po bieżącej cenie. holding_id wyzeruje się przy delete
  // (FK ON DELETE SET NULL) — wpis zostaje w historii z asset_id/name/category.
  const price = await execPriceUsd(supabase, row);
  if (price != null) {
    await recordTransaction(supabase, {
      userId, holdingId: id, assetId: row.asset_id, name: row.name,
      category: row.category, side: "sell", amount: row.amount, execPriceUsd: price,
    });
  }

  const { error } = await supabase
    .from("holdings").delete()
    .eq("id", id).eq("user_id", userId);
  if (error) return serverError(error.message);
  return json({ deleted: true, id });
}
