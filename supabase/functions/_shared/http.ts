// Helpery do odpowiedzi JSON — zamiast powtarzać new Response(JSON.stringify(...), {...})
// w każdym endpoincie. json() buduje odpowiedź sukcesu, reszta to skróty na typowe błędy.

const JSON_HEADERS = { "Content-Type": "application/json" };

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// Skróty na błędy ze spójnym kształtem { error: msg } i właściwym kodem HTTP.
export function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

export function notFound(message: string): Response {
  return json({ error: message }, 404);
}

// 503 — usługa chwilowo niedostępna (np. zewnętrzne źródło ceny miało czkawkę).
// `transient: true` mówi frontendowi „to przejściowe, user może spróbować ponownie"
// — w odróżnieniu od 400, które oznacza trwały brak (np. symbol bez notowań).
export function serviceUnavailable(message: string): Response {
  return json({ error: message, transient: true }, 503);
}

export function serverError(message: string): Response {
  return json({ error: message }, 500);
}
