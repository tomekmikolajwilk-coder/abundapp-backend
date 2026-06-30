// Mapa asset_id → { price_usd, category, display_name } z połączenia price_cache i asset_definitions.
// asset_definitions jest źródłem prawdy dla category i display_name; price_cache trzyma sam kurs.
// Wspólne dla /portfolio (live) i snapshot-portfolio.
export type PriceInfo = { price_usd: number; category: string; display_name: string | null };

export function buildPriceMap(
  prices: { asset_id: string; price_usd: number }[],
  defs: { asset_id: string; category: string; display_name?: string | null }[],
): Record<string, PriceInfo> {
  const categoryMap: Record<string, string> = {};
  const nameMap: Record<string, string | null> = {};
  for (const d of defs) {
    categoryMap[d.asset_id] = d.category;
    nameMap[d.asset_id] = d.display_name ?? null;
  }

  const priceMap: Record<string, PriceInfo> = {};
  for (const p of prices) {
    priceMap[p.asset_id] = {
      price_usd: p.price_usd,
      category: categoryMap[p.asset_id] ?? "unknown",
      display_name: nameMap[p.asset_id] ?? null,
    };
  }
  return priceMap;
}
