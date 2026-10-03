/**
 * Seed reference data: settings (defaults + environment overrides), the default token list,
 * strategy_v1 and the initial control state (PAPER, live locked). Idempotent; never touches trades.
 */
import { Database, STATE_KEYS, StateStore, migrate } from "@solarbiter/database";
import { DEFAULT_BOT_CONTROL, DEFAULT_EMERGENCY, DEFAULT_LIVE_GATE, DEFAULT_TOKENS } from "@solarbiter/shared";
import { createLogger, loadConfig } from "@solarbiter/shared/node";
import { Repo } from "../repo.js";

const config = loadConfig();
const log = createLogger({ level: config.logLevel });
const db = new Database(config.database.url, log);
try {
  await migrate(db, log);
  const store = new StateStore(db);
  const settings = await store.load(config.initialSettings);
  const repo = new Repo(db);
  for (const t of DEFAULT_TOKENS) {
    await db.query("INSERT INTO watchlist (mint, note) VALUES ($1, $2) ON CONFLICT (mint) DO NOTHING", [t.mint, t.symbol]);
  }
  const version = await repo.ensureInitialVersion(settings.strategy);
  const defaults: [string, unknown][] = [
    [STATE_KEYS.bot, { ...DEFAULT_BOT_CONTROL, at: Date.now(), by: "seed" }],
    [STATE_KEYS.emergency, DEFAULT_EMERGENCY],
    [STATE_KEYS.liveGate, DEFAULT_LIVE_GATE],
    [STATE_KEYS.shadow, false],
    [STATE_KEYS.activeStrategy, version],
  ];
  for (const [k, v] of defaults) {
    await db.query("INSERT INTO system_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [k, JSON.stringify(v)]);
  }
  console.log(`seeded: settings, ${DEFAULT_TOKENS.length} watchlist tokens, ${version}, control state (PAPER, live locked)`);
} catch (err) {
  console.error(`seed failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
