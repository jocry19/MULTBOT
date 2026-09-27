import { DEFAULT_SETTINGS, mergeSettings, settingsSchema, type DeepPartial, type Settings } from "@multbot/shared";
import type { Database } from "../../db/database.js";

/**
 * Persistent settings (validated, audited) and small system state values (live trading lock,
 * reconciliation status, bot running flags). Reads are served from memory.
 */
export class StateStore {
  private settings: Settings = DEFAULT_SETTINGS;
  private readonly state = new Map<string, unknown>();
  private readonly listeners = new Set<(s: Settings) => void>();

  constructor(private readonly db: Database) {}

  async load(): Promise<void> {
    const row = await this.db.one<{ value: unknown }>("SELECT value FROM settings WHERE key = 'settings'");
    if (row) {
      // merge onto defaults so newly added settings get their default values
      const parsed = settingsSchema.safeParse(mergeLoose(DEFAULT_SETTINGS, row.value));
      this.settings = parsed.success ? parsed.data : DEFAULT_SETTINGS;
    } else {
      await this.db.query("INSERT INTO settings (key, value) VALUES ('settings', $1) ON CONFLICT (key) DO NOTHING", [
        JSON.stringify(DEFAULT_SETTINGS),
      ]);
    }
    const rows = await this.db.many<{ key: string; value: unknown }>("SELECT key, value FROM system_state");
    for (const r of rows) this.state.set(r.key, r.value);
  }

  get(): Settings {
    return this.settings;
  }

  onChange(fn: (s: Settings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Validate, persist and audit a settings change. Throws on invalid values. */
  async update(patch: DeepPartial<Settings>, actor: string): Promise<Settings> {
    const next = mergeSettings(this.settings, patch);
    await this.db.tx(async (c) => {
      await c.query("UPDATE settings SET value = $1, updated_at = now() WHERE key = 'settings'", [JSON.stringify(next)]);
      await c.query("INSERT INTO settings_audit (key, old_value, new_value, actor) VALUES ('settings', $1, $2, $3)", [
        JSON.stringify(this.settings),
        JSON.stringify(next),
        actor,
      ]);
    });
    this.settings = next;
    for (const l of this.listeners) l(next);
    return next;
  }

  getState<T>(key: string, fallback: T): T {
    return (this.state.has(key) ? this.state.get(key) : fallback) as T;
  }

  async setState(key: string, value: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
    this.state.set(key, value);
  }
}

function mergeLoose(base: unknown, patch: unknown): unknown {
  if (typeof base !== "object" || base === null || Array.isArray(base)) return patch ?? base;
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = k in out ? mergeLoose(out[k], v) : v;
  }
  return out;
}

