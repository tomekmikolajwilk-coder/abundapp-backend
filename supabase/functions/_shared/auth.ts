// Ustalenie user_id dla endpointów per-user.
//
// Bramka Supabase (verify_jwt=true) weryfikuje PODPIS tokena zanim funkcja wystartuje,
// ale przepuszcza KAŻDY ważny token projektu — w tym anon key, który jest publiczny
// (zaszyty w aplikacji). Dlatego user_id ustalamy świadomie wg roli tokena:
//
//   • authenticated → user_id WYŁĄCZNIE z claim `sub`. Query param ignorowany,
//     żeby posiadacz dowolnego tokena nie podał cudzego ?user_id= i nie czytał
//     nie swoich danych.
//   • service_role → fallback na ?user_id= dozwolony. To klucz sekretny (nie trafia
//     do klienta), używany serwerowo (smoke-test, narzędzia) — może działać "za usera".
//   • anon / brak tokena → null. Zewnętrzny wołający nie ma dostępu do danych per-user.
export function resolveUserId(req: Request, url: URL): string | null {
  const claims = decodeBearer(req.headers.get("Authorization"));

  if (claims?.role === "authenticated") {
    return typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : null;
  }
  if (claims?.role === "service_role") {
    return url.searchParams.get("user_id");
  }
  return null;
}

type JwtClaims = { sub?: unknown; role?: unknown };

function decodeBearer(header: string | null): JwtClaims | null {
  if (!header?.startsWith("Bearer ")) return null;

  const parts = header.slice(7).trim().split(".");
  if (parts.length !== 3) return null;

  try {
    return JSON.parse(decodeJwtSegment(parts[1])) as JwtClaims;
  } catch {
    return null;
  }
}

// base64url → string (segmenty JWT są base64url, bez paddingu).
function decodeJwtSegment(segment: string): string {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
  return atob(padded);
}
