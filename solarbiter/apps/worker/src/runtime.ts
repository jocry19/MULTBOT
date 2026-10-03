import { Database, StateStore } from "@solarbiter/database";
import { DexRegistry, PoolStateService } from "@solarbiter/dex";
import { LookupTableCache, LiveExecutor, RouteBuilder, ShadowSimulatorImpl } from "@solarbiter/execution-engine";
import { JitoClient, JitoExecutionAdapter } from "@solarbiter/jito";
import { JupiterAdapter, JupiterClient } from "@solarbiter/jupiter";
import { LearningEngine } from "@solarbiter/learning-engine";
import { MeteoraAdapter } from "@solarbiter/meteora";
import { NotificationService } from "@solarbiter/notifications";
import { OrcaAdapter } from "@solarbiter/orca";
import { PaperExecutor, registryRequoter } from "@solarbiter/paper-engine";
import { FxService } from "@solarbiter/quotes";
import { RaydiumAdapter } from "@solarbiter/raydium";
import { BreakerBoard, RiskEngine } from "@solarbiter/risk-engine";
import { DEFAULT_SETTINGS, TOKEN_ACCOUNT_RENT_LAMPORTS, type Opportunity, type Settings } from "@solarbiter/shared";
import { RedisBus, type AppConfig } from "@solarbiter/shared/node";
import { PriorityFeeOracle, RpcManager, TokenRegistry } from "@solarbiter/solana";
import { TaxLedger } from "@solarbiter/tax";
import { WalletService } from "@solarbiter/wallet";
import type { Logger } from "pino";
import { Repo } from "./repo.js";

/** Every long-lived component of the worker, wired together (no trading logic here). */
export class Runtime {
  readonly db: Database;
  readonly repo: Repo;
  readonly store: StateStore;
  readonly bus: RedisBus;
  readonly rpc: RpcManager;
  readonly jupiter: JupiterClient;
  readonly registry: DexRegistry;
  readonly pools: PoolStateService;
  readonly tokens: TokenRegistry;
  readonly fx: FxService;
  readonly fees: PriorityFeeOracle;
  readonly jitoClient: JitoClient;
  readonly jito: JitoExecutionAdapter;
  readonly wallet: WalletService;
  readonly risk = new RiskEngine();
  readonly breakers = new BreakerBoard();
  readonly learning: LearningEngine;
  readonly notifications: NotificationService;
  readonly tables: LookupTableCache;
  builder!: RouteBuilder;
  shadowSimulator!: ShadowSimulatorImpl;
  liveExecutor!: LiveExecutor;
  /** Fixed when the execution layer is built (changing it needs a worker restart). */
  jitoEnabled = true;
  readonly tax = new TaxLedger();
  settings: Settings = DEFAULT_SETTINGS;

  constructor(
    readonly config: AppConfig,
    readonly log: Logger,
  ) {
    this.db = new Database(config.database.url, log.child({ component: "db" }), config.database.poolMax);
    this.repo = new Repo(this.db);
    this.store = new StateStore(this.db);
    this.bus = new RedisBus(config.redisUrl, log.child({ component: "redis" }));
    this.rpc = new RpcManager(
      config.rpc.urls.map((u, i) => ({ name: i === 0 ? "primary" : `fallback${i}`, kind: /helius/i.test(u) ? "helius" : "generic", httpUrl: u, wsUrl: i === 0 ? config.rpc.wsUrl : null, rps: config.rpc.rps })),
      log.child({ component: "rpc" }),
    );
    this.jupiter = new JupiterClient({ baseUrl: config.jupiter.apiUrl, apiKey: config.jupiter.apiKey, rps: config.jupiter.rps, log: log.child({ component: "jupiter" }) });
    const dexLog = log.child({ component: "dex" });
    this.registry = new DexRegistry()
      .register(new RaydiumAdapter(this.jupiter, this.rpc, dexLog))
      .register(new OrcaAdapter(this.jupiter, this.rpc, dexLog))
      .register(new MeteoraAdapter(this.jupiter, this.rpc, dexLog))
      .register(new JupiterAdapter(this.jupiter));
    this.pools = new PoolStateService(this.rpc, this.registry, dexLog);
    this.tokens = new TokenRegistry(this.rpc, log.child({ component: "tokens" }));
    this.fx = new FxService(config.fxUrl, log.child({ component: "fx" }));
    this.fees = new PriorityFeeOracle(this.rpc, log.child({ component: "fees" }));
    this.jitoClient = new JitoClient({ blockEngineUrl: config.jito.blockEngineUrl, tipFloorUrl: config.jito.tipFloorUrl, auth: config.jito.auth });
    this.jito = new JitoExecutionAdapter(this.jitoClient);
    this.wallet = new WalletService(this.rpc, log.child({ component: "wallet" }), config.wallet);
    this.learning = new LearningEngine(() => this.settings);
    this.notifications = new NotificationService(
      {
        store: (n) => this.repo.storeNotification(n),
        publish: (n) => this.bus.publishEvent("NOTIFICATION", n),
        markWebhook: (id, ok) => this.repo.markWebhook(id, ok),
      },
      log.child({ component: "notify" }),
      { webhookUrl: config.notifyWebhookUrl },
    );
    this.tables = new LookupTableCache(this.rpc);
  }

  /** Build the execution layer once the settings are loaded. */
  initExecution(): void {
    const log = this.log;
    this.jitoEnabled = this.settings.strategy.useJito;
    const jito = this.jitoEnabled ? this.jito : null;
    this.builder = new RouteBuilder({ registry: this.registry, rpc: this.rpc, jito, tables: this.tables, settings: () => this.settings });
    this.shadowSimulator = new ShadowSimulatorImpl(this.builder, () => ({ address: this.wallet.address, lamports: this.wallet.lamports }), (o) => this.rentLocked(o));
    this.liveExecutor = new LiveExecutor({
      registry: this.registry,
      rpc: this.rpc,
      risk: this.risk,
      builder: this.builder,
      wallet: this.wallet,
      jito,
      journal: { begin: (k, o) => this.repo.beginAttempt(k, o), update: (k, p) => this.repo.updateAttempt(k, p) },
      settings: () => this.settings,
      decimals: (m) => this.tokens.decimals(m),
      rentLocked: (o) => this.rentLocked(o),
      log: log.child({ component: "live" }),
    });
  }

  /** Rent for intermediate token accounts the wallet does not have yet (locked, refundable). */
  rentLocked(o: Opportunity): bigint {
    const missing = o.route.slice(1, -1).filter((m) => !this.wallet.hasTokenAccount(m)).length;
    return BigInt(missing * TOKEN_ACCOUNT_RENT_LAMPORTS);
  }

  paperExecutor(shadow: boolean): PaperExecutor {
    return new PaperExecutor({
      risk: this.risk,
      requote: registryRequoter(this.registry, (m) => this.tokens.decimals(m), this.jitoEnabled),
      simulator: shadow ? this.shadowSimulator : null,
      settings: () => this.settings,
      latencyMs: () => this.learning.latencyMs(),
      viaJito: () => this.jitoEnabled,
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
  }
}
