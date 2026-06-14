import { getServiceClient } from "../_shared/supabase.ts";
import { json, serverError } from "../_shared/http.ts";

// Publiczny endpoint — zwraca wszystkie aktywa z aktualnym kursem, pogrupowane po kategorii.
// Używany przez frontend do wyświetlenia listy dostępnych aktywów i ich cen.
Deno.serve(async () => {
  console.log("=== assets START ===");

  const supabase = getServiceClient();

  // Pobieramy ceny i definicje równolegle.
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

  // Budujemy lookup asset_id → { category, display_name }
  const defMap: Record<string, { category: string; display_name: string }> = {};
  for (const def of defsResult.data ?? []) {
    defMap[def.asset_id] = { category: def.category, display_name: def.display_name };
  }

  // Grupujemy po kategorii i wzbogacamy o display_name
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

  console.log(
    `[assets] Returning ${pricesResult.data?.length ?? 0} assets in categories: ${Object.keys(grouped).join(", ")}`
  );
  console.log("=== assets DONE ===");

  return json(grouped);
});
