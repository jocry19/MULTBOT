import type { TokenInfo, TokenListEntry } from "@solarbiter/shared";
import type { Logger } from "pino";
import { decodeMint, tokenSafety, type MintInfo } from "./mint.js";
import type { RpcManager } from "./rpcManager.js";

export interface TokenPolicy {
  allowlist: string[];
  denylist: string[];
}

interface Loaded {
  entry: TokenListEntry;
  owner: string | null;
  info: MintInfo | null;
}

/**
 * Token universe with on-chain facts (program, decimals, authorities) and the safety verdict.
 * Unsafe tokens stay listed (so the UI can show why) but are never traded.
 */
export class TokenRegistry {
  private loaded = new Map<string, Loaded>();
  private tokens = new Map<string, TokenInfo>();
  private policy: TokenPolicy = { allowlist: [], denylist: [] };
  lastLoadedAt: number | null = null;

  constructor(
    private readonly rpc: RpcManager,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Read all mint accounts (batched) and evaluate them under the policy. */
  async load(list: TokenListEntry[], policy: TokenPolicy): Promise<TokenInfo[]> {
    const mints = [...new Set(list.map((t) => t.mint))];
    const r = await this.rpc.getMultipleAccountsWithSlot(mints);
    const next = new Map<string, Loaded>();
    mints.forEach((mint, i) => {
      const entry = list.find((t) => t.mint === mint) as TokenListEntry;
      const acc = r.accounts[i];
      let info: MintInfo | null = null;
      if (acc) {
        try {
          info = decodeMint(Buffer.from(acc.data[0], "base64"));
        } catch (err) {
          this.log.warn({ mint, err: (err as Error).message }, "mint decode failed");
        }
      }
      next.set(mint, { entry, owner: acc?.owner ?? null, info });
    });
    this.loaded = next;
    this.lastLoadedAt = this.now();
    return this.applyPolicy(policy);
  }

  /** Re-evaluate safety after an allow/deny list change (no RPC). */
  applyPolicy(policy: TokenPolicy): TokenInfo[] {
    this.policy = { allowlist: [...policy.allowlist], denylist: [...policy.denylist] };
    const out = new Map<string, TokenInfo>();
    for (const [mint, l] of this.loaded) {
      const allowlisted = this.policy.allowlist.includes(mint) || l.entry.trusted === true;
      const denylisted = this.policy.denylist.includes(mint);
      const verdict = tokenSafety({ mint, owner: l.owner, info: l.info, allowlisted, denylisted });
      out.set(mint, {
        mint,
        symbol: l.entry.symbol,
        name: l.entry.name,
        decimals: l.info?.decimals ?? 0,
        program: l.owner ?? "",
        mintAuthority: l.info?.mintAuthority ?? null,
        freezeAuthority: l.info?.freezeAuthority ?? null,
        allowlisted,
        denylisted,
        safe: verdict.safe,
        safetyReasons: verdict.reasons,
      });
    }
    this.tokens = out;
    return this.all();
  }

  get(mint: string): TokenInfo | undefined {
    return this.tokens.get(mint);
  }

  all(): TokenInfo[] {
    return [...this.tokens.values()];
  }

  safe(): TokenInfo[] {
    return this.all().filter((t) => t.safe);
  }

  isTradable(mint: string): boolean {
    return this.tokens.get(mint)?.safe === true;
  }

  decimals(mint: string): number | undefined {
    const t = this.tokens.get(mint);
    return t && t.program ? t.decimals : undefined;
  }

  symbol(mint: string): string {
    return this.tokens.get(mint)?.symbol ?? `${mint.slice(0, 4)}…`;
  }
}
