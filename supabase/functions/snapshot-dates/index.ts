import { getServiceClient } from "../_shared/supabase.ts";
import { badRequest, json, serverError } from "../_shared/http.ts";
import { resolveUserId } from "../_shared/auth.ts";

// GET /snapshot-dates?user_id=UUID
//
// Zwraca listę dat cron-snapshotów dla danego usera — posortowane od najnowszej.
// Frontend używa tego żeby wiedzieć które opcje PnL są dostępne (wczoraj, SOW, SOM, SOY).
// Jeśli brak snapshotu z danej daty — opcja nie jest wyświetlana.
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const userId = resolveUserId(req, url);

  if (!userId) return badRequest("Missing user_id");

  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("portfolio_snapshots")
    .select("captured_at")
    .eq("user_id", userId)
    .eq("source", "cron")
    .order("captured_at", { ascending: false });

  if (error) return serverError(error.message);

  // Wyciągamy samą datę (YYYY-MM-DD) z timestampa — bez godziny.
  const dates = (data ?? []).map((row) => row.captured_at.slice(0, 10));

  return json({ dates });
});
