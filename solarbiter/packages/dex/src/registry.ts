import type { DexId, PoolKind } from "@solarbiter/shared";
import type { DexAdapter } from "./types.js";

/** All registered liquidity sources. New DEXs are added by registering another adapter. */
export class DexRegistry {
  private readonly adapters = new Map<DexId, DexAdapter>();

  register(a: DexAdapter): this {
    this.adapters.set(a.id, a);
    return this;
  }

  get(id: DexId): DexAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: DexId): DexAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`no adapter for ${id}`);
    return a;
  }

  forKind(kind: PoolKind): DexAdapter | undefined {
    return [...this.adapters.values()].find((a) => a.poolKinds.includes(kind));
  }

  all(): DexAdapter[] {
    return [...this.adapters.values()];
  }

  /** Adapters whose integration is currently available. */
  available(): DexAdapter[] {
    return this.all().filter((a) => a.available().ok);
  }
}
