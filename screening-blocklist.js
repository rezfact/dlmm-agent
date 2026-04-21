import { config } from "./config.js";

function norm(s) {
  return String(s ?? "").trim().toLowerCase();
}

/**
 * True if pool matches `config.screening.blockedSymbols` (case-insensitive).
 * Accepts condensed pools from discoverPools, raw Meteora discovery rows from getPoolDetail,
 * or a minimal stub `{ name, pool_name, base: { symbol } }`.
 */
export function poolMatchesBlockedSymbols(poolLike) {
  const blocked = config.screening.blockedSymbols;
  if (!blocked?.length || !poolLike) return false;

  const sym = norm(
    poolLike.base?.symbol ??
      poolLike.base_symbol ??
      poolLike.token_x?.symbol
  );
  const name = norm(poolLike.name ?? poolLike.pool_name ?? "");
  const stem = name.includes("-") ? name.slice(0, name.indexOf("-")) : name;

  for (const entry of blocked) {
    const b = norm(entry);
    if (!b) continue;
    if (sym && sym === b) return true;
    if (stem && stem === b) return true;
  }
  return false;
}
