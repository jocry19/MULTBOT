import type { Logger } from "pino";
import { TypedBus } from "../core/bus.js";
import { systemClock, type Clock } from "../core/clock.js";
import type { AppConfig } from "../core/config.js";
import { ModuleRegistry } from "../core/module.js";
import { Database } from "../db/database.js";
import { migrate } from "../db/migrate.js";
import { ActivityLog } from "../modules/activity/activityLog.js";
import { DataCollector } from "../modules/ingest/collector.js";
import { PoolRegistry } from "../modules/ingest/poolRegistry.js";
import { PumpStream } from "../modules/ingest/pumpStream.js";
import { MarketIndexer } from "../modules/market/indexer.js";
import { HeliusAdapter } from "../modules/solana/helius.js";
import { RpcManager } from "../modules/solana/rpcManager.js";
import { SolanaWsClient } from "../modules/solana/wsClient.js";
import { StateStore } from "../modules/system/stateStore.js";
import { WalletAnalyzer } from "../modules/wallets/walletAnalyzer.js";
import { WalletBook } from "../modules/wallets/walletBook.js";
import { BaseModule } from "../core/module.js";
import type { BusEvents } from "./busEvents.js";

/** Small module wrapper for periodic housekeeping jobs. */
class Housekeeping extends BaseModule {
  constructor(db: Database, activity: ActivityLog, log: Logger) {
    super("housekeeping", log);
    this.every("activity-flush", 2_000, () => activity.flush());
    this.every("db-ping", 10_000, async () => {
      await db.ping();
    });
    this.every("partitions", 6 * 3_600_000, async () => {
      const today = new Date();
      const tomorrow = new Date(Date.now() + 86_400_000);
      for (const table of ["market_trades", "volume_snapshots", "liquidity_snapshots", "token_snapshots", "research_samples"]) {
        for (const d of [today, tomorrow]) await db.query("SELECT ensure_daily_partition($1, $2::date)", [table, d.toISOString().slice(0, 10)]);
      }
    }, true);
    this.every("retention", 3_600_000, async () => {
      await db.query("DELETE FROM bot_activity WHERE ts < now() - interval '30 days'");
      await db.query("DELETE FROM auth_sessions WHERE expires_at < now()");
    });
  }
}

/**
 * Composition root. Creates every module with its dependencies and owns the start/stop order.
 * Startup order matters for crash recovery: DB → state → RPC → data → analysis → (trading engines).
 */
export class App {
  readonly bus: TypedBus<BusEvents>;
  readonly db: Database;
  readonly registry: ModuleRegistry;
  readonly state: StateStore;
  readonly activity: ActivityLog;
  readonly rpc: RpcManager;
  readonly ws: SolanaWsClient;
  readonly helius: HeliusAdapter;
  readonly pools: PoolRegistry;
  readonly wallets: WalletBook;
  readonly stream: PumpStream;
  readonly collector: DataCollector;
  readonly indexer: MarketIndexer;
  readonly walletAnalyzer: WalletAnalyzer;
  readonly startedAt = Date.now();

  constructor(
    readonly config: AppConfig,
    readonly log: Logger,
    readonly clock: Clock = systemClock,
  ) {
    this.bus = new TypedBus<BusEvents>(log);
    this.db = new Database(config.database.url, log.child({ module: "db" }), config.database.poolMax);
    this.registry = new ModuleRegistry(log);
    this.state = new StateStore(this.db);
    this.activity = new ActivityLog(this.db, this.bus, log.child({ module: "activity" }));
    this.rpc = new RpcManager(config.rpc.endpoints, log.child({ module: "rpc" }));
    this.ws = new SolanaWsClient(this.rpc.wsEndpoints, log.child({ module: "ws" }));
    this.helius = new HeliusAdapter(this.rpc);
    this.pools = new PoolRegistry(this.rpc, this.db, log.child({ module: "pools" }));
    this.wallets = new WalletBook();

    this.stream = new PumpStream(this.ws, this.pools, this.bus, clock, log.child({ module: "ingest" }));
    this.collector = new DataCollector(this.db, this.bus, log.child({ module: "collector" }), () => this.stream.takeGaps());
    this.indexer = new MarketIndexer(this.db, this.bus, this.wallets, clock, this.activity, log.child({ module: "indexer" }));
    this.walletAnalyzer = new WalletAnalyzer(this.db, this.wallets, clock, log.child({ module: "wallets" }));

    this.registry.register(new Housekeeping(this.db, this.activity, log.child({ module: "housekeeping" })));
    this.registry.register(this.rpc);
    this.registry.register(this.walletAnalyzer);
    this.registry.register(this.indexer);
    this.registry.register(this.collector);
    if (config.features.ingest) this.registry.register(this.stream);
  }

  async start(): Promise<void> {
    await migrate(this.db, this.log);
    await this.state.load();
    await this.pools.loadFromDb();
    await this.registry.startAll();
    this.activity.success("system", "MULTBOT started", { ingest: this.config.features.ingest });
  }

  async stop(): Promise<void> {
    this.activity.info("system", "MULTBOT stopping");
    await this.registry.stopAll();
    await this.activity.flush().catch(() => undefined);
    await this.db.close();
  }
}
