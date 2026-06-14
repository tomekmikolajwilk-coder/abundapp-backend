// Mapa asset_id → { price_usd, category } z połączenia price_cache i asset_definitions.
// asset_definitions jest źródłem prawdy dla category; price_cache trzyma sam kurs.
// Wspólne dla /portfolio (live) i snapshot-portfolio.
export type PriceInfo = { price_usd: number; category: string };

export function buildPriceMap(
  prices: { asset_id: string; price_usd: number }[],
  defs: { asset_id: string; category: string }[],
): Record<string, PriceInfo> {
  const categoryMap: Record<string, string> = {};
  for (const d of defs) categoryMap[d.asset_id] = d.category;

  const priceMap: Record<string, PriceInfo> = {};
  for (const p of prices) {
    priceMap[p.asset_id] = { price_usd: p.price_usd, category: categoryMap[p.asset_id] ?? "unknown" };
  }
  return priceMap;
}
