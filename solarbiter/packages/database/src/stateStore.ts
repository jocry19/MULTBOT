import { DEFAULT_SETTINGS, mergeSettings, settingsFromStored, type Settings } from "@solarbiter/shared";
import type { Database } from "./database.js";

/**
 * Settings (validated, audited) and small system state values (bot state, live gate, breakers …).
 * The database is the source of truth; values are cached in memory and refreshed on demand.
 */
export class StateStore {
  private settings: Settings = DEFAULT_SETTINGS;
  private readonly state = new Map<string, unknown>();
  private readonly listeners = new Set<(s: Settings) => void>();

  constructor(private readonly db: Database) {}

  /** Load settings; on first start they are created from defaults + environment overrides. */
  async load(initial: Record<string, unknown> = {}): Promise<Settings> {
    const row = await this.db.one<{ value: unknown }>("SELECT value FROM settings WHERE id = 1");
    if (row) {
      this.settings = settingsFromStored(row.value);
    } else {
      this.settings = mergeSettings(DEFAULT_SETTINGS, initial);
      await this.db.query("INSERT INTO settings (id, value, updated_by) VALUES (1, $1, 'initial') ON CONFLICT (id) DO NOTHING", [JSON.stringify(this.settings)]);
      await this.db.query("INSERT INTO settings_audit (actor, old_value, new_value) VALUES ('initial', NULL, $1)", [JSON.stringify(this.settings)]);
    }
    await this.reloadState();
    return this.settings;
  }

  get(): Settings {
    return this.settings;
  }

  onChange(fn: (s: Settings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Re-read settings from the database (another process changed them). */
  async refresh(): Promise<Settings> {
    const row = await this.db.one<{ value: unknown }>("SELECT value FROM settings WHERE id = 1");
    if (row) {
      this.settings = settingsFromStored(row.value);
      for (const l of this.listeners) l(this.settings);
    }
    return this.settings;
  }

  /** Validated partial update with audit record. */
  async update(patch: unknown, actor: string): Promise<Settings> {
    const next = mergeSettings(this.settings, patch);
    const prev = this.settings;
    await this.db.tx(async (c) => {
      await c.query("UPDATE settings SET value = $1, updated_at = now(), updated_by = $2 WHERE id = 1", [JSON.stringify(next), actor]);
      await c.query("INSERT INTO settings_audit (actor, old_value, new_value) VALUES ($1, $2, $3)", [actor, JSON.stringify(prev), JSON.stringify(next)]);
    });
    this.settings = next;
    for (const l of this.listeners) l(next);
    return next;
  }

  async reloadState(): Promise<void> {
    const rows = await this.db.many<{ key: string; value: unknown }>("SELECT key, value FROM system_state");
    this.state.clear();
    for (const r of rows) this.state.set(r.key, r.value);
  }

  getState<T>(key: string, fallback: T): T {
    return (this.state.has(key) ? (this.state.get(key) as T) : fallback) ?? fallback;
  }

  async setState(key: string, value: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
    this.state.set(key, value);
  }

  /** Read one key straight from the database (cross-process consistency for critical flags). */
  async readState<T>(key: string, fallback: T): Promise<T> {
    const r = await this.db.one<{ value: T }>("SELECT value FROM system_state WHERE key = $1", [key]);
    const v = r ? r.value : fallback;
    this.state.set(key, v);
    return v;
  }
}

/** Well-known system_state keys. */
export const STATE_KEYS = {
  bot: "bot",
  liveGate: "live_gate",
  emergency: "emergency",
  breakers: "breakers",
  shadow: "shadow",
  activeStrategy: "active_strategy",
  levelEligibility: "level_eligibility",
  paperStart: "paper_start",
  walletAddress: "wallet_address",
} as const;
