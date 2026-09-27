/** A feature vector: stable feature name → finite number. Missing features are absent (never NaN). */
export type FeatureVector = Record<string, number>;

/** Wallet evidence used by features. Built only from data available at evaluation time. */
export interface WalletProfile {
  firstSeenAt: number;
  trades: number;
  closedPositions: number;
  winRate: number;
  /** Mean realised return per closed position. */
  meanReturn: number;
  realizedPnlSol: number;
  /**
   * Evidence-weighted skill: lower confidence bound of the mean position return,
   * 0 when there is not enough history. Only positive values count as "smart money".
   */
  skill: number;
  earlyEntryRate: number;
  clusterId: number | null;
  tokensCreated: number;
}

export interface WalletIntel {
  profile(address: string): WalletProfile | undefined;
}

export interface CreatorProfile {
  tokensCreated: number;
  tokensCompleted: number;
  /** Tokens whose creator sold most of their holdings within 10 minutes. */
  quickDumps: number;
}

export interface CreatorIntel {
  creator(address: string): CreatorProfile | undefined;
}

export const noWalletIntel: WalletIntel = { profile: () => undefined };
export const noCreatorIntel: CreatorIntel = { creator: () => undefined };
