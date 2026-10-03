import pg from "pg";
import type { Logger } from "pino";
import { metrics } from "../core/metrics.js";

// int8 (bigint) → JS number. Lamport amounts and counts stay far below 2^53.
// NUMERIC (raw token amounts, u64) stays a string and is converted explicitly where needed.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 value ${v} exceeds JS safe integer range`);
  return n;
});
// float8 / float4
pg.types.setTypeParser(701, (v) => Number(v));
pg.types.setTypeParser(700, (v) => Number(v));

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
}

/**
 * Thin wrapper around a pg Pool: typed queries, transactions, batched inserts, health.
 * No ORM on purpose — the SQL is explicit and reviewed in migrations.
 */
export class Database implements Queryable {
  readonly pool: pg.Pool;
  private healthy = false;
  private lastError: string | null = null;

  constructor(
    url: string,
    private readonly log: Logger,
    poolMax = 10,
  ) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: "multbot",
    });
    this.pool.on("error", (err) => {
      this.healthy = false;
      this.lastError = err.message;
      this.log.error({ err }, "postgres pool error");
    });
  }

  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<pg.QueryResult<T>> {
    try {
      const res = await this.pool.query<T>(sql, params);
      this.healthy = true;
      return res;
    } catch (err) {
      if (isConnectionError(err)) {
        this.healthy = false;
        this.lastError = (err as Error).message;
      }
      throw err;
    }
  }

  async one<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    const res = await this.query<T>(sql, params);
    return res.rows[0] ?? null;
  }

  async many<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.query<T>(sql, params);
    return res.rows;
  }

  /** Run `fn` inside a transaction. Rolls back on error. */
  async tx<T>(fn: (client: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client as unknown as Queryable);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Multi-row INSERT in chunks. `columns` must be trusted identifiers (never user input).
   * `onConflict` is appended verbatim, e.g. "ON CONFLICT DO NOTHING".
   */
  async insertMany(
    table: string,
    columns: string[],
    rows: unknown[][],
    onConflict = "",
    client: Queryable = this,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const started = performance.now();
    const maxParams = 60_000;
    const chunkSize = Math.max(1, Math.floor(maxParams / columns.length));
    let inserted = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const params: unknown[] = [];
      const values = chunk.map((row) => {
        const ph = row.map((v) => {
          params.push(v);
          return `$${params.length}`;
        });
        return `(${ph.join(",")})`;
      });
      const res = await client.query(
        `INSERT INTO ${table} (${columns.join(",")}) VALUES ${values.join(",")} ${onConflict}`,
        params,
      );
      inserted += res.rowCount ?? 0;
    }
    metrics.dbWriteLatency.observe({ table }, (performance.now() - started) / 1000);
    return inserted;
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      this.healthy = true;
      return true;
    } catch (err) {
      this.healthy = false;
      this.lastError = (err as Error).message;
      return false;
    }
  }

  get isHealthy(): boolean {
    return this.healthy;
  }

  get error(): string | null {
    return this.lastError;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function isConnectionError(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  if (!code) return true;
  // 08xxx connection exceptions, 57P0x admin shutdown / cannot connect now
  return code.startsWith("08") || code.startsWith("57P") || code === "ECONNREFUSED" || code === "ETIMEDOUT";
}
