import { createClient } from "npm:@supabase/supabase-js@2";

// Jeden punkt tworzenia klienta z kluczem service_role (pełny dostęp, omija RLS).
// Typ Supa pochodzi z tego samego wywołania co instancja, dzięki czemu generyki
// supabase-js zgadzają się we wszystkich helperach przyjmujących klienta.
export function getServiceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

export type Supa = ReturnType<typeof getServiceClient>;
