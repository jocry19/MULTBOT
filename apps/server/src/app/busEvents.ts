import type { ActivityDto } from "@multbot/shared";
import type { MarketEvent } from "../domain/market.js";
import type { DetectedEvent } from "../modules/events/eventEngine.js";
import type { FeatureVector } from "../modules/features/types.js";
import type { RegimeState } from "../modules/regime/regimeEngine.js";

/** A decision point: features of one token at one moment, evaluated by strategies. */
export interface DecisionPoint {
  mint: string;
  ts: number;
  trigger: string;
  eventId: number | null;
  eventUid: string | null;
  features: FeatureVector;
  regime: RegimeState | null;
  /** Research sample id (if persisted) — links signals to the research dataset. */
  sampleId: number | null;
}

/** Price/liquidity update for a token (used by position monitors). */
export interface PriceUpdate {
  mint: string;
  ts: number;
  priceSol: number;
  liquiditySol: number;
}

export interface BusEvents {
  /** Normalised on-chain events of one transaction (ingest → collector/indexer). */
  "market.events": MarketEvent[];
  "market.price": PriceUpdate;
  "market.detected": DetectedEvent & { id: number | null };
  "market.decision": DecisionPoint;
  "market.regime": RegimeState;
  activity: ActivityDto;
  /** Something changed that dashboard queries should refetch. */
  invalidate: string[];
}
