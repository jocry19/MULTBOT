import type { LiveGateState } from "./enums.js";

/**
 * Control state persisted in system_state (the database is the source of truth; the API writes it,
 * the worker reads it). Shared shapes so both sides agree.
 */
export interface BotControlState {
  /** RUNNING = trade in the mode allowed by gate/shadow; PAUSED = no new trades. */
  desired: "RUNNING" | "PAUSED";
  reason: string | null;
  at: number;
  by: string;
}

export interface EmergencyState {
  active: boolean;
  reason: string | null;
  at: number | null;
  by: string | null;
}

export interface LiveGateRecord {
  state: LiveGateState;
  /** When the learning gate last recommended live trading. */
  readyAt: number | null;
  enabledAt: number | null;
  enabledBy: string | null;
  /** Why live was stopped automatically (degradation) — cleared on manual enable. */
  stoppedReason: string | null;
}

export const DEFAULT_BOT_CONTROL: BotControlState = { desired: "RUNNING", reason: null, at: 0, by: "default" };
export const DEFAULT_EMERGENCY: EmergencyState = { active: false, reason: null, at: null, by: null };
export const DEFAULT_LIVE_GATE: LiveGateRecord = { state: "LIVE_LOCKED", readyAt: null, enabledAt: null, enabledBy: null, stoppedReason: null };

/** The exact phrase the user must type to enable real-money trading. */
export const LIVE_CONFIRMATION_PHRASE = "ENABLE LIVE TRADING";
