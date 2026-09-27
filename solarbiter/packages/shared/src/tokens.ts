import { SOL_MINT, USDC_MINT, USDT_MINT } from "./money.js";

export interface TokenListEntry {
  mint: string;
  symbol: string;
  name: string;
  /**
   * Issuer-controlled tokens whose freeze authority is expected (regulated stablecoins). They pass the
   * freeze-authority check without being on the user's allowlist.
   */
  trusted?: boolean;
}

/**
 * Default token universe. Mints were checked against the Jupiter token API and on-chain mint
 * accounts (all classic SPL Token mints). Decimals, authorities and program are always read from
 * the chain at startup — this list only names the tokens.
 */
export const DEFAULT_TOKENS: TokenListEntry[] = [
  { mint: SOL_MINT, symbol: "SOL", name: "Wrapped SOL", trusted: true },
  { mint: USDC_MINT, symbol: "USDC", name: "USD Coin", trusted: true },
  { mint: USDT_MINT, symbol: "USDT", name: "Tether USD", trusted: true },
  { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", symbol: "JUP", name: "Jupiter" },
  { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "BONK", name: "Bonk" },
  { mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", symbol: "WIF", name: "dogwifhat" },
  { mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", symbol: "JTO", name: "Jito" },
  { mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", symbol: "PYTH", name: "Pyth Network" },
  { mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", symbol: "RAY", name: "Raydium" },
  { mint: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE", symbol: "ORCA", name: "Orca" },
  { mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", symbol: "mSOL", name: "Marinade staked SOL" },
  { mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", symbol: "JitoSOL", name: "Jito Staked SOL" },
];
