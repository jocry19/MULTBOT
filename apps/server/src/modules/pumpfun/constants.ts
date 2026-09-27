export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const PUMP_FEES_PROGRAM_ID = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
/** Pubkey::default() — used by pump for "SOL-paired" quote mints. */
export const DEFAULT_PUBKEY = "11111111111111111111111111111111";

/** Pump tokens have 6 decimals; SOL has 9. */
export const PUMP_TOKEN_DECIMALS = 6;
export const SOL_DECIMALS = 9;

/** Initial bonding-curve parameters (from the Global account; used as fallback only). */
export const INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000_000_000n;
export const INITIAL_VIRTUAL_SOL_RESERVES = 30_000_000_000n;
export const INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;
export const PUMP_TOKEN_TOTAL_SUPPLY = 1_000_000_000_000_000n;

/** Anchor emit_cpi! instruction tag (sha256("anchor:event")[..8], little-endian u64 0x1d9acb512ea545e4). */
export const ANCHOR_EVENT_IX_TAG = Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

/** Rent-exempt minimum for an SPL token account (165 bytes). Token-2022 accounts with extensions cost slightly more. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280;
export const TOKEN_2022_ACCOUNT_RENT_LAMPORTS = 2_074_080;
/** Base fee per signature. */
export const LAMPORTS_PER_SIGNATURE = 5_000;
