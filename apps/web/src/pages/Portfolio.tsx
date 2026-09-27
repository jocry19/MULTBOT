import { useMemo } from "react";
import { useApi } from "../api/hooks";
import type { Dashboard, PositionRow, TradeRow } from "../api/types";
import { BarList } from "../components/charts/charts";
import { PortfolioKpis } from "../components/trades";
import { Card, PageHeader } from "../components/ui";

function byStrategy(trades: TradeRow[] | undefined): { label: string; value: number; hint: string }[] {
  const m = new Map<string, { net: number; n: number }>();
  for (const t of trades ?? []) {
    if (t.net_pnl_sol === null) continue;
    const e = m.get(t.strategy_id) ?? { net: 0, n: 0 };
    e.net += t.net_pnl_sol;
    e.n++;
    m.set(t.strategy_id, e);
  }
  return [...m.entries()].map(([k, v]) => ({ label: `${k} (${v.n})`, value: v.net, hint: `${v.n} Trades` })).sort((a, b) => b.value - a.value);
}

function allocation(pos: PositionRow[] | undefined) {
  return (pos ?? []).map((p) => ({ label: p.symbol ?? p.mint.slice(0, 6), value: p.valueSol })).sort((a, b) => b.value - a.value);
}

export function PortfolioPage() {
  const dash = useApi<Dashboard>("dashboard", "/api/dashboard", 10_000);
  const livePos = useApi<PositionRow[]>("live", "/api/live/positions", 10_000);
  const paperPos = useApi<PositionRow[]>("paper", "/api/paper/positions", 10_000);
  const liveTrades = useApi<TradeRow[]>("live", "/api/live/trades?limit=1000", 30_000);
  const paperTrades = useApi<TradeRow[]>("paper", "/api/paper/trades?limit=1000", 30_000);
  const liveStrat = useMemo(() => byStrategy(liveTrades.data), [liveTrades.data]);
  const paperStrat = useMemo(() => byStrategy(paperTrades.data), [paperTrades.data]);

  return (
    <div className="space-y-6">
      <PageHeader title="Portfolio" subtitle="Live (Echtgeld) und Paper werden getrennt geführt und nie vermischt" />
      <section className="space-y-3">
        <h2 className="text-[13px] font-semibold text-ink">Live — Echtgeld</h2>
        <PortfolioKpis p={dash.data?.live} />
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Allokation" subtitle="Liquidationswert je offener Position (SOL)">
            {allocation(livePos.data).length ? <BarList rows={allocation(livePos.data)} format={(v) => v.toFixed(4)} /> : <div className="text-[12px] text-muted">Keine offenen Live-Positionen</div>}
          </Card>
          <Card title="Netto-Ergebnis je Strategie" subtitle="SOL, nach allen Kosten">
            {liveStrat.length ? <BarList signed rows={liveStrat} format={(v) => Math.abs(v).toFixed(4)} /> : <div className="text-[12px] text-muted">Noch keine Live Trades</div>}
          </Card>
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="text-[13px] font-semibold text-ink">Paper — virtuell</h2>
        <PortfolioKpis p={dash.data?.paper} />
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Allokation" subtitle="Liquidationswert je offener Position (SOL)">
            {allocation(paperPos.data).length ? <BarList rows={allocation(paperPos.data)} format={(v) => v.toFixed(4)} /> : <div className="text-[12px] text-muted">Keine offenen Paper-Positionen</div>}
          </Card>
          <Card title="Netto-Ergebnis je Strategie" subtitle="SOL, nach allen Kosten">
            {paperStrat.length ? <BarList signed rows={paperStrat} format={(v) => Math.abs(v).toFixed(4)} /> : <div className="text-[12px] text-muted">Noch keine Paper Trades</div>}
          </Card>
        </div>
      </section>
    </div>
  );
}
