import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api/client";
import type { Dashboard, PositionRow, StrategyRow, TokenRow } from "../api/types";
import { ActivityFeed, useStream } from "../components/Layout";
import { Badge, Card, Kpi, Pnl, StatusBadge, Tabs, toneOf } from "../components/ui";
import { ago, compact, pct, price, sol } from "../lib/format";

const LEVEL_WIDTH: Record<string, number> = { low: 20, normal: 50, high: 80, extreme: 100 };

export function DashboardPage() {
  const nav = useNavigate();
  const { activity } = useStream();
  const d = useQuery({ queryKey: ["dashboard"], queryFn: () => api.get<Dashboard>("/api/dashboard"), refetchInterval: 10_000 });
  const disc = useQuery({ queryKey: ["discoveries"], queryFn: () => api.get<TokenRow[]>("/api/discoveries?limit=25"), refetchInterval: 10_000 });
  const strategies = useQuery({ queryKey: ["strategies"], queryFn: () => api.get<StrategyRow[]>("/api/strategies"), refetchInterval: 30_000 });
  const [posTab, setPosTab] = useState<"paper" | "live">("paper");
  const positions = useQuery({ queryKey: [posTab, "positions"], queryFn: () => api.get<PositionRow[]>(`/api/${posTab}/positions`), refetchInterval: 5_000 });
  const dd = d.data;
  const live = dd?.live;
  const active = (strategies.data ?? []).filter((s) => ["PAPER_TRADING", "PAPER_VALIDATED", "LIVE_ENABLED", "DEGRADED"].includes(s.status));

  return (
    <div className="space-y-4">
      {/* KPI row (live money; paper shown separately) */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <Kpi label="Wallet Balance" value={sol(dd?.wallet.balanceSol ?? null, 4)} detail={dd?.wallet.address ? "Bot-Wallet" : "keine Wallet"} />
        <Kpi label="Available SOL" value={sol(dd?.wallet.availableSol ?? null, 4)} detail={`Reserve ${sol(dd?.wallet.reserveSol ?? null, 3)}`} />
        <Kpi label="Locked SOL" value={sol(live?.lockedSol ?? null, 4)} detail="in offenen Positionen" />
        <Kpi label="Open Positions" value={live?.openPositions ?? "—"} detail="live" />
        <Kpi label="Portfolio Value" value={sol(live?.portfolioValueSol ?? null, 4)} detail="live, Liquidationswert" />
        <Kpi label="Realized P&L" value={<Pnl value={live?.realizedPnlSol ?? null} />} tone={toneOf(live?.realizedPnlSol)} />
        <Kpi label="Unrealized P&L" value={<Pnl value={live?.unrealizedPnlSol ?? null} />} tone={toneOf(live?.unrealizedPnlSol)} />
        <Kpi label="Today's P&L" value={<Pnl value={live?.todayPnlSol ?? null} />} tone={toneOf(live?.todayPnlSol)} />
        <Kpi label="Total P&L" value={<Pnl value={live?.totalPnlSol ?? null} />} detail={`Brutto ${sol(live?.grossPnlSol ?? null)}`} tone={toneOf(live?.totalPnlSol)} />
        <Kpi label="Fees" value={sol(live?.feesSol ?? null, 5)} detail="live, alle Gebühren" />
        <Kpi label="Slippage" value={sol(live?.slippageSol ?? null, 5)} detail="live, inkl. MEV" />
        <Kpi label="Active Strategies" value={dd?.strategies.active ?? "—"} detail={`${dd?.strategies.validated ?? 0} validiert`} />
        <Kpi label="Paper Trades" value={dd?.trades.paper ?? "—"} detail={<span>P&L <Pnl value={dd?.paper.totalPnlSol ?? null} /></span>} />
        <Kpi label="Live Trades" value={dd?.trades.live ?? "—"} detail={dd?.bot.liveState === "ACTIVE" ? "Real money ACTIVE" : "Real money LOCKED"} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-4">
          <Card title="Market Overview" subtitle="Solana-Memecoin-Markt, relativ zur eigenen Historie">
            {dd?.regime ? (
              <div className="grid gap-4 md:grid-cols-[260px_1fr]">
                <div>
                  <div className="text-[11px] text-muted">Aktuelles Regime</div>
                  <div className="mt-1 text-xl font-semibold capitalize">{dd.regime.label.replace(/_/g, " ")}</div>
                  <div className="mt-3 space-y-1.5">
                    {Object.entries(dd.regime.levels).map(([dim, level]) => (
                      <div key={dim} className="grid grid-cols-[80px_1fr_60px] items-center gap-2 text-[11.5px]">
                        <span className="capitalize text-ink-2">{dim}</span>
                        <div className="h-1.5 rounded-full bg-surface-3">
                          <div className="h-1.5 rounded-full bg-series-1" style={{ width: `${LEVEL_WIDTH[level] ?? 50}%` }} />
                        </div>
                        <span className="text-right text-muted">{level}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <MiniStat label="Trades 5 min" value={compact(dd.regime.metrics.trades_5m)} />
                  <MiniStat label="Volumen 5 min" value={`${compact(dd.regime.metrics.volume_5m)} SOL`} />
                  <MiniStat label="Neue Tokens 5 min" value={compact(dd.regime.metrics.new_tokens_5m)} />
                  <MiniStat label="Aktive Tokens" value={compact(dd.regime.metrics.active_tokens_5m)} />
                  <MiniStat label="Marktbreite" value={pct(dd.regime.metrics.breadth, 0, false)} hint="Anteil aktiver Tokens mit positiver 5-min-Rendite" />
                  <MiniStat label="Kaufanteil" value={pct(dd.regime.metrics.buy_share_5m, 0, false)} />
                  <MiniStat label="Migrationen 1 h" value={compact(dd.regime.metrics.migrations_1h)} />
                  <MiniStat label="Median-Liquidität" value={`${compact(dd.regime.metrics.median_liquidity)} SOL`} />
                  <MiniStat label="Events/min" value={compact(dd.market.eventsPerMinute)} />
                </div>
              </div>
            ) : (
              <div className="text-muted">Regime wird nach der ersten Minute Marktdaten berechnet…</div>
            )}
          </Card>

          <Card title="AI Discovery Feed" subtitle="Ungewöhnliche Situationen — Datenpunkte für die Forschung, keine Kaufsignale" dense>
            <div className="divide-y divide-line/60">
              {(disc.data ?? []).map((t) => (
                <button key={t.mint} onClick={() => nav(`/token/${t.mint}`)} className="grid w-full grid-cols-[1fr_auto] gap-3 px-4 py-2 text-left hover:bg-surface-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-ink">{t.symbol ?? t.mint.slice(0, 6)}</span>
                      <span className="truncate text-[11px] text-muted">{t.name}</span>
                      <Badge>{t.venue === "pump_amm" ? "PumpSwap" : "Curve"}</Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {t.discovery_reasons.slice(0, 4).map((r, i) => (
                        <Badge key={i} status="DISCOVERED">
                          {r.label} <span className="num opacity-70">{r.severity.toFixed(1)}</span>
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="num text-right text-[11.5px]">
                    <div className="text-ink">{price(t.price_sol)}</div>
                    <div>
                      <Pnl value={t.price_change_5m} percent /> <span className="text-muted">5m</span>
                    </div>
                    <div className="text-muted">Liq {compact(t.liquidity_sol)} · {ago(t.updated_at)}</div>
                  </div>
                </button>
              ))}
              {disc.data?.length === 0 && <div className="p-6 text-center text-muted">Gerade keine auffälligen Situationen.</div>}
            </div>
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card title="Active Strategies" actions={<Link to="/strategy-lab" className="text-[11px] text-accent hover:underline">Strategy Lab →</Link>} dense>
            <div className="divide-y divide-line/60">
              {active.slice(0, 8).map((s) => (
                <Link key={s.id} to={`/strategy-lab/${s.id}`} className="block px-4 py-2 hover:bg-surface-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="num text-[11.5px] text-ink-2">{s.id}</span>
                    <StatusBadge status={s.status} />
                  </div>
                  <div className="truncate text-[12px] text-ink">{s.name}</div>
                  <div className="num mt-0.5 flex gap-3 text-[11px] text-muted">
                    <span>{s.paper_trades} Paper</span>
                    <span>
                      E <Pnl value={s.paper?.stats?.mean ?? null} digits={5} />
                    </span>
                  </div>
                </Link>
              ))}
              {active.length === 0 && <div className="p-4 text-[12px] text-muted">Noch keine aktiven Strategien. Die Discovery-Engine sucht, sobald genug gelabelte Daten vorliegen.</div>}
            </div>
          </Card>

          <Card title="Open Positions" actions={<Tabs value={posTab} onChange={setPosTab} tabs={[{ key: "paper", label: "Paper" }, { key: "live", label: "Live" }]} />} dense>
            <div className="max-h-72 divide-y divide-line/60 overflow-auto">
              {(positions.data ?? []).map((p) => (
                <Link key={p.id} to={`/trades/${posTab}/${p.id}`} className="grid grid-cols-[1fr_auto] gap-2 px-4 py-1.5 hover:bg-surface-2">
                  <div className="min-w-0">
                    <div className="truncate text-[12px] text-ink">{p.symbol ?? p.mint.slice(0, 6)}</div>
                    <div className="num text-[10.5px] text-muted">
                      {p.strategy_id} · {ago(p.opened_at)}
                    </div>
                  </div>
                  <div className="num text-right text-[11.5px]">
                    <Pnl value={p.unrealizedSol} digits={5} />
                    <div className="text-muted">{sol(p.valueSol, 4)}</div>
                  </div>
                </Link>
              ))}
              {positions.data?.length === 0 && <div className="p-4 text-[12px] text-muted">Keine offenen {posTab === "paper" ? "Paper" : "Live"}-Positionen.</div>}
            </div>
          </Card>

          <Card title="Bot Events" subtitle="Live" dense>
            <div className="max-h-[420px] overflow-auto px-2 py-2">
              <ActivityFeed items={activity} compact />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2" title={hint}>
      <div className="text-[10.5px] text-muted">{label}</div>
      <div className="num mt-0.5 text-[13px] text-ink">{value}</div>
    </div>
  );
}
