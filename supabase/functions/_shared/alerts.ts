import type { Supa } from "./supabase.ts";

// Alert mailowy przez Resend. Brak kluczy (RESEND_API_KEY / ALERT_EMAIL) = cicho pomijamy,
// żeby brak konfiguracji maila nie wywalał funkcji crona.
export async function sendAlertEmail(subject: string, body: string): Promise<void> {
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const alertEmail = Deno.env.get("ALERT_EMAIL");
  if (!resendKey || !alertEmail) {
    console.warn("[Email] Brak RESEND_API_KEY lub ALERT_EMAIL — pomijam wysyłkę");
    return;
  }
  console.log(`[Email] Wysyłam alert na ${alertEmail}: "${subject}"`);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "abundapp <onboarding@resend.dev>",
      to: alertEmail,
      subject,
      html: `<p><strong>Czas:</strong> ${new Date().toISOString()}</p><pre style="background:#f4f4f4;padding:12px;line-height:2">${body.split("\n").join("<br>")}</pre>`,
    }),
  });
  console.log(`[Email] Resend HTTP ${res.status}`);
}

// Wpis do cron_logs. function_name podaje wołająca funkcja; reszta pól opisuje wynik.
export async function writeCronLog(
  supabase: Supa,
  functionName: string,
  result: {
    success: boolean;
    itemsProcessed: number | null;
    errorMessage: string | null;
    warnings: string | null;
  },
): Promise<void> {
  const { error } = await supabase.from("cron_logs").insert({
    function_name: functionName,
    success: result.success,
    items_processed: result.itemsProcessed,
    error_message: result.errorMessage,
    warnings: result.warnings,
  });
  if (error) console.error(`[DB] Błąd zapisu cron_logs: ${error.message}`);
}
