// Wspólne dla EODHD: mapa giełd + helper /search. Używają tego fetch-eod (pobieranie cen)
// oraz assets (/discover, /request — samorozszerzanie katalogu na żądanie usera).

export const EODHD_BASE = "https://eodhd.com/api";

// Giełda (asset_definitions.exchange LUB kod EODHD) → kod bulk EODHD + waluta notowania.
// pence=true: LSE kwotuje w pensach (GBX) → cena ÷100 przed przeliczeniem przez kurs GBP.
// Klucze obejmują i format katalogu US (NASDAQ/NYSE), i kody EODHD (US/WAR/XETRA…), bo asset
// dodany przez /request trzyma kod EODHD, a stary seed US trzyma NASDAQ/NYSE.
export const EXCHANGE_MAP: Record<string, { eodhd: string; ccy: string; pence?: boolean }> = {
  NASDAQ: { eodhd: "US", ccy: "USD" },
  NYSE: { eodhd: "US", ccy: "USD" },
  US: { eodhd: "US", ccy: "USD" },
  WAR: { eodhd: "WAR", ccy: "PLN" },
  XETRA: { eodhd: "XETRA", ccy: "EUR" },
  PA: { eodhd: "PA", ccy: "EUR" },
  AS: { eodhd: "AS", ccy: "EUR" },
  LSE: { eodhd: "LSE", ccy: "GBP", pence: true },
  SW: { eodhd: "SW", ccy: "CHF" },
  // Azja — waluty FX dodane w migracji asia_fx (HKD/KRW/TWD/CNY).
  HK: { eodhd: "HK", ccy: "HKD" },
  KO: { eodhd: "KO", ccy: "KRW" },
  KQ: { eodhd: "KQ", ccy: "KRW" },
  TW: { eodhd: "TW", ccy: "TWD" },
  TWO: { eodhd: "TWO", ccy: "TWD" },
  SHG: { eodhd: "SHG", ccy: "CNY" },
  SHE: { eodhd: "SHE", ccy: "CNY" },
};

// Giełdy, które realnie umiemy wycenić (mamy dla nich kurs FX). Tylko z tych dopuszczamy
// /discover i /request. (JP/IN poza — EODHD nie ma ich giełd na tym planie.)
export const SUPPORTED_EODHD_EXCHANGES = new Set([
  "US", "WAR", "XETRA", "PA", "AS", "LSE", "SW", // US + Europa
  "HK", "KO", "KQ", "TW", "TWO", "SHG", "SHE", // Azja (Chiny/HK, Korea, Tajwan)
]);

// EODHD Type → nasza kategoria. Tylko realnie trzymane klasy; resztę (FUND, Warrant, Preferred…)
// odrzucamy — to szum dla apki do majątku.
export function eodhdTypeToCategory(type: string): "stock" | "etf" | null {
  if (type === "Common Stock") return "stock";
  if (type === "ETF") return "etf";
  return null;
}

// asset_id z (Code, giełda EODHD). US zostaje „bare" (AAPL) — spójnie z legacy-katalogiem US
// i bez kolizji (kody US unikalne w US). Nie-US dostaje sufiks giełdy (LWB.WAR), bo ten sam
// Code bywa różną spółką na różnych giełdach (LWB.WAR=Bogdanka, LWB.F=Mesoblast).
export function eodhdAssetId(code: string, eodhdExchange: string): string {
  return eodhdExchange === "US" ? code : `${code}.${eodhdExchange}`;
}

// Odwrotność: z asset_id wyciągamy „bare code", po którym matchujemy dump bulk EODHD
// (bulk zwraca code bez sufiksu giełdy). LWB.WAR → LWB; AAPL → AAPL.
export function eodhdBulkCode(assetId: string): string {
  const dot = assetId.indexOf(".");
  return dot === -1 ? assetId : assetId.slice(0, dot);
}

export type EodhdSearchHit = {
  Code: string;
  Exchange: string;
  Name: string;
  Type: string;
  Currency?: string;
  Country?: string;
};

// EODHD /search — zwraca dopasowania po nazwie/tickerze ze WSZYSTKICH giełd (cross-listingi,
// ten sam ticker różne spółki, lewarowane/tokenizowane). Filtrowanie zostawiamy wołającemu.
export async function eodhdSearch(apiKey: string, query: string, limit = 30): Promise<EodhdSearchHit[]> {
  const url = new URL(`${EODHD_BASE}/search/${encodeURIComponent(query)}`);
  url.searchParams.set("api_token", apiKey);
  url.searchParams.set("fmt", "json");
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`EODHD search HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data as EodhdSearchHit[] : [];
}
