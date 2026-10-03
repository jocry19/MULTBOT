import type { TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import type { DexRegistry, SwapInstructions } from "@solarbiter/dex";
import type { JitoExecutionAdapter } from "@solarbiter/jito";
import type { ClosingGuard } from "@solarbiter/profit-engine";
import { BASE_FEE_LAMPORTS_PER_SIGNATURE, type Opportunity, type Settings } from "@solarbiter/shared";
import type { RpcManager } from "@solarbiter/solana";
import { checkSimulation, type SimulationReport } from "@solarbiter/wallet";
import { LookupTableCache, buildTransaction, composeInstructions, microLamportsPerCu, optimizedComputeUnits } from "./composer.js";

export interface BuiltRoute {
  tx: VersionedTransaction;
  legs: SwapInstructions[];
  computeUnitLimit: number;
  microLamports: number;
  tipLamports: bigint;
  simulation: SimulationReport | null;
  simulationLogs: string[];
  unitsConsumed: number | null;
}

export interface BuilderDeps {
  registry: DexRegistry;
  rpc: RpcManager;
  jito: JitoExecutionAdapter | null;
  tables: LookupTableCache;
  settings: () => Settings;
}

/** Simulation must never be the reason a bad transaction goes out: its limit is the maximum. */
const SIMULATION_CU = 1_400_000;

/**
 * Builds the real, atomic transaction for an opportunity and simulates it against the current
 * chain state with the bot wallet. Used by shadow mode (simulate only) and live execution.
 */
export class RouteBuilder {
  constructor(private readonly d: BuilderDeps) {}

  async buildLegs(o: Opportunity, wallet: string, guard: ClosingGuard): Promise<SwapInstructions[]> {
    const legSlippage = this.d.settings().strategy.legSlippageBps;
    const out: SwapInstructions[] = [];
    for (let i = 0; i < o.legs.length; i++) {
      const q = o.legs[i];
      if (!q) throw new Error("missing leg");
      const isLast = i === o.legs.length - 1;
      const adapter = this.d.registry.require(q.source);
      out.push(
        await adapter.buildSwap({
          quote: q,
          userPublicKey: wallet,
          wrapAndUnwrapSol: true,
          slippageBps: isLast ? guard.slippageBps : legSlippage,
          useTokenLedger: isLast,
          maxWaitMs: 3_000,
        }),
      );
      const built = out[i] as SwapInstructions;
      if (isLast && built.minOutputAmount < guard.requiredOutLamports) throw new Error(`closing leg minimum ${built.minOutputAmount} below the profit guard ${guard.requiredOutLamports}`);
    }
    return out;
  }

  async tipIx(o: Opportunity, wallet: string): Promise<TransactionInstruction | null> {
    if (!this.d.jito || o.jitoTip <= 0n) return null;
    return this.d.jito.tipIx(wallet, o.jitoTip);
  }

  /**
   * Build + simulate. With `forSend`, the compute-unit limit is optimised from the simulation and the
   * transaction is rebuilt with a fresh blockhash (unsigned).
   */
  async build(o: Opportunity, wallet: string, guard: ClosingGuard, opts: { forSend: boolean; preLamports: number; rentLockedLamports: bigint }): Promise<BuiltRoute> {
    const legs = await this.buildLegs(o, wallet, guard);
    const tip = await this.tipIx(o, wallet);
    const tables = await this.d.tables.get(legs.flatMap((l) => l.lookupTables));
    const { blockhash } = await this.d.rpc.getLatestBlockhash("confirmed");
    const simIxs = composeInstructions(legs, { computeUnitLimit: SIMULATION_CU, computeUnitPriceMicroLamports: 0, tip });
    const simTx = buildTransaction(wallet, blockhash, simIxs, tables);
    const sim = await this.d.rpc.simulateTransaction(Buffer.from(simTx.serialize()).toString("base64"), [wallet], { replaceRecentBlockhash: true });
    const units = sim.unitsConsumed ?? null;
    const maxLoss = BASE_FEE_LAMPORTS_PER_SIGNATURE + Number(o.priorityFee) + Number(o.jitoTip) + Number(opts.rentLockedLamports);
    let report: SimulationReport | null = null;
    let simError: string | null = null;
    try {
      report = checkSimulation(sim, opts.preLamports, maxLoss);
    } catch (err) {
      simError = (err as Error).message;
    }
    if (!opts.forSend || simError) {
      if (simError) {
        const e = new Error(simError) as Error & { logs?: string[]; unitsConsumed?: number | null };
        e.logs = sim.logs ?? [];
        e.unitsConsumed = units;
        throw e;
      }
      return { tx: simTx, legs, computeUnitLimit: SIMULATION_CU, microLamports: 0, tipLamports: o.jitoTip, simulation: report, simulationLogs: sim.logs ?? [], unitsConsumed: units };
    }
    const cu = optimizedComputeUnits(units, SIMULATION_CU);
    const micro = microLamportsPerCu(o.priorityFee, cu);
    const fresh = await this.d.rpc.getLatestBlockhash("confirmed");
    const tx = buildTransaction(wallet, fresh.blockhash, composeInstructions(legs, { computeUnitLimit: cu, computeUnitPriceMicroLamports: micro, tip }), tables);
    return { tx, legs, computeUnitLimit: cu, microLamports: micro, tipLamports: o.jitoTip, simulation: report, simulationLogs: sim.logs ?? [], unitsConsumed: units };
  }
}

/** Shadow mode: real build + simulateTransaction, nothing is signed or sent. */
export class ShadowSimulatorImpl {
  constructor(
    private readonly builder: RouteBuilder,
    private readonly wallet: () => { address: string | null; lamports: bigint | null },
    private readonly rentLocked: (o: Opportunity) => bigint,
  ) {}

  async simulate(o: Opportunity, guard: ClosingGuard): Promise<{ ok: boolean; error: string | null; unitsConsumed: number | null; logs: string[] }> {
    const w = this.wallet();
    if (!w.address || w.lamports === null) return { ok: false, error: "shadow mode needs a configured, funded bot wallet", unitsConsumed: null, logs: [] };
    try {
      const r = await this.builder.build(o, w.address, guard, { forSend: false, preLamports: Number(w.lamports), rentLockedLamports: this.rentLocked(o) });
      return { ok: true, error: null, unitsConsumed: r.unitsConsumed, logs: r.simulationLogs.slice(-20) };
    } catch (err) {
      const e = err as Error & { logs?: string[]; unitsConsumed?: number | null };
      return { ok: false, error: e.message, unitsConsumed: e.unitsConsumed ?? null, logs: (e.logs ?? []).slice(-20) };
    }
  }
}
