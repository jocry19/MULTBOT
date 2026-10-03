import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { secrets } from "./secrets.js";

/**
 * Process configuration from environment variables. Secrets (API keys, passphrases) come ONLY from
 * the environment or from files referenced by the environment — never from code or the database.
 * Every secret is registered with the log scrubber on load.
 */

const bool = z
  .string()
  .optional()
  .transform((v) => (v === undefined ? undefined : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  LOG_DIR: z.string().optional(),

  HTTP_HOST: z.string().default("127.0.0.1"),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  WEB_DIST_DIR: z.string().optional(),
  /** Origins allowed to call the API from a browser (in addition to same-origin). */
  CORS_ORIGINS: list,

  DATABASE_URL: z.string().min(1).default("postgres://multbot:multbot@localhost:5432/multbot"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  HELIUS_API_KEY: z.string().optional(),
  HELIUS_RPC_URL: z.string().url().optional(),
  HELIUS_WS_URL: z.string().optional(),
  /** Additional / fallback RPC endpoints (comma-separated HTTP URLs). */
  SOLANA_RPC_URLS: list,
  SOLANA_WS_URLS: list,
  RPC_REQUESTS_PER_SECOND: z.coerce.number().positive().default(10),

  JUPITER_API_URL: z.string().url().default("https://lite-api.jup.ag/swap/v1"),
  JUPITER_API_KEY: z.string().optional(),
  PUMPPORTAL_API_URL: z.string().url().default("https://pumpportal.fun/api"),
  /** Source for historical SOL/EUR prices used by the tax ledger. */
  FX_PROVIDER: z.enum(["coingecko", "kraken", "none"]).default("kraken"),
  COINGECKO_API_KEY: z.string().optional(),

  WALLET_KEYSTORE_PATH: z.string().default("./secrets/bot-wallet.keystore.json"),
  WALLET_KEYSTORE_PASSPHRASE: z.string().optional(),
  WALLET_KEYSTORE_PASSPHRASE_FILE: z.string().optional(),

  ADMIN_PASSWORD_HASH: z.string().optional(),
  SESSION_TTL_HOURS: z.coerce.number().positive().max(24 * 30).default(12),

  ENABLE_INGEST: bool,
  ENABLE_RESEARCH: bool,
  ENABLE_PAPER: bool,
  ENABLE_LIVE_ENGINE: bool,
});

export interface RpcEndpointConfig {
  name: string;
  kind: "helius" | "generic";
  httpUrl: string;
  wsUrl: string | null;
  /** Requests per second budget for this endpoint. */
  rps: number;
}

export interface AppConfig {
  env: "development" | "production" | "test";
  logLevel: string;
  logDir: string | undefined;
  http: { host: string; port: number; webDistDir: string | undefined; corsOrigins: string[] };
  database: { url: string; poolMax: number };
  rpc: { endpoints: RpcEndpointConfig[]; heliusApiKey: string | undefined };
  jupiter: { apiUrl: string; apiKey: string | undefined };
  pumpPortal: { apiUrl: string };
  fx: { provider: "coingecko" | "kraken" | "none"; coingeckoApiKey: string | undefined };
  wallet: { keystorePath: string; passphrase: string | undefined };
  auth: { adminPasswordHash: string | undefined; sessionTtlHours: number };
  features: { ingest: boolean; research: boolean; paper: boolean; liveEngine: boolean };
}

const PUBLIC_MAINNET_HTTP = "https://api.mainnet-beta.solana.com";
const PUBLIC_MAINNET_WS = "wss://api.mainnet-beta.solana.com";

/**
 * Local runs: read KEY=VALUE pairs from a .env file ($MULTBOT_ENV_FILE, ./.env or the repository
 * root) without overriding variables that are already set. Returns the directory of the file.
 * Containers get their environment from docker compose instead.
 */
export function loadEnvFile(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | null {
  if (env.NODE_ENV === "test") return null;
  const candidates = [env.MULTBOT_ENV_FILE, path.join(cwd, ".env"), path.join(cwd, "..", "..", ".env")].filter((f): f is string => Boolean(f));
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
  // relative paths in .env are relative to the .env file (so local and Docker use the same layout)
  const baseDir = (env === process.env ? loadEnvFile(env) : null) ?? process.cwd();
  const e = envSchema.parse(env);
  const keystorePath = path.resolve(baseDir, e.WALLET_KEYSTORE_PATH);

  let passphrase = e.WALLET_KEYSTORE_PASSPHRASE;
  if (!passphrase && e.WALLET_KEYSTORE_PASSPHRASE_FILE) {
    passphrase = fs.readFileSync(path.resolve(baseDir, e.WALLET_KEYSTORE_PASSPHRASE_FILE), "utf8").trim();
  }

  for (const s of [e.HELIUS_API_KEY, e.JUPITER_API_KEY, e.COINGECKO_API_KEY, passphrase, e.ADMIN_PASSWORD_HASH]) {
    secrets.register(s);
  }

  const endpoints: RpcEndpointConfig[] = [];
  if (e.HELIUS_API_KEY || e.HELIUS_RPC_URL) {
    const httpUrl = e.HELIUS_RPC_URL ?? `https://mainnet.helius-rpc.com/?api-key=${e.HELIUS_API_KEY}`;
    const wsUrl = e.HELIUS_WS_URL ?? (e.HELIUS_API_KEY ? `wss://mainnet.helius-rpc.com/?api-key=${e.HELIUS_API_KEY}` : null);
    secrets.register(httpUrl);
    secrets.register(wsUrl);
    endpoints.push({ name: "helius", kind: "helius", httpUrl, wsUrl, rps: e.RPC_REQUESTS_PER_SECOND });
  }
  e.SOLANA_RPC_URLS.forEach((httpUrl, i) => {
    secrets.register(httpUrl);
    const wsUrl = e.SOLANA_WS_URLS[i] ?? null;
    secrets.register(wsUrl);
    endpoints.push({ name: `rpc-${i + 1}`, kind: "generic", httpUrl, wsUrl, rps: e.RPC_REQUESTS_PER_SECOND });
  });
  if (endpoints.length === 0) {
    // Public endpoint as last resort: heavily rate limited, fine for development only.
    endpoints.push({ name: "solana-public", kind: "generic", httpUrl: PUBLIC_MAINNET_HTTP, wsUrl: PUBLIC_MAINNET_WS, rps: 4 });
  }

  const isTest = e.NODE_ENV === "test";
  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    logDir: e.LOG_DIR,
    http: { host: e.HTTP_HOST, port: e.HTTP_PORT, webDistDir: e.WEB_DIST_DIR, corsOrigins: e.CORS_ORIGINS },
    database: { url: e.DATABASE_URL, poolMax: e.DATABASE_POOL_MAX },
    rpc: { endpoints, heliusApiKey: e.HELIUS_API_KEY },
    jupiter: { apiUrl: e.JUPITER_API_URL, apiKey: e.JUPITER_API_KEY },
    pumpPortal: { apiUrl: e.PUMPPORTAL_API_URL },
    fx: { provider: e.FX_PROVIDER, coingeckoApiKey: e.COINGECKO_API_KEY },
    wallet: { keystorePath, passphrase },
    auth: { adminPasswordHash: e.ADMIN_PASSWORD_HASH, sessionTtlHours: e.SESSION_TTL_HOURS },
    features: {
      ingest: e.ENABLE_INGEST ?? !isTest,
      research: e.ENABLE_RESEARCH ?? !isTest,
      paper: e.ENABLE_PAPER ?? !isTest,
      liveEngine: e.ENABLE_LIVE_ENGINE ?? !isTest,
    },
  };
}
