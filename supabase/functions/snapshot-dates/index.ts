import { createClient } from "npm:@supabase/supabase-js@2";

// GET /snapshot-dates?user_id=UUID
//
// Zwraca listę dat cron-snapshotów dla danego usera — posortowane od najnowszej.
// Frontend używa tego żeby wiedzieć które opcje PnL są dostępne (wczoraj, SOW, SOM, SOY).
// Jeśli brak snapshotu z danej daty — opcja nie jest wyświetlana.
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const userId = url.searchParams.get("user_id");

  if (!userId) {
    return new Response(JSON.stringify({ error: "Missing user_id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data, error } = await supabase
    .from("portfolio_snapshots")
    .select("captured_at")
    .eq("user_id", userId)
    .eq("source", "cron")
    .order("captured_at", { ascending: false });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Wyciągamy samą datę (YYYY-MM-DD) z timestampa — bez godziny.
  const dates = (data ?? []).map((row) => row.captured_at.slice(0, 10));

  return new Response(JSON.stringify({ dates }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
