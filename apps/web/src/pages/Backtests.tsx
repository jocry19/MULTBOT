import { ArrowLeft } from "lucide-react";
import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useApi } from "../api/hooks";
import { BarList, TimeSeriesChart } from "../components/charts/charts";
import { Badge, Card, ErrorBox, Kpi, Loading, PageHeader, Pnl, StatusBadge, Table, toneOf, type Column } from "../components/ui";
import { dateTime, duration, pct, price, signed, sol } from "../lib/format";
import { costRows, type BacktestMetrics } from "./StrategyDetail";

interface BacktestRow {
  id: number;
  strategy_version_id: string;
  strategy_id: string;
  created_at: string;
  finished_at: string | null;
  status: string;
  metrics: BacktestMetrics | null;
  period_start: string | null;
  period_end: string | null;
  error: string | null;
}

interface BacktestFull extends BacktestRow {
  config: Record<string, unknown>;
  equity_curve: { ts: number; equity: number }[] | null;
  cost_breakdown: Record<string, number> | null;
  regime_breakdown: { label: string; n: number; netSol: number; winRate: number }[] | null;
}

interface BtTrade {
  seq: number;
  mint: string;
  decision_ts: string;
  entry_ts: string | null;
  exit_ts: string | null;
  entry_price: number | null;
  exit_price: number | null;
  gross_pnl_sol: number;
  net_pnl_sol: number;
  net_return: number;
  costs: Record<string, number>;
  exit_reason: string | null;
  failed: boolean;
}

export function BacktestsPage() {
  const nav = useNavigate();
  const q = useApi<BacktestRow[]>("strategies", "/api/backtests", 20_000);
  const columns: Column<BacktestRow>[] = [
    { key: "id", header: "#", cell: (b) => <span className="num text-muted">{b.id}</span>, sort: (b) => b.id },
    { key: "s", header: "Strategie", cell: (b) => <span className="num text-ink">{b.strategy_version_id}</span> },
    { key: "t", header: "Gestartet", cell: (b) => <span className="num text-ink-2">{dateTime(b.created_at)}</span> },
    { key: "st", header: "Status", cell: (b) => <StatusBadge status={b.status.toUpperCase()} /> },
    {
      key: "res",
      header: "Ergebnis",
      cell: (b) => (b.metrics ? <Badge status={b.metrics.passed ? "PAPER_VALIDATED" : "REJECTED"}>{b.metrics.passed ? "bestanden" : b.metrics.reason}</Badge> : b.error ? <span className="text-rose-300">{b.error}</span> : "—"),
    },
    { key: "n", header: "Trades", align: "right", cell: (b) => <span className="num">{b.metrics?.stats.n ?? "—"}</span>, sort: (b) => b.metrics?.stats.n ?? null },
    { key: "g", header: "Brutto", align: "right", cell: (b) => <Pnl value={b.metrics?.grossPnlSol ?? null} digits={4} />, sort: (b) => b.metrics?.grossPnlSol ?? null },
    { key: "net", header: "Netto", align: "right", cell: (b) => <Pnl value={b.metrics?.netPnlSol ?? null} digits={4} />, sort: (b) => b.metrics?.netPnlSol ?? null },
    { key: "wr", header: "Trefferquote", align: "right", cell: (b) => <span className="num">{pct(b.metrics?.stats.winRate ?? null, 1, false)}</span> },
    { key: "pf", header: "PF", align: "right", cell: (b) => <span className="num">{b.metrics?.stats.profitFactor?.toFixed(2) ?? "—"}</span> },
    { key: "dd", header: "Max DD", align: "right", cell: (b) => <span className="num text-ink-2">{sol(b.metrics?.stats.maxDrawdown ?? null, 4)}</span> },
    {
      key: "p",
      header: "Zeitraum",
      cell: (b) => (
        <span className="num text-[10.5px] text-muted">
          {dateTime(b.period_start)} – {dateTime(b.period_end)}
        </span>
      ),
    },
  ];
  return (
    <div className="space-y-4">
      <PageHeader title="Backtests" subtitle="Kausale Simulation auf gespeicherten Marktdaten: Verzögerung, Slippage aus Curve/Pool-Zustand, Gebühren, Fehlschläge" />
      <Card dense>
        <Table rows={q.data} columns={columns} rowKey={(b) => String(b.id)} onRowClick={(b) => nav(`/backtests/${b.id}`)} maxHeight={780} empty="Noch keine Backtests" />
      </Card>
    </div>
  );
}

export function BacktestDetailPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const q = useApi<{ backtest: BacktestFull | null; trades: BtTrade[] }>("strategies", `/api/backtests/${id}`);
  const series = useMemo(() => (q.data?.backtest?.equity_curve ? [{ name: "Netto kumuliert", data: q.data.backtest.equity_curve.map((p) => ({ t: p.ts, v: p.equity })) }] : []), [q.data]);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const b = q.data?.backtest;
  if (!b) return <ErrorBox error="Backtest nicht gefunden" />;
  const m = b.metrics;
  return (
    <div className="space-y-4">
      <button onClick={() => nav("/backtests")} className="inline-flex items-center gap-1 text-[11.5px] text-muted hover:text-ink">
        <ArrowLeft size={13} /> Backtests
      </button>
      <PageHeader
        title={`Backtest #${b.id}`}
        subtitle={
          <>
            <Link to={`/strategy-lab/${b.strategy_version_id.split("@")[0]}`} className="text-accent hover:underline">
              {b.strategy_version_id}
            </Link>{" "}
            · {dateTime(b.period_start)} – {dateTime(b.period_end)}
          </>
        }
        actions={m && <Badge status={m.passed ? "PAPER_VALIDATED" : "REJECTED"}>{m.passed ? "bestanden" : m.reason}</Badge>}
      />
      {m && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
          <Kpi label="Netto P&L" value={<Pnl value={m.netPnlSol} />} tone={toneOf(m.netPnlSol)} />
          <Kpi label="Brutto P&L" value={<Pnl value={m.grossPnlSol} />} tone={toneOf(m.grossPnlSol)} />
          <Kpi label="Trades" value={m.stats.n} detail={`${m.failedEntries} Einstiege fehlgeschlagen`} />
          <Kpi label="Trefferquote" value={pct(m.stats.winRate, 1, false)} detail={`PF ${m.stats.profitFactor?.toFixed(2) ?? "—"}`} />
          <Kpi label="Ø / Median netto" value={<Pnl value={m.stats.mean} digits={5} />} detail={`Median ${signed(m.stats.median, 5)}`} />
          <Kpi label="Worst / Max DD" value={<Pnl value={m.stats.worst} digits={5} />} detail={`DD ${sol(m.stats.maxDrawdown, 4)}`} />
        </div>
      )}
      {series[0] && series[0].data.length > 1 && (
        <Card title="Equity-Kurve (netto)">
          <TimeSeriesChart series={series} height={240} zeroLine format={(v) => v.toFixed(4)} />
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Kosten" subtitle={`Summe ${b.cost_breakdown?.totalSol?.toFixed(4) ?? "—"} SOL`}>
          <BarList rows={costRows(b.cost_breakdown)} format={(v) => v.toFixed(5)} />
        </Card>
        <Card title="Nach Marktregime" subtitle="Netto SOL">
          <BarList signed rows={(b.regime_breakdown ?? []).map((r) => ({ label: `${r.label.replace(/_/g, " ")} (${r.n})`, value: r.netSol, hint: `Trefferquote ${pct(r.winRate, 0, false)}` }))} format={(v) => Math.abs(v).toFixed(4)} />
        </Card>
      </div>
      <Card dense title="Trades" subtitle={`${q.data?.trades.length ?? 0} (max. 2000 angezeigt)`}>
        <Table
          rows={q.data?.trades}
          rowKey={(t) => String(t.seq)}
          maxHeight={620}
          onRowClick={(t) => nav(`/token/${t.mint}`)}
          columns={[
            { key: "s", header: "#", cell: (t) => <span className="num text-muted">{t.seq}</span> },
            { key: "d", header: "Entscheidung", cell: (t) => <span className="num text-ink-2">{dateTime(t.decision_ts)}</span> },
            { key: "m", header: "Token", cell: (t) => <span className="num">{t.mint.slice(0, 8)}…</span> },
            { key: "e", header: "Einstieg", align: "right", cell: (t) => <span className="num text-ink-2">{price(t.entry_price)}</span> },
            { key: "x", header: "Ausstieg", align: "right", cell: (t) => <span className="num text-ink-2">{price(t.exit_price)}</span> },
            {
              key: "h",
              header: "Dauer",
              align: "right",
              cell: (t) => <span className="num text-muted">{t.entry_ts && t.exit_ts ? duration((new Date(t.exit_ts).getTime() - new Date(t.entry_ts).getTime()) / 1000) : "—"}</span>,
            },
            { key: "g", header: "Brutto", align: "right", cell: (t) => <Pnl value={t.gross_pnl_sol} digits={5} />, sort: (t) => t.gross_pnl_sol },
            { key: "c", header: "Kosten", align: "right", cell: (t) => <span className="num text-ink-2">{(t.costs.totalSol ?? 0).toFixed(5)}</span> },
            { key: "n", header: "Netto", align: "right", cell: (t) => <Pnl value={t.net_pnl_sol} digits={5} />, sort: (t) => t.net_pnl_sol },
            { key: "r", header: "Rendite", align: "right", cell: (t) => <Pnl value={t.net_return} percent />, sort: (t) => t.net_return },
            { key: "x2", header: "Grund", cell: (t) => (t.failed ? <Badge status="FAILED">fehlgeschlagen</Badge> : <span className="text-ink-2">{t.exit_reason}</span>) },
          ]}
        />
      </Card>
    </div>
  );
}
