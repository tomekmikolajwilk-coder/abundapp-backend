// Ustalenie user_id dla endpointów per-user.
//
// Bramka Supabase (verify_jwt=true) weryfikuje PODPIS tokena zanim funkcja wystartuje.
// user_id bierzemy WYŁĄCZNIE z claim `sub` tokena zalogowanego usera — bez żadnego
// fallbacku na ?user_id=. Dzięki temu nikt (nawet z ważnym anon key, który jest
// publiczny) nie poda cudzego id i nie odczyta nie swoich danych.
//
//   • token usera (role=authenticated) → user_id = `sub`.
//   • anon / service_role / brak `sub` → null (brak dostępu do danych per-user).
export function resolveUserId(req: Request): string | null {
  const claims = decodeBearer(req.headers.get("Authorization"));
  if (claims?.role !== "authenticated") return null;
  return typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : null;
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
