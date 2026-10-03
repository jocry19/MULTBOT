/**
 * Wallet clustering from co-trading behaviour.
 *
 * Two wallets are linked when they are both among the early buyers of at least `minSharedTokens`
 * different tokens. Connected components of that graph form clusters. Whether a cluster carries
 * information is NOT assumed here — cluster features go into the research dataset and the discovery
 * engine tests them statistically like any other feature.
 */

export interface CoTradeObservation {
  mint: string;
  wallet: string;
  slot: number;
  ts: number;
}

export interface WalletCluster {
  members: string[];
  sharedTokens: number;
  sameSlotRate: number;
  edges: number;
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function clusterWallets(
  obs: CoTradeObservation[],
  opts: { minSharedTokens: number; maxClusterSize: number; minTokensPerWallet?: number },
): WalletCluster[] {
  const minTokens = opts.minTokensPerWallet ?? opts.minSharedTokens;
  // 1. only wallets that are early buyers in several tokens can be linked at all
  const walletTokens = new Map<string, Set<string>>();
  for (const o of obs) {
    let s = walletTokens.get(o.wallet);
    if (!s) {
      s = new Set();
      walletTokens.set(o.wallet, s);
    }
    s.add(o.mint);
  }
  const eligible = new Set([...walletTokens].filter(([, s]) => s.size >= minTokens).map(([w]) => w));

  // 2. co-occurrence counts per wallet pair
  const byMint = new Map<string, CoTradeObservation[]>();
  for (const o of obs) {
    if (!eligible.has(o.wallet)) continue;
    const arr = byMint.get(o.mint) ?? [];
    arr.push(o);
    byMint.set(o.mint, arr);
  }
  const pairs = new Map<string, { shared: number; sameSlot: number }>();
  for (const arr of byMint.values()) {
    const firstByWallet = new Map<string, CoTradeObservation>();
    for (const o of arr) if (!firstByWallet.has(o.wallet)) firstByWallet.set(o.wallet, o);
    const ws = [...firstByWallet.values()];
    for (let i = 0; i < ws.length; i++) {
      for (let j = i + 1; j < ws.length; j++) {
        const a = ws[i] as CoTradeObservation;
        const b = ws[j] as CoTradeObservation;
        const key = a.wallet < b.wallet ? `${a.wallet}|${b.wallet}` : `${b.wallet}|${a.wallet}`;
        const p = pairs.get(key) ?? { shared: 0, sameSlot: 0 };
        p.shared++;
        if (a.slot === b.slot) p.sameSlot++;
        pairs.set(key, p);
      }
    }
  }

  // 3. connected components over strong edges
  const uf = new UnionFind();
  const strong: [string, string, { shared: number; sameSlot: number }][] = [];
  for (const [key, p] of pairs) {
    if (p.shared < opts.minSharedTokens) continue;
    const [a, b] = key.split("|") as [string, string];
    uf.union(a, b);
    strong.push([a, b, p]);
  }
  const groups = new Map<string, { members: Set<string>; shared: number; sameSlot: number; edges: number }>();
  for (const [a, b, p] of strong) {
    const root = uf.find(a);
    const g = groups.get(root) ?? { members: new Set<string>(), shared: 0, sameSlot: 0, edges: 0 };
    g.members.add(a);
    g.members.add(b);
    g.shared += p.shared;
    g.sameSlot += p.sameSlot;
    g.edges++;
    groups.set(root, g);
  }
  return [...groups.values()]
    .filter((g) => g.members.size >= 2 && g.members.size <= opts.maxClusterSize)
    .map((g) => ({
      members: [...g.members].sort(),
      sharedTokens: g.shared / g.edges,
      sameSlotRate: g.shared > 0 ? g.sameSlot / g.shared : 0,
      edges: g.edges,
    }))
    .sort((a, b) => b.members.length - a.members.length);
}
