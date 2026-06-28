import { getServiceClient, type Supa } from "../_shared/supabase.ts";
import { badRequest, json, notFound, serverError } from "../_shared/http.ts";
import { eodhdAssetId, eodhdSearch, eodhdTypeToCategory, SUPPORTED_EODHD_EXCHANGES } from "../_shared/eodhd.ts";

// Endpointy pod jedną funkcją (Supabase routuje po nazwie funkcji = pierwszym segmencie):
//   GET  /assets               — wszystkie aktywa z kursem, pogrupowane po kategorii (hurt).
//   GET  /assets/search?q=…    — paginowany search po NASZYM katalogu (picker, trigram).
//   GET  /assets/discover?q=…  — szuka w EODHD tego, czego NIE mamy w katalogu (request-asset).
//   POST /assets/request {code,exchange} — dodaje wybrany ticker z EODHD do asset_definitions.
// Katalog trzymamy mały (popularne) → szybki search; długi ogon dochodzi na żądanie usera.
Deno.serve(async (req) => {
  const supabase = getServiceClient();
  const url = new URL(req.url);
  const last = url.pathname.split("/").filter(Boolean).pop();

  try {
    if (last === "discover") return await handleDiscover(supabase, url);
    if (last === "request") return await handleRequest(supabase, req);
    if (last === "search") return await handleSearch(supabase, url);
    return await handleAll(supabase);
  } catch (err) {
    console.error(`[assets] ERROR: ${String(err)}`);
    return serverError(String(err));
  }
});

// ── GET /assets — wszystko z kursem, pogrupowane po kategorii ─────────────────
async function handleAll(supabase: Supa): Promise<Response> {
  console.log("=== assets START ===");

  // asset_definitions jest źródłem prawdy dla category i display_name.
  // price_cache zawiera tylko asset_id, price_usd, updated_at.
  const [pricesResult, defsResult] = await Promise.all([
    supabase.from("price_cache").select("asset_id, price_usd, updated_at").order("asset_id"),
    supabase.from("asset_definitions").select("asset_id, category, display_name").eq("active", true),
  ]);

  if (pricesResult.error || defsResult.error) {
    const msg = pricesResult.error?.message ?? defsResult.error?.message;
    console.error(`[assets] DB error: ${msg}`);
    return serverError(msg ?? "DB error");
  }

  const defMap: Record<string, { category: string; display_name: string }> = {};
  for (const def of defsResult.data ?? []) {
    defMap[def.asset_id] = { category: def.category, display_name: def.display_name };
  }

  const grouped: Record<string, unknown[]> = {};
  for (const row of pricesResult.data ?? []) {
    const def = defMap[row.asset_id];
    if (!def) continue; // asset w price_cache ale nie ma go w asset_definitions — pomijamy

    if (!grouped[def.category]) grouped[def.category] = [];
    grouped[def.category].push({
      asset_id: row.asset_id,
      display_name: def.display_name,
      price_usd: row.price_usd,
      category: def.category,
      updated_at: row.updated_at,
    });
  }

  console.log(`[assets] Returning ${pricesResult.data?.length ?? 0} assets in categories: ${Object.keys(grouped).join(", ")}`);
  console.log("=== assets DONE ===");
  return json(grouped);
}

// ── GET /assets/search — paginowany katalog dla pickera ──────────────────────
// Parametry: q (podłańcuch nazwy/tickera), category, exchange, limit (≤50), offset.
// Wymaga q (≥2 znaki) ALBO category — inaczej zwracalibyśmy cały katalog (sens /assets).
const SEARCH_MAX_LIMIT = 50;
const SEARCH_DEFAULT_LIMIT = 20;

async function handleSearch(supabase: Supa, url: URL): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();
  const category = url.searchParams.get("category");
  const exchange = url.searchParams.get("exchange");

  if (q.length < 2 && !category) {
    return badRequest("search: wymagane q (≥2 znaki) lub category");
  }

  const limit = clampInt(url.searchParams.get("limit"), SEARCH_DEFAULT_LIMIT, 1, SEARCH_MAX_LIMIT);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

  let query = supabase
    .from("asset_definitions")
    .select("asset_id, category, display_name, exchange, country")
    .eq("active", true);

  if (category) query = query.eq("category", category);
  if (exchange) query = query.eq("exchange", exchange);
  if (q.length >= 2) {
    // ILIKE po nazwie LUB tickerze — oba mają indeks trigramowy (gin_trgm_ops).
    const safe = q.replace(/[%_,]/g, (m) => `\\${m}`); // escape wildcardów/separatora PostgREST
    query = query.or(`display_name.ilike.%${safe}%,asset_id.ilike.%${safe}%`);
  }

  // limit+1 = tani sygnał „jest więcej" bez COUNT(*) po całym katalogu.
  const { data, error } = await query
    .order("display_name")
    .range(offset, offset + limit); // range jest inkluzywny → pobiera limit+1

  if (error) {
    console.error(`[assets/search] DB error: ${error.message}`);
    return serverError(error.message);
  }

  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const local = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({ ...r, in_catalog: true }));

  // Fold-in EODHD: gdy ?include_eodhd=true, doklejamy kandydatów z EODHD spoza katalogu
  // (np. UEC) — user szuka po WSZYSTKIM, co EODHD wspiera, nie tylko po naszym seedzie.
  // Tylko 1. strona (offset=0) — paginacja dotyczy katalogu lokalnego; EODHD to dogrywka.
  const results: Record<string, unknown>[] = [...local];
  const includeEodhd = url.searchParams.get("include_eodhd") === "true";
  if (includeEodhd && offset === 0 && q.length >= 2) {
    const apiKey = Deno.env.get("EODHD_API_KEY");
    if (apiKey) {
      try {
        const localIds = new Set(local.map((r) => r.asset_id as string));
        for (const c of await eodhdCandidates(apiKey, q)) {
          if (!localIds.has(c.asset_id)) results.push({ ...c, country: null, in_catalog: false });
        }
      } catch (err) {
        console.warn(`[assets/search] EODHD fold-in nieudany (zwracam tylko lokalne): ${String(err)}`);
      }
    }
  }

  console.log(`[assets/search] q="${q}" cat=${category ?? "-"} exch=${exchange ?? "-"} eodhd=${includeEodhd} → ${results.length} (more=${hasMore})`);
  return json({ results, limit, offset, has_more: hasMore });
}

// Kandydaci z EODHD (akcje/ETF z obsługiwanych giełd), znormalizowani do kształtu wyniku.
// Wspólne dla /discover i fold-inu w /search. Nie sprawdza katalogu — to robi wołający.
type EodhdCandidate = { asset_id: string; code: string; exchange: string; display_name: string; category: "stock" | "etf"; currency: string | null };
async function eodhdCandidates(apiKey: string, q: string): Promise<EodhdCandidate[]> {
  const hits = await eodhdSearch(apiKey, q);
  // Tylko obsługiwane giełdy (mamy FX) + typy stock/etf. Odrzuca cross-listingi z egzotyk,
  // tokenizowane (CC), lewarowane spoza naszych giełd itd.
  return hits
    .filter((h) => SUPPORTED_EODHD_EXCHANGES.has(h.Exchange) && eodhdTypeToCategory(h.Type) !== null)
    .map((h) => ({
      asset_id: eodhdAssetId(h.Code, h.Exchange),
      code: h.Code,
      exchange: h.Exchange,
      display_name: h.Name,
      category: eodhdTypeToCategory(h.Type)!,
      currency: h.Currency ?? null,
    }));
}

// ── GET /assets/discover?q= — szukaj w EODHD tego, czego nie ma w katalogu ─────
// Zwraca kandydatów (akcje/ETF z obsługiwanych giełd) z flagą in_catalog. Osobny endpoint
// na wypadek czystego „discover"; w pickerze prościej użyć /search?include_eodhd=true (jeden call).
async function handleDiscover(supabase: Supa, url: URL): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return badRequest("discover: wymagane q (≥2 znaki)");
  const apiKey = Deno.env.get("EODHD_API_KEY");
  if (!apiKey) return serverError("Brak EODHD_API_KEY");

  const candidates = await eodhdCandidates(apiKey, q);
  const ids = [...new Set(candidates.map((c) => c.asset_id))];
  const have = new Set<string>();
  if (ids.length > 0) {
    const { data } = await supabase.from("asset_definitions").select("asset_id").in("asset_id", ids);
    for (const r of data ?? []) have.add(r.asset_id as string);
  }

  const results = candidates.map((c) => ({ ...c, in_catalog: have.has(c.asset_id) }));
  console.log(`[assets/discover] q="${q}" → ${results.length} kandydatów`);
  return json({ query: q, results });
}

// ── POST /assets/request {code, exchange} — dodaj ticker z EODHD do katalogu ───
// Idempotentne: jak już jest w katalogu, zwraca istniejący. Weryfikuje w EODHD (Code+Exchange,
// typ stock/etf) zanim doda — czyli „jeśli jest w EODHD to dodajemy, jak nie ma to trudno".
async function handleRequest(supabase: Supa, req: Request): Promise<Response> {
  const apiKey = Deno.env.get("EODHD_API_KEY");
  if (!apiKey) return serverError("Brak EODHD_API_KEY");

  let body: Record<string, unknown> | null;
  try { body = await req.json(); } catch { return badRequest("Nieprawidłowy JSON"); }
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  const exchange = typeof body?.exchange === "string" ? body.exchange.trim() : "";
  if (!code || !exchange) return badRequest("request: wymagane code + exchange");
  if (!SUPPORTED_EODHD_EXCHANGES.has(exchange)) return badRequest(`Giełda ${exchange} nieobsługiwana`);

  const assetId = eodhdAssetId(code, exchange);

  // Już w katalogu → idempotentnie zwróć (nie traktuj jako błąd).
  const { data: existing } = await supabase
    .from("asset_definitions").select("asset_id, category, display_name, exchange, country")
    .eq("asset_id", assetId).maybeSingle();
  if (existing) return json({ added: false, asset: existing });

  // Weryfikacja w EODHD: dokładny Code+Exchange o typie stock/etf.
  const hits = await eodhdSearch(apiKey, code);
  const hit = hits.find((h) => h.Code === code && h.Exchange === exchange && eodhdTypeToCategory(h.Type) !== null);
  if (!hit) return notFound(`${code}.${exchange} nie znaleziony w EODHD (lub nieobsługiwany typ)`);

  const { data, error } = await supabase.from("asset_definitions").insert({
    asset_id: assetId,
    category: eodhdTypeToCategory(hit.Type)!,
    api_source: "eodhd",
    api_symbol: `${code}.${exchange}`, // EODHD nie czyta tego pola (NOT NULL) — kładziemy symbol EODHD
    display_name: hit.Name,
    exchange,
    country: hit.Country ?? null,
    active: true,
  }).select("asset_id, category, display_name, exchange, country").single();
  if (error) return serverError(error.message);

  console.log(`[assets/request] dodano ${assetId} (${hit.Name})`);
  return json({ added: true, asset: data }, 201);
}

// Parsuje int z query-param z domyślną wartością i zakresem; nie-liczba → default.
function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = raw == null ? def : parseInt(raw, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
}
