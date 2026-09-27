/**
 * FIFO lot book per asset (raw integer units). Pure logic — persistence is done by the caller
 * (tax_lots table), which reads `dirty()` after every change.
 */

export interface Lot {
  id: string;
  asset: string;
  acquiredAt: number;
  quantity: bigint;
  remaining: bigint;
  /** null = unknown cost basis (e.g. a deposit without a declared purchase price). */
  costEur: number | null;
  source: "swap" | "deposit" | "manual";
  signature: string | null;
}

export interface Allocation {
  lotId: string;
  quantity: bigint;
  costEur: number | null;
  acquiredAt: number;
  holdingDays: number;
}

let seq = 0;
const newId = (ts: number): string => `lot_${ts.toString(36)}_${(seq++).toString(36)}`;

export class FifoBook {
  private readonly byAsset = new Map<string, Lot[]>();
  private readonly changed = new Set<Lot>();

  constructor(lots: Lot[] = []) {
    for (const l of [...lots].sort((a, b) => a.acquiredAt - b.acquiredAt)) this.list(l.asset).push({ ...l });
  }

  private list(asset: string): Lot[] {
    let l = this.byAsset.get(asset);
    if (!l) {
      l = [];
      this.byAsset.set(asset, l);
    }
    return l;
  }

  acquire(asset: string, quantity: bigint, costEur: number | null, ts: number, source: Lot["source"], signature: string | null): Lot | null {
    if (quantity <= 0n) return null;
    const lot: Lot = { id: newId(ts), asset, acquiredAt: ts, quantity, remaining: quantity, costEur, source, signature };
    this.list(asset).push(lot);
    this.changed.add(lot);
    return lot;
  }

  /**
   * Consume `quantity` FIFO. Quantity not covered by lots (e.g. SOL that arrived before the book
   * started) is returned as an allocation with unknown cost.
   */
  dispose(asset: string, quantity: bigint, ts: number): Allocation[] {
    const out: Allocation[] = [];
    let left = quantity;
    for (const lot of this.list(asset)) {
      if (left <= 0n) break;
      if (lot.remaining <= 0n) continue;
      const take = lot.remaining < left ? lot.remaining : left;
      const share = Number(take) / Number(lot.quantity);
      out.push({ lotId: lot.id, quantity: take, costEur: lot.costEur === null ? null : lot.costEur * share, acquiredAt: lot.acquiredAt, holdingDays: Math.floor((ts - lot.acquiredAt) / 86_400_000) });
      lot.remaining -= take;
      this.changed.add(lot);
      left -= take;
    }
    if (left > 0n) out.push({ lotId: "", quantity: left, costEur: null, acquiredAt: ts, holdingDays: 0 });
    return out;
  }

  balance(asset: string): bigint {
    return this.list(asset).reduce((a, l) => a + l.remaining, 0n);
  }

  lots(asset?: string): Lot[] {
    return asset ? [...this.list(asset)] : [...this.byAsset.values()].flat();
  }

  /** Lots created or changed since the last call (for persistence). */
  dirty(): Lot[] {
    const d = [...this.changed];
    this.changed.clear();
    return d;
  }
}

/** Sum of allocation costs; null as soon as one part has an unknown cost basis. */
export function totalCost(allocs: Allocation[]): number | null {
  let s = 0;
  for (const a of allocs) {
    if (a.costEur === null) return null;
    s += a.costEur;
  }
  return s;
}
