import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { secrets } from "./secrets.js";

/**
 * Process configuration from environment variables. Secrets (API keys, auth tokens, passphrases)
 * come ONLY from the environment or files referenced by it — never from code, the database or the UI.
 * Every secret is registered with the log scrubber.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const optNum = z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.coerce.number().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  LOG_DIR: z.string().optional(),

  HTTP_HOST: z.string().default("127.0.0.1"),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  WEB_DIST_DIR: z.string().optional(),
  CORS_ORIGINS: list,
  WORKER_METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),

  DATABASE_URL: z.string().min(1).default("postgres://solarbiter:solarbiter@localhost:5432/solarbiter"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: z.string().min(1).default("redis://127.0.0.1:6379"),

  SOLANA_RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  SOLANA_WS_URL: z.string().optional(),
  /** Additional fallback RPC endpoints (comma-separated). */
  SOLANA_RPC_FALLBACK_URLS: list,
  RPC_REQUESTS_PER_SECOND: z.coerce.number().positive().default(8),

  JUPITER_API_URL: z.string().url().default("https://lite-api.jup.ag/swap/v1"),
  JUPITER_API_KEY: z.string().optional(),
  /** Jupiter plan budget (requests/second). Keyless 0.5, free key 1, developer 10 … */
  JUPITER_RPS: z.coerce.number().positive().default(0.5),

  JITO_BLOCK_ENGINE_URL: z.string().url().default("https://mainnet.block-engine.jito.wtf"),
  JITO_TIP_FLOOR_URL: z.string().url().default("https://bundles.jito.wtf/api/v1/bundles/tip_floor"),
  JITO_AUTH: z.string().optional(),

  FX_URL: z.string().url().default("https://api.kraken.com/0/public/Ticker?pair=SOLEUR"),

  WALLET_KEYSTORE_PATH: z.string().default("./secrets/bot-wallet.keystore.json"),
  WALLET_KEYSTORE_PASSPHRASE: z.string().optional(),
  WALLET_KEYSTORE_PASSPHRASE_FILE: z.string().optional(),

  SESSION_TTL_HOURS: z.coerce.number().positive().max(24 * 30).default(12),
  NOTIFY_WEBHOOK_URL: z.string().url().optional(),

  /** Hard switches. LIVE_MODE=false makes real-money trading impossible regardless of the UI. */
  PAPER_MODE: bool(true),
  LIVE_MODE: bool(false),

  /** Initial values for the settings (used when the database has no settings yet). */
  STARTING_CAPITAL_EUR: optNum,
  MAX_TRADE_EUR: optNum,
  MAX_CONCURRENT_TRADES: optNum,
  MAX_LOSS_PER_TRADE_EUR: optNum,
  DAILY_LOSS_LIMIT_EUR: optNum,
  MAX_QUOTE_AGE_MS: optNum,
  MIN_NET_PROFIT_EUR: optNum,
  MIN_NET_PROFIT_PERCENT: optNum,
  MAX_SLIPPAGE_BPS: optNum,
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  env: Env["NODE_ENV"];
  logLevel: Env["LOG_LEVEL"];
  logDir: string | undefined;
  http: { host: string; port: number; webDistDir: string | undefined; corsOrigins: string[] };
  workerMetricsPort: number;
  database: { url: string; poolMax: number };
  redisUrl: string;
  rpc: { urls: string[]; wsUrl: string | null; rps: number };
  jupiter: { apiUrl: string; apiKey: string | undefined; rps: number };
  jito: { blockEngineUrl: string; tipFloorUrl: string; auth: string | undefined };
  fxUrl: string;
  wallet: { keystorePath: string; passphrase: string | undefined };
  sessionTtlHours: number;
  notifyWebhookUrl: string | undefined;
  paperMode: boolean;
  liveMode: boolean;
  initialSettings: Record<string, unknown>;
}

/**
 * Local runs: read KEY=VALUE pairs from a .env file ($SOLARBITER_ENV_FILE, ./.env or the project
 * root two levels up) without overriding variables that are already set. Returns the file's directory.
 */
export function loadEnvFile(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | null {
  if (env.NODE_ENV === "test") return null;
  const candidates = [env.SOLARBITER_ENV_FILE, path.join(cwd, ".env"), path.join(cwd, "..", "..", ".env")].filter((f): f is string => Boolean(f));
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    for (const [k, v] of Object.entries(parseEnv(fs.readFileSync(f, "utf8")))) {
      if (env[k] === undefined) env[k] = v;
    }
    return path.dirname(path.resolve(f));
  }
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const baseDir = (env === process.env ? loadEnvFile(env) : null) ?? process.cwd();
  const e = envSchema.parse(env);
  let passphrase = e.WALLET_KEYSTORE_PASSPHRASE;
  if (!passphrase && e.WALLET_KEYSTORE_PASSPHRASE_FILE) {
    passphrase = fs.readFileSync(path.resolve(baseDir, e.WALLET_KEYSTORE_PASSPHRASE_FILE), "utf8").trim();
  }
  const rpcUrls = [e.SOLANA_RPC_URL, ...e.SOLANA_RPC_FALLBACK_URLS];
  for (const s of [e.JUPITER_API_KEY, e.JITO_AUTH, passphrase, e.NOTIFY_WEBHOOK_URL, ...rpcUrls, e.SOLANA_WS_URL, e.DATABASE_URL, e.REDIS_URL]) {
    // URLs may embed api keys / credentials
    if (s && /@|api[-_]?key|token|auth|\?/i.test(s)) secrets.register(s);
  }
  secrets.register(e.JUPITER_API_KEY);
  secrets.register(e.JITO_AUTH);
  secrets.register(passphrase);

  const initialSettings: Record<string, unknown> = {};
  const capital: Record<string, unknown> = {};
  const risk: Record<string, unknown> = {};
  const strategy: Record<string, unknown> = {};
  if (e.STARTING_CAPITAL_EUR !== undefined) capital.startingCapitalEur = e.STARTING_CAPITAL_EUR;
  if (e.MAX_TRADE_EUR !== undefined) capital.maxTradeEur = e.MAX_TRADE_EUR;
  if (e.MAX_CONCURRENT_TRADES !== undefined) capital.maxConcurrentTrades = e.MAX_CONCURRENT_TRADES;
  if (e.MAX_LOSS_PER_TRADE_EUR !== undefined) risk.maxLossPerTradeEur = e.MAX_LOSS_PER_TRADE_EUR;
  if (e.DAILY_LOSS_LIMIT_EUR !== undefined) risk.dailyLossLimitEur = e.DAILY_LOSS_LIMIT_EUR;
  if (e.MAX_SLIPPAGE_BPS !== undefined) risk.maxSlippageBps = e.MAX_SLIPPAGE_BPS;
  if (e.MAX_QUOTE_AGE_MS !== undefined) strategy.maxQuoteAgeMs = e.MAX_QUOTE_AGE_MS;
  if (e.MIN_NET_PROFIT_EUR !== undefined) strategy.minNetProfitEur = e.MIN_NET_PROFIT_EUR;
  if (e.MIN_NET_PROFIT_PERCENT !== undefined) strategy.minNetProfitPercent = e.MIN_NET_PROFIT_PERCENT;
  if (Object.keys(capital).length) initialSettings.capital = capital;
  if (Object.keys(risk).length) initialSettings.risk = risk;
  if (Object.keys(strategy).length) initialSettings.strategy = strategy;

  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    logDir: e.LOG_DIR ? path.resolve(baseDir, e.LOG_DIR) : undefined,
    http: { host: e.HTTP_HOST, port: e.HTTP_PORT, webDistDir: e.WEB_DIST_DIR ? path.resolve(baseDir, e.WEB_DIST_DIR) : undefined, corsOrigins: e.CORS_ORIGINS },
    workerMetricsPort: e.WORKER_METRICS_PORT,
    database: { url: e.DATABASE_URL, poolMax: e.DATABASE_POOL_MAX },
    redisUrl: e.REDIS_URL,
    rpc: { urls: rpcUrls, wsUrl: e.SOLANA_WS_URL ?? null, rps: e.RPC_REQUESTS_PER_SECOND },
    jupiter: { apiUrl: e.JUPITER_API_URL.replace(/\/$/, ""), apiKey: e.JUPITER_API_KEY, rps: e.JUPITER_RPS },
    jito: { blockEngineUrl: e.JITO_BLOCK_ENGINE_URL.replace(/\/$/, ""), tipFloorUrl: e.JITO_TIP_FLOOR_URL, auth: e.JITO_AUTH },
    fxUrl: e.FX_URL,
    wallet: { keystorePath: path.resolve(baseDir, e.WALLET_KEYSTORE_PATH), passphrase },
    sessionTtlHours: e.SESSION_TTL_HOURS,
    notifyWebhookUrl: e.NOTIFY_WEBHOOK_URL,
    paperMode: e.PAPER_MODE,
    liveMode: e.LIVE_MODE,
    initialSettings,
  };
}
