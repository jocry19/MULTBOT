import bs58 from "bs58";
import { metrics } from "../../core/metrics.js";
import { ANCHOR_EVENT_IX_TAG, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from "./constants.js";
import { decodeEvent, EventDecodeError, type DecodedEvent } from "./events.js";
import type { RpcTransaction } from "../solana/rpcManager.js";

export interface ParsedEvent {
  event: DecodedEvent;
  /** Order of the event within the transaction (stable → part of the unique key). */
  index: number;
}

export interface ParseResult {
  events: ParsedEvent[];
  truncated: boolean;
  errors: string[];
}

const PROGRAMS: Record<string, "pump" | "pump_amm"> = {
  [PUMP_PROGRAM_ID]: "pump",
  [PUMP_AMM_PROGRAM_ID]: "pump_amm",
};

const INVOKE_RE = /^Program (\w+) invoke \[\d+\]$/;
const EXIT_RE = /^Program (\w+) (success|failed.*)$/;

/**
 * Extract Pump/PumpSwap events from transaction log messages.
 * "Program data:" lines are attributed to the innermost executing program (invocation stack).
 */
export function parseLogs(logs: readonly string[]): ParseResult {
  const stack: string[] = [];
  const events: ParsedEvent[] = [];
  const errors: string[] = [];
  let truncated = false;
  let index = 0;

  for (const line of logs) {
    if (line === "Log truncated") {
      truncated = true;
      break;
    }
    const inv = INVOKE_RE.exec(line);
    if (inv) {
      stack.push(inv[1] as string);
      continue;
    }
    const exit = EXIT_RE.exec(line);
    if (exit) {
      stack.pop();
      continue;
    }
    if (!line.startsWith("Program data: ")) continue;
    const current = stack[stack.length - 1];
    const program = current ? PROGRAMS[current] : undefined;
    if (!program) continue;
    for (const chunk of line.slice("Program data: ".length).split(" ")) {
      if (!chunk) continue;
      try {
        const decoded = decodeEvent(program, Buffer.from(chunk, "base64"));
        if (decoded) {
          events.push({ event: decoded, index: index++ });
          metrics.decodedEvents.inc({ event: decoded.name });
        }
      } catch (err) {
        metrics.decodeErrors.inc();
        errors.push(err instanceof EventDecodeError ? err.message : String(err));
      }
    }
  }
  return { events, truncated, errors };
}

/**
 * Extract events from a full transaction. Uses logs first; if the logs were truncated, falls back to
 * Anchor self-CPI event instructions (emit_cpi!) found in the inner instructions.
 */
export function parseTransaction(tx: RpcTransaction): ParseResult {
  if (!tx.meta || tx.meta.err) return { events: [], truncated: false, errors: [] };
  const fromLogs = parseLogs(tx.meta.logMessages ?? []);
  if (!fromLogs.truncated) return fromLogs;

  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  const events: ParsedEvent[] = [];
  const errors: string[] = [];
  let index = 0;
  for (const group of tx.meta.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      const programId = keys[ix.programIdIndex];
      const program = programId ? PROGRAMS[programId] : undefined;
      if (!program) continue;
      let data: Uint8Array;
      try {
        data = bs58.decode(ix.data);
      } catch {
        continue;
      }
      if (data.length < 16 || !ANCHOR_EVENT_IX_TAG.every((b, i) => data[i] === b)) continue;
      try {
        const decoded = decodeEvent(program, data.subarray(8));
        if (decoded) events.push({ event: decoded, index: index++ });
      } catch (err) {
        metrics.decodeErrors.inc();
        errors.push(String(err));
      }
    }
  }
  return { events, truncated: false, errors: [...fromLogs.errors, ...errors] };
}
