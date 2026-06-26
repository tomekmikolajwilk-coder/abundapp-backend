import { getServiceClient, type Supa } from "../_shared/supabase.ts";
import { badRequest, json, serverError } from "../_shared/http.ts";

// Dwa endpointy pod jedną funkcją (Supabase routuje po nazwie funkcji = pierwszym segmencie):
//   GET /assets               — wszystkie aktywa z kursem, pogrupowane po kategorii (hurt, jak dotąd).
//   GET /assets/search?q=&category=&exchange=  — paginowany search po katalogu (picker Fazy 3).
// /assets hurtem ma sens dla małych zbiorów (krypto top-100, waluty, metale); dla tysięcy
// stock/ETF picker używa /assets/search (search-as-you-type, trigram po nazwie/tickerze).
Deno.serve(async (req) => {
  const supabase = getServiceClient();
  const url = new URL(req.url);
  const last = url.pathname.split("/").filter(Boolean).pop();

  try {
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
  const results = hasMore ? rows.slice(0, limit) : rows;

  console.log(`[assets/search] q="${q}" cat=${category ?? "-"} exch=${exchange ?? "-"} → ${results.length} (more=${hasMore})`);
  return json({ results, limit, offset, has_more: hasMore });
}

// Parsuje int z query-param z domyślną wartością i zakresem; nie-liczba → default.
function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = raw == null ? def : parseInt(raw, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
}
