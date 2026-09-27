import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../api/hooks";
import type { Perf, PortfolioSummary, PositionRow, TradeRow } from "../api/types";
import { PnlBars, TimeSeriesChart } from "../components/charts/charts";
import { PortfolioKpis, PositionsTable, TradesTable } from "../components/trades";
import { Badge, Card, Notice, PageHeader, Pnl, StatusBadge, Table, Tabs, type Column } from "../components/ui";
import { dateTime, pct, sol } from "../lib/format";

export interface CompetitionRow {
  strategyId: string;
  name: string;
  status: string;
  trades: number;
  expectancy: number;
  winRate: number;
  profitFactor: number | null;
  maxDrawdown: number;
  tailLoss: number;
  netSol: number;
  stability: number | null;
  tradesPerHour: number | null;
  pValue: number;
}

interface PaperSummary {
  portfolio: PortfolioSummary;
  stats: Perf;
  competition: CompetitionRow[];
}

export interface SignalRow {
  id: string;
  mode: string;
  strategy_id: string;
  strategy_version_id: string;
  mint: string;
  symbol: string | null;
  ts: string;
  decision: string;
  reasons: { trigger?: string; conditions?: { condition: unknown; holds: boolean }[]; blocked?: string[] } | string[];
  expected: { expectedNetReturn?: number | null; estimatedCostSol?: number | null; breakEvenMove?: number | null } | null;
}

export function CompetitionTable({ rows }: { rows: CompetitionRow[] | undefined }) {
  const nav = useNavigate();
  const columns: Column<CompetitionRow>[] = [
    { key: "rank", header: "#", cell: (r) => <span className="num text-muted">{(rows ?? []).indexOf(r) + 1}</span> },
    {
      key: "s",
      header: "Strategie",
      cell: (r) => (
        <div>
          <span className="num text-[11px] text-muted">{r.strategyId}</span> <span className="text-ink">{r.name}</span>
        </div>
      ),
    },
    { key: "st", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
    { key: "n", header: "Trades", align: "right", cell: (r) => <span className="num">{r.trades}</span>, sort: (r) => r.trades },
    { key: "e", header: "Ø netto / Trade", align: "right", cell: (r) => <Pnl value={r.expectancy} digits={5} />, sort: (r) => r.expectancy },
    { key: "net", header: "Netto gesamt", align: "right", cell: (r) => <Pnl value={r.netSol} digits={4} />, sort: (r) => r.netSol },
    { key: "wr", header: "Trefferquote", align: "right", cell: (r) => <span className="num">{pct(r.winRate, 1, false)}</span>, sort: (r) => r.winRate },
    { key: "pf", header: "Profit Factor", align: "right", cell: (r) => <span className="num">{r.profitFactor?.toFixed(2) ?? "∞"}</span>, sort: (r) => r.profitFactor },
    { key: "dd", header: "Max DD", align: "right", cell: (r) => <span className="num text-ink-2">{sol(r.maxDrawdown, 4)}</span>, sort: (r) => -r.maxDrawdown },
    { key: "tail", header: "Tail Loss (5%)", align: "right", cell: (r) => <Pnl value={r.tailLoss} digits={5} />, sort: (r) => r.tailLoss },
    { key: "stab", header: "Stabilität", align: "right", cell: (r) => <span className="num text-ink-2">{r.stability?.toFixed(3) ?? "—"}</span>, sort: (r) => r.stability },
    { key: "freq", header: "Trades / h", align: "right", cell: (r) => <span className="num text-ink-2">{r.tradesPerHour?.toFixed(2) ?? "—"}</span>, sort: (r) => r.tradesPerHour },
    { key: "p", header: "p (E≤0)", align: "right", cell: (r) => <span className="num text-ink-2">{r.pValue.toPrecision(2)}</span>, sort: (r) => r.pValue },
  ];
  return <Table rows={rows} columns={columns} rowKey={(r) => r.strategyId} onRowClick={(r) => nav(`/strategy-lab/${r.strategyId}`)} empty="Noch keine abgeschlossenen Paper Trades" />;
}

export function SignalsTable({ rows }: { rows: SignalRow[] | undefined }) {
  const columns: Column<SignalRow>[] = [
    { key: "ts", header: "Zeit", cell: (s) => <span className="num text-ink-2">{dateTime(s.ts)}</span> },
    { key: "t", header: "Token", cell: (s) => <span className="text-ink">{s.symbol ?? `${s.mint.slice(0, 6)}…`}</span> },
    { key: "s", header: "Strategie", cell: (s) => <span className="num text-ink-2">{s.strategy_version_id}</span> },
    { key: "d", header: "Entscheidung", cell: (s) => <Badge status={s.decision}>{s.decision}</Badge> },
    {
      key: "why",
      header: "Auslöser",
      cell: (s) => <span className="text-ink-2">{Array.isArray(s.reasons) ? s.reasons.join(", ") : (s.reasons.trigger ?? "—")}</span>,
    },
    { key: "exp", header: "Erwartet netto", align: "right", cell: (s) => <Pnl value={s.expected?.expectedNetReturn ?? null} percent /> },
    { key: "be", header: "Break-even", align: "right", cell: (s) => <span className="num text-ink-2">{pct(s.expected?.breakEvenMove ?? null, 1)}</span> },
  ];
  return <Table rows={rows} columns={columns} rowKey={(s) => s.id} maxHeight={420} empty="Keine Signale" />;
}

export function PaperTradingPage() {
  const [tab, setTab] = useState<"closed" | "all" | "failed">("closed");
  const summary = useApi<PaperSummary>("paper", "/api/paper/summary", 10_000);
  const positions = useApi<PositionRow[]>("paper", "/api/paper/positions", 5_000);
  const trades = useApi<TradeRow[]>("paper", `/api/paper/trades?limit=500${tab === "closed" ? "&status=CLOSED" : tab === "failed" ? "&status=FAILED" : ""}`, 10_000);
  const closedAll = useApi<TradeRow[]>("paper", "/api/paper/trades?limit=1000&status=CLOSED", 30_000);
  const signals = useApi<SignalRow[]>("paper", "/api/signals?mode=paper&limit=100", 10_000);

  const curve = useMemo(() => {
    const rows = [...(closedAll.data ?? [])].filter((t) => t.closed_at && t.net_pnl_sol !== null).sort((a, b) => new Date(a.closed_at as string).getTime() - new Date(b.closed_at as string).getTime());
    let eq = 0;
    let gross = 0;
    const net: { t: number; v: number }[] = [];
    const gr: { t: number; v: number }[] = [];
    const bars: { t: number; v: number }[] = [];
    for (const r of rows) {
      const t = new Date(r.closed_at as string).getTime();
      eq += r.net_pnl_sol ?? 0;
      gross += r.gross_pnl_sol ?? 0;
      net.push({ t, v: eq });
      gr.push({ t, v: gross });
      bars.push({ t, v: r.net_pnl_sol ?? 0 });
    }
    return { series: [{ name: "Netto (kumuliert)", data: net }, { name: "Brutto (kumuliert)", data: gr, kind: "line" as const }], bars };
  }, [closedAll.data]);

  const st = summary.data?.stats;
  return (
    <div className="space-y-4">
      <PageHeader title="Paper Trading" subtitle="Echte Live-Daten, simulierte Ausführung (Verzögerung, Slippage, Gebühren, Fehlschläge). Vollständig getrennt vom Echtgeld." />
      <PortfolioKpis p={summary.data?.portfolio} winRate={st?.winRate ?? null} expectancy={st?.mean ?? null} />
      {curve.bars.length > 1 && (
        <Card title="Equity-Kurve" subtitle="Kumuliertes Ergebnis aller geschlossenen Paper Trades — Brutto vs. Netto zeigt die Kostenlast">
          <TimeSeriesChart series={curve.series} height={240} zeroLine format={(v) => v.toFixed(4)} />
          <div className="mt-3 text-[11px] text-muted">Netto-Ergebnis je Trade</div>
          <PnlBars points={curve.bars} height={110} />
        </Card>
      )}
      <Card dense title="Strategie-Wettbewerb" subtitle="Sortiert nach Erwartungswert netto je Trade">
        <CompetitionTable rows={summary.data?.competition} />
      </Card>
      <Card dense title="Offene Paper-Positionen" subtitle={`${positions.data?.length ?? 0} offen`}>
        <PositionsTable rows={positions.data} mode="paper" />
      </Card>
      <Card
        dense
        title="Paper Trades"
        actions={
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { key: "closed", label: "Geschlossen" },
              { key: "failed", label: "Fehlgeschlagen" },
              { key: "all", label: "Alle" },
            ]}
          />
        }
      >
        <TradesTable rows={trades.data} mode="paper" />
      </Card>
      <Card dense title="Signale" subtitle="Jede Einstiegsentscheidung wird mit Begründung protokolliert">
        <SignalsTable rows={signals.data} />
      </Card>
      <Notice>Paper-Ergebnisse sind eine Simulation. Echte Ausführung kann durch Latenz, Konkurrenz und MEV schlechter ausfallen.</Notice>
    </div>
  );
}
