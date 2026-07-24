// CRS/WKT helpers with no Cesium dependency, so they run in Node (smoke test)
// and the browser alike.

export const FT_INTL = 0.3048; // international foot -> metre
export const FT_US = 0.3048006096; // US survey foot -> metre

/**
 * Extract the horizontal CRS from a WKT string. proj4 cannot parse a compound
 * CRS (`COMPD_CS[...]`, e.g. "NAD83 / Oregon Lambert (ft) + NAVD88 height"),
 * so we pull out the inner PROJCS/GEOGCS block with bracket matching.
 */
export function extractHorizontalWkt(wkt: string): string {
  if (!wkt.startsWith('COMPD_CS')) return wkt;
  const start = wkt.indexOf('PROJCS') >= 0 ? wkt.indexOf('PROJCS') : wkt.indexOf('GEOGCS');
  if (start < 0) return wkt;
  const open = wkt.indexOf('[', start);
  let depth = 0;
  for (let i = open; i < wkt.length; i++) {
    if (wkt[i] === '[') depth++;
    else if (wkt[i] === ']' && --depth === 0) return wkt.slice(start, i + 1);
  }
  return wkt.slice(start);
}

/** Guess the vertical (height) unit -> metre factor from the WKT. */
export function verticalMetreFactor(wkt: string): number {
  if (/ftus|us survey foot|foot_us/i.test(wkt)) return FT_US;
  if (/\bfoot\b|\bfeet\b|\bft\b/i.test(wkt)) return FT_INTL;
  return 1;
}
