import { useMemo, useState } from "react";
import { useApi } from "../api/hooks";
import type { TradeRow } from "../api/types";
import { BarList, TimeSeriesChart } from "../components/charts/charts";
import { totalCosts } from "../components/trades";
import { Card, KV, Kpi, Notice, PageHeader, Pnl, Table, Tabs, toneOf } from "../components/ui";
import { pct, sol } from "../lib/format";

interface LearningResp {
  quality: { mode: string; decision_quality: string; outcome_quality: string; n: number }[];
  recent: { id: number; ts: string; mode: string; trade_id: string; decision_quality: string; outcome_quality: string; prediction_error: number | null; action: string | null; attribution: Record<string, unknown> }[];
}

interface Calibration {
  liveTrades: number;
  sufficient: boolean;
  live: { slippageShare: number | null; priorityFeeSol: number | null; failedEntries: number };
  paper: { slippageShare: number | null; priorityFeeSol: number | null };
  assumptions: { failedTxRate: number; assumedPriorityFeeSol: number; mevImpactBps: number; executionDelayMs: number };
}

interface RegimeHistory {
  history: { ts: string; label: string; metrics: Record<string, number> }[];
}

function group(trades: TradeRow[], key: (t: TradeRow) => string) {
  const m = new Map<string, { n: number; net: number; wins: number }>();
  for (const t of trades) {
    const k = key(t);
    const e = m.get(k) ?? { n: 0, net: 0, wins: 0 };
    e.n++;
    e.net += t.net_pnl_sol ?? 0;
    if ((t.net_pnl_sol ?? 0) > 0) e.wins++;
    m.set(k, e);
  }
  return [...m.entries()].map(([k, v]) => ({ key: k, ...v }));
}

const HOLD_BUCKETS: [number, string][] = [
  [30, "< 30 s"],
  [120, "30 s – 2 min"],
  [300, "2 – 5 min"],
  [900, "5 – 15 min"],
  [3600, "15 – 60 min"],
  [Infinity, "> 1 h"],
];

export function AnalyticsPage() {
  const [mode, setMode] = useState<"paper" | "live">("paper");
  const trades = useApi<TradeRow[]>(mode, `/api/${mode}/trades?limit=1000`, 60_000);
  const learning = useApi<LearningResp>("learning", `/api/learning?mode=${mode}`, 60_000);
  const calib = useApi<Calibration>("learning", "/api/learning/execution-calibration", 60_000);
  const regime = useApi<RegimeHistory>("regime", "/api/regime", 60_000);

  const closed = useMemo(() => (trades.data ?? []).filter((t) => (t.status === "CLOSED" || t.status === "FAILED") && t.net_pnl_sol !== null), [trades.data]);
  const agg = useMemo(() => {
    const gross = closed.reduce((s, t) => s + (t.gross_pnl_sol ?? 0), 0);
    const net = closed.reduce((s, t) => s + (t.net_pnl_sol ?? 0), 0);
    const costs = closed.reduce((s, t) => s + totalCosts(t), 0);
    const cb = {
      "Slippage Einstieg": closed.reduce((s, t) => s + t.entry_slippage_sol, 0),
      "Slippage Ausstieg": closed.reduce((s, t) => s + t.exit_slippage_sol, 0),
      "DEX-Gebühren": closed.reduce((s, t) => s + t.entry_fees_sol + t.exit_fees_sol, 0),
      "Priority Fees": closed.reduce((s, t) => s + t.priority_fees_sol, 0),
      Netzwerkgebühren: closed.reduce((s, t) => s + t.network_fees_sol, 0),
      "MEV / Latenz": closed.reduce((s, t) => s + t.mev_impact_sol, 0),
      "Rent netto": closed.reduce((s, t) => s + t.entry_rent_sol - t.exit_rent_refund_sol, 0),
    };
    const exits = group(closed, (t) => t.exit_reason ?? t.failed_reason ?? "unbekannt").sort((a, b) => b.n - a.n);
    const regimes = group(closed, (t) => t.regime?.label?.replace(/_/g, " ") ?? "unbekannt").sort((a, b) => b.net - a.net);
    const hours = group(closed, (t) => String(new Date(t.decision_ts).getUTCHours()).padStart(2, "0"));
    hours.sort((a, b) => a.key.localeCompare(b.key));
    const holds = group(
      closed.filter((t) => t.opened_at && t.closed_at),
      (t) => {
        const s = (new Date(t.closed_at as string).getTime() - new Date(t.opened_at as string).getTime()) / 1000;
        return (HOLD_BUCKETS.find(([lim]) => s < lim) as [number, string])[1];
      },
    ).sort((a, b) => HOLD_BUCKETS.findIndex(([, l]) => l === a.key) - HOLD_BUCKETS.findIndex(([, l]) => l === b.key));
    return { gross, net, costs, cb, exits, regimes, hours, holds };
  }, [closed]);

  const regimeSeries = useMemo(() => {
    const h = regime.data?.history ?? [];
    return [
      { name: "Volumen 5 min (SOL)", data: h.map((r) => ({ t: new Date(r.ts).getTime(), v: r.metrics.volume_5m ?? 0 })) },
    ];
  }, [regime.data]);
  const breadthSeries = useMemo(() => {
    const h = regime.data?.history ?? [];
    return [
      { name: "Marktbreite", data: h.map((r) => ({ t: new Date(r.ts).getTime(), v: r.metrics.breadth ?? 0 })), kind: "line" as const },
      { name: "Kaufanteil", data: h.map((r) => ({ t: new Date(r.ts).getTime(), v: r.metrics.buy_share_5m ?? 0 })), kind: "line" as const },
    ];
  }, [regime.data]);

  const quality = (learning.data?.quality ?? []).filter((q) => q.mode === mode);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Analytics"
        subtitle="Wo entsteht Ergebnis, wo gehen Kosten verloren?"
        actions={
          <Tabs
            value={mode}
            onChange={setMode}
            tabs={[
              { key: "paper", label: "Paper" },
              { key: "live", label: "Live" },
            ]}
          />
        }
      />
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Kpi label="Trades" value={closed.length} detail="geschlossen + fehlgeschlagen" />
        <Kpi label="Brutto P&L" value={<Pnl value={agg.gross} />} tone={toneOf(agg.gross)} />
        <Kpi label="Kosten gesamt" value={sol(agg.costs, 4)} detail={agg.gross > 0 ? `${pct(agg.costs / agg.gross, 0, false)} des Brutto` : undefined} />
        <Kpi label="Netto P&L" value={<Pnl value={agg.net} />} tone={toneOf(agg.net)} />
        <Kpi label="Trefferquote" value={closed.length ? pct(closed.filter((t) => (t.net_pnl_sol ?? 0) > 0).length / closed.length, 1, false) : "—"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Kostenstruktur" subtitle="SOL, Summe über alle Trades">
          <BarList rows={Object.entries(agg.cb).map(([label, value]) => ({ label, value }))} format={(v) => v.toFixed(5)} />
        </Card>
        <Card title="Ergebnis nach Ausstiegsgrund" subtitle="Netto SOL (Anzahl)">
          <BarList signed rows={agg.exits.map((e) => ({ label: `${e.key} (${e.n})`, value: e.net, hint: `Trefferquote ${pct(e.wins / e.n, 0, false)}` }))} format={(v) => Math.abs(v).toFixed(4)} />
        </Card>
        <Card title="Ergebnis nach Marktregime" subtitle="Netto SOL (Anzahl)">
          <BarList signed rows={agg.regimes.map((e) => ({ label: `${e.key} (${e.n})`, value: e.net, hint: `Trefferquote ${pct(e.wins / e.n, 0, false)}` }))} format={(v) => Math.abs(v).toFixed(4)} />
        </Card>
        <Card title="Ergebnis nach Haltedauer" subtitle="Netto SOL (Anzahl)">
          <BarList signed rows={agg.holds.map((e) => ({ label: `${e.key} (${e.n})`, value: e.net }))} format={(v) => Math.abs(v).toFixed(4)} />
        </Card>
        <Card title="Ergebnis nach Tageszeit (UTC)" subtitle="Netto SOL je Stunde der Entscheidung">
          <BarList signed maxRows={24} rows={agg.hours.map((e) => ({ label: `${e.key}:00 (${e.n})`, value: e.net }))} format={(v) => Math.abs(v).toFixed(4)} />
        </Card>
        <Card title="Entscheidungs- vs. Ergebnisqualität" subtitle="Learning Engine: gute Entscheidungen können verlieren, schlechte gewinnen">
          <Table
            rows={quality}
            rowKey={(q) => `${q.decision_quality}-${q.outcome_quality}`}
            empty="Noch keine Bewertungen"
            columns={[
              { key: "d", header: "Entscheidung", cell: (q) => <span className="text-ink">{q.decision_quality}</span> },
              { key: "o", header: "Ergebnis", cell: (q) => <span className="text-ink-2">{q.outcome_quality}</span> },
              { key: "n", header: "Anzahl", align: "right", cell: (q) => <span className="num">{q.n}</span> },
            ]}
          />
        </Card>
      </div>

      <Card title="Ausführungs-Kalibrierung" subtitle="Tatsächliche Live-Kosten vs. Annahmen der Simulation">
        {calib.data ? (
          <div className="space-y-3">
            {!calib.data.sufficient && <Notice>Erst {calib.data.liveTrades} Live Trades — für eine belastbare Kalibrierung werden mindestens 30 benötigt.</Notice>}
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <div className="mb-1 text-[11px] font-medium text-ink-2">Live (real)</div>
                <KV
                  cols={1}
                  items={[
                    ["Slippage-Anteil", pct(calib.data.live.slippageShare, 2, false)],
                    ["Ø Priority Fee", sol(calib.data.live.priorityFeeSol, 6)],
                    ["Fehlgeschlagene Einstiege", calib.data.live.failedEntries],
                  ]}
                />
              </div>
              <div>
                <div className="mb-1 text-[11px] font-medium text-ink-2">Paper (simuliert)</div>
                <KV
                  cols={1}
                  items={[
                    ["Slippage-Anteil", pct(calib.data.paper.slippageShare, 2, false)],
                    ["Ø Priority Fee", sol(calib.data.paper.priorityFeeSol, 6)],
                  ]}
                />
              </div>
              <div>
                <div className="mb-1 text-[11px] font-medium text-ink-2">Annahmen (Settings → Research)</div>
                <KV
                  cols={1}
                  items={[
                    ["Fehlerrate Tx", pct(calib.data.assumptions.failedTxRate, 1, false)],
                    ["Priority Fee", sol(calib.data.assumptions.assumedPriorityFeeSol, 6)],
                    ["MEV-Aufschlag", `${calib.data.assumptions.mevImpactBps} bps`],
                    ["Verzögerung", `${calib.data.assumptions.executionDelayMs} ms`],
                  ]}
                />
              </div>
            </div>
          </div>
        ) : null}
      </Card>

      {(regime.data?.history.length ?? 0) > 1 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Marktaktivität 24 h" subtitle="Pump.fun-Handelsvolumen je 5 min">
            <TimeSeriesChart series={regimeSeries} height={200} format={(v) => v.toFixed(0)} />
          </Card>
          <Card title="Marktbreite & Kaufdruck 24 h" subtitle="Anteile (0–1)">
            <TimeSeriesChart series={breadthSeries} height={200} format={(v) => v.toFixed(2)} />
          </Card>
        </div>
      )}
    </div>
  );
}
