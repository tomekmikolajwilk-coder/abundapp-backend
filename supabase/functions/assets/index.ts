import { createClient } from "npm:@supabase/supabase-js@2";

// Publiczny endpoint — zwraca wszystkie aktywa z aktualnym kursem, pogrupowane po kategorii.
// Używany przez frontend do wyświetlenia listy dostępnych aktywów i ich cen.
Deno.serve(async () => {
  console.log("=== assets START ===");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data, error } = await supabase
    .from("price_cache")
    .select("asset_id, price_usd, category, updated_at")
    .order("asset_id");

  if (error) {
    console.error(`[assets] DB error: ${error.message}`);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Grupujemy po kategorii żeby frontend mógł łatwo renderować osobne sekcje
  // (np. "Krypto", "Akcje", "Metale", "Waluty") bez dodatkowej logiki po swojej stronie.
  const grouped: Record<string, typeof data> = {};
  for (const row of data ?? []) {
    if (!grouped[row.category]) grouped[row.category] = [];
    grouped[row.category].push(row);
  }

  console.log(
    `[assets] Returning ${data?.length ?? 0} assets in categories: ${Object.keys(grouped).join(", ")}`
  );
  console.log("=== assets DONE ===");

  return new Response(JSON.stringify(grouped), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
