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

export function serverError(message: string): Response {
  return json({ error: message }, 500);
}
