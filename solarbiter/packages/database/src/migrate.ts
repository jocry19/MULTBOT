import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import { sha256Hex } from "@solarbiter/shared/node";
import type { Database } from "./database.js";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const LOCK_ID = 7_310_455_777; // arbitrary constant for pg_advisory_lock

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      return {
        version: Number(file.split("_")[0]),
        name: file,
        sql,
        checksum: sha256Hex(sql),
      };
    });
}

/**
 * Applies pending migrations in order, each in its own transaction, under an advisory lock so
 * concurrent processes cannot race. Refuses to run if an applied migration was modified.
 */
export async function migrate(db: Database, log: Logger, dir = MIGRATIONS_DIR): Promise<number> {
  const client = await db.pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const applied = new Map<number, { checksum: string; name: string }>();
    const res = await client.query<{ version: number; checksum: string; name: string }>(
      "SELECT version, checksum, name FROM schema_migrations",
    );
    for (const r of res.rows) applied.set(Number(r.version), { checksum: r.checksum, name: r.name });

    let count = 0;
    for (const m of loadMigrations(dir)) {
      const prev = applied.get(m.version);
      if (prev) {
        if (prev.checksum !== m.checksum) {
          throw new Error(`migration ${m.name} was modified after being applied (checksum mismatch)`);
        }
        continue;
      }
      log.info({ migration: m.name }, "applying migration");
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
          m.version,
          m.name,
          m.checksum,
        ]);
        await client.query("COMMIT");
        count++;
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${m.name} failed: ${(err as Error).message}`);
      }
    }
    return count;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

/** Create day partitions for `parent` covering [from, to] (inclusive, UTC days). */
export async function ensurePartitions(db: Database, parent: string, from: Date, to: Date): Promise<void> {
  const day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  while (day.getTime() <= end) {
    await db.query("SELECT ensure_daily_partition($1, $2::date)", [parent, day.toISOString().slice(0, 10)]);
    day.setUTCDate(day.getUTCDate() + 1);
  }
}

export const PARTITIONED_TABLES = ["quotes", "opportunities"] as const;
