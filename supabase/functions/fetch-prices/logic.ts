// Czysta logika doboru assetów do pobrania i obsługi awarii.
// Wydzielona z index.ts żeby dało się ją testować bez sieci, bazy i sekretów —
// to tu siedzi maszyna stanu (rotacja kursora, licznik prób, reset dzienny),
// czyli miejsce najbardziej podatne na błędy.

export const REQUEST_SIZE = 8;        // ile assetów bierzemy w jednym wywołaniu (= 8 kredytów Twelve Data)
export const MAX_FAILS_PER_DAY = 3;   // po tylu nieudanych próbach asset wypada z rotacji do końca doby UTC

export type AssetCandidate = {
  asset_id: string;
  api_symbol: string;
  updated_at: string | null;   // z price_cache; null = nigdy nie pobrany (nowy ticker) → idzie pierwszy
};

export type DamagedRecord = {
  asset_id: string;
  fail_count: number;
  last_failed_at: string;      // ISO
};

export type FetchOutcome = { asset_id: string; ok: boolean };

// Co zrobić z wierszem w damaged_assets po tym wywołaniu.
export type DamagedUpdate =
  | { op: "clear"; asset_id: string }                                              // sukces → skasuj wpis
  | { op: "set"; asset_id: string; fail_count: number; last_failed_at: string };   // porażka → upsert licznika

export type Alert = { asset_id: string; fail_count: number };

// Czy moment z ISO to ten sam dzień UTC co `now` — podstawa dziennego resetu licznika.
function sameUtcDay(iso: string, now: Date): boolean {
  return iso.slice(0, 10) === now.toISOString().slice(0, 10);
}

// Asset jest "uszkodzony dzisiaj" gdy wyczerpał limit prób w bieżącej dobie UTC.
// Tylko wtedy wypada z kolejki — wczorajsze awarie się nie liczą (reset dzienny dzieje się sam).
function isDamagedToday(d: DamagedRecord, now: Date): boolean {
  return d.fail_count >= MAX_FAILS_PER_DAY && sameUtcDay(d.last_failed_at, now);
}

// Które assety pobrać w tym wywołaniu: najstarsze najpierw, nowe (updated_at=null) na samym początku,
// z pominięciem tych które dziś już wyczerpały próby. Zwraca maksymalnie `limit` pozycji.
export function pickAssets(
  candidates: AssetCandidate[],
  damaged: DamagedRecord[],
  now: Date,
  limit = REQUEST_SIZE,
): AssetCandidate[] {
  const blocked = new Set(
    damaged.filter((d) => isDamagedToday(d, now)).map((d) => d.asset_id),
  );
  return candidates
    .filter((c) => !blocked.has(c.asset_id))
    .sort((a, b) => {
      // null = nowy ticker = absolutny priorytet
      if (a.updated_at === null && b.updated_at === null) return 0;
      if (a.updated_at === null) return -1;
      if (b.updated_at === null) return 1;
      // ISO 8601 z tej samej kolumny sortuje się leksykograficznie = chronologicznie
      return a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0;
    })
    .slice(0, limit);
}

// Po pobraniu: co zrobić z damaged_assets i kogo zaalarmować.
//   sukces  → skasuj wpis (reset po sukcesie),
//   porażka → +1 (albo start od 1, jeśli ostatnia awaria była w innym dniu — reset dzienny).
// Alert leci dokładnie w chwili dobicia do MAX_FAILS_PER_DAY → raz na dobę na asset
// (potem asset wypada z kursora, więc transcja 2→3 nie powtórzy się tego dnia).
export function applyOutcomes(
  outcomes: FetchOutcome[],
  damaged: DamagedRecord[],
  now: Date,
): { updates: DamagedUpdate[]; alerts: Alert[] } {
  const byId = new Map(damaged.map((d) => [d.asset_id, d]));
  const updates: DamagedUpdate[] = [];
  const alerts: Alert[] = [];

  for (const o of outcomes) {
    if (o.ok) {
      if (byId.has(o.asset_id)) updates.push({ op: "clear", asset_id: o.asset_id });
      continue;
    }
    const prev = byId.get(o.asset_id);
    const continuesToday = prev !== undefined && sameUtcDay(prev.last_failed_at, now);
    const fail_count = continuesToday ? prev!.fail_count + 1 : 1;
    updates.push({ op: "set", asset_id: o.asset_id, fail_count, last_failed_at: now.toISOString() });
    if (fail_count === MAX_FAILS_PER_DAY) alerts.push({ asset_id: o.asset_id, fail_count });
  }

  return { updates, alerts };
}
