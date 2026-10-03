import { ArrowLeft, Play, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { describeCondition, type Condition } from "@multbot/shared";
import { useAction, useApi } from "../api/hooks";
import { Badge, Button, Card, ErrorBox, KV, Kpi, Loading, Notice, PageHeader, Pnl, StatusBadge, Table, Tabs, type Column } from "../components/ui";
import { dateTime, duration, pct } from "../lib/format";

interface Overview {
  samples: number;
  labeledSamples: number;
  oldestSample: string | null;
  discoveryRuns: number;
  discoveredFeatures: { name: string; kind: string; description: string | null; enabled: boolean; created_at: string }[];
  latestClusterRun: string | null;
  baselineContexts: number;
  eventTypes: string[];
}

interface OutcomeSummary {
  n: number;
  mean: number;
  median: number;
  winRate: number;
  worst: number;
  best: number;
  p10: number;
  p90: number;
  maxRunupMedian: number;
  maxDrawdownMedian: number;
  timeToPeakMedianSec: number;
}

interface Situation {
  id: number;
  run_at: string;
  cluster_index: number;
  size: number;
  description: { feature: string; z: number; direction: "high" | "low" }[];
  stats: Record<string, OutcomeSummary>;
  period_start: string | null;
  period_end: string | null;
}

interface RunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  dataset: { n?: number; from?: number; to?: number; features?: number; mints?: number };
  hypotheses_tested: number;
  survivors: number;
  summary: { log?: string[]; rejected?: { recipe: string[]; target: string; reason: string }[]; created?: { strategyId: string; versionId: string }[] };
  error: string | null;
}

interface Hypothesis {
  id: number;
  conditions: { target: string; conditions: Condition[] };
  horizon_sec: number;
  n_train: number;
  mean_train: number;
  p_value: number;
  q_value: number | null;
  n_test: number | null;
  mean_test: number | null;
  verdict: string;
  reject_reason: string | null;
  strategy_id: string | null;
}

interface EvolutionRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  examined: number;
  proposed: number;
}

interface ChallengerRow {
  id: string;
  strategy_id: string;
  name: string;
  version: string;
  status: string;
  change_summary: string | null;
  challenger_since: string | null;
  challenger_outcome: string | null;
  challenger_reason: string | null;
  comparison: { challenger: { mean: number; n: number }; incumbent: { mean: number; n: number }; pBetter: number } | null;
}

const HORIZON_LABEL: Record<string, string> = { "60": "1 min", "300": "5 min", "900": "15 min", "1800": "30 min", "3600": "1 h", "14400": "4 h", "86400": "24 h" };

function runStatus(s: string): string {
  return s === "done" ? "CONFIRMED" : s === "failed" ? "FAILED" : s === "running" ? "OPENING" : "DEGRADED";
}

export function ResearchPage() {
  const nav = useNavigate();
  const [horizon, setHorizon] = useState("300");
  const ov = useApi<Overview>("research", "/api/research/overview", 30_000);
  const sit = useApi<Situation[]>("research", "/api/research/situations", 60_000);
  const runs = useApi<RunRow[]>("strategies", "/api/discovery/runs", 20_000);
  const label = useAction("/api/research/label-now", ["research"]);
  const clusters = useAction("/api/research/clusters-now", ["research"]);
  const discover = useAction("/api/discovery/run", ["strategies"]);
  const evolve = useAction("/api/evolution/run", ["strategies"]);
  const evoRuns = useApi<EvolutionRun[]>("strategies", "/api/evolution/runs", 30_000);
  const challengers = useApi<ChallengerRow[]>("strategies", "/api/evolution/challengers", 30_000);
  const o = ov.data;

  const runCols: Column<RunRow>[] = [
    { key: "id", header: "#", cell: (r) => <span className="num text-muted">{r.id}</span> },
    { key: "t", header: "Start", cell: (r) => <span className="num text-ink-2">{dateTime(r.started_at)}</span> },
    { key: "s", header: "Status", cell: (r) => <Badge status={runStatus(r.status)}>{r.status}</Badge> },
    { key: "n", header: "Samples", align: "right", cell: (r) => <span className="num">{r.dataset.n?.toLocaleString("de-DE") ?? "—"}</span> },
    { key: "f", header: "Features", align: "right", cell: (r) => <span className="num">{r.dataset.features ?? "—"}</span> },
    { key: "h", header: "Hypothesen", align: "right", cell: (r) => <span className="num">{r.hypotheses_tested.toLocaleString("de-DE")}</span> },
    { key: "sv", header: "Überlebt", align: "right", cell: (r) => <span className="num text-ink">{r.survivors}</span> },
    { key: "c", header: "Neue Strategien", align: "right", cell: (r) => <span className="num">{r.summary.created?.length ?? 0}</span> },
    { key: "d", header: "Dauer", align: "right", cell: (r) => <span className="num text-muted">{r.finished_at ? duration((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000) : "läuft"}</span> },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Research"
        subtitle="Datengrundlage, historische Situationen und Discovery-Läufe"
        actions={
          <>
            <Button onClick={() => label.mutate(undefined)} loading={label.isPending}>
              <RefreshCw size={13} /> Outcomes labeln
            </Button>
            <Button onClick={() => clusters.mutate(undefined)} loading={clusters.isPending}>
              <RefreshCw size={13} /> Situationen clustern
            </Button>
            <Button onClick={() => evolve.mutate(undefined)} loading={evolve.isPending}>
              <Play size={13} /> Evolution starten
            </Button>
            <Button variant="primary" onClick={() => discover.mutate(undefined)} loading={discover.isPending}>
              <Play size={13} /> Discovery starten
            </Button>
          </>
        }
      />
      {[label.error, clusters.error, discover.error, evolve.error].filter(Boolean).map((e, i) => (
        <ErrorBox key={i} error={e} />
      ))}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
        <Kpi label="Research-Samples" value={o?.samples.toLocaleString("de-DE") ?? "—"} detail={o?.oldestSample ? `seit ${dateTime(o.oldestSample)}` : undefined} />
        <Kpi label="Davon gelabelt" value={o?.labeledSamples.toLocaleString("de-DE") ?? "—"} detail="Outcome über alle Horizonte bekannt" />
        <Kpi label="Discovery-Läufe" value={o?.discoveryRuns ?? "—"} />
        <Kpi label="Kontext-Baselines" value={o?.baselineContexts ?? "—"} detail="Alter × Venue" />
        <Kpi label="Event-Detektoren" value={o?.eventTypes.length ?? "—"} />
        <Kpi label="Entdeckte Features" value={o?.discoveredFeatures.length ?? "—"} />
      </div>

      <Card
        title="Historische Situationen"
        subtitle="k-Means-Cluster ähnlicher Marktsituationen und was danach passierte (Mid-Preis-Rendite, vor Kosten)"
        actions={
          <Tabs
            value={horizon}
            onChange={setHorizon}
            tabs={["60", "300", "900", "3600"].map((h) => ({ key: h, label: HORIZON_LABEL[h] ?? h }))}
          />
        }
        dense
      >
        <Table
          rows={sit.data}
          rowKey={(s) => String(s.id)}
          maxHeight={520}
          empty="Noch keine Cluster (benötigt gelabelte Samples)"
          columns={[
            { key: "i", header: "Cluster", cell: (s) => <span className="num text-muted">{s.cluster_index}</span> },
            { key: "n", header: "Größe", align: "right", cell: (s) => <span className="num">{s.size}</span>, sort: (s) => s.size },
            {
              key: "d",
              header: "Merkmale (Abweichung vom Durchschnitt)",
              cell: (s) => (
                <div className="flex max-w-[460px] flex-wrap gap-1 whitespace-normal">
                  {s.description.slice(0, 5).map((d) => (
                    <Badge key={d.feature}>
                      {d.feature} {d.direction === "high" ? "↑" : "↓"}
                      <span className="num opacity-70">{Math.abs(d.z).toFixed(1)}σ</span>
                    </Badge>
                  ))}
                </div>
              ),
            },
            { key: "m", header: "Median", align: "right", cell: (s) => <Pnl value={s.stats[horizon]?.median ?? null} percent />, sort: (s) => s.stats[horizon]?.median ?? null },
            { key: "a", header: "Ø", align: "right", cell: (s) => <Pnl value={s.stats[horizon]?.mean ?? null} percent />, sort: (s) => s.stats[horizon]?.mean ?? null },
            { key: "w", header: "Anteil positiv", align: "right", cell: (s) => <span className="num">{pct(s.stats[horizon]?.winRate ?? null, 0, false)}</span>, sort: (s) => s.stats[horizon]?.winRate ?? null },
            {
              key: "r",
              header: "P10 / P90",
              align: "right",
              cell: (s) => (
                <span className="num text-ink-2">
                  {pct(s.stats[horizon]?.p10 ?? null, 0)} / {pct(s.stats[horizon]?.p90 ?? null, 0)}
                </span>
              ),
            },
            { key: "ru", header: "Median Max-Runup", align: "right", cell: (s) => <span className="num text-ink-2">{pct(s.stats[horizon]?.maxRunupMedian ?? null, 0)}</span> },
            { key: "dd", header: "Median Max-DD", align: "right", cell: (s) => <span className="num text-ink-2">{pct(s.stats[horizon]?.maxDrawdownMedian ?? null, 0)}</span> },
          ]}
        />
      </Card>

      <Card dense title="Discovery-Läufe" subtitle="Jeder Lauf testet Tausende Hypothesen; nur wenige überleben die Korrektur für multiples Testen und den Holdout">
        <Table rows={runs.data} columns={runCols} rowKey={(r) => String(r.id)} onRowClick={(r) => nav(`/research/runs/${r.id}`)} maxHeight={420} empty="Noch keine Läufe" />
      </Card>

      <Card dense title="Strategie-Evolution" subtitle="Varianten bestehender Strategien: Auswahl auf älteren Daten, Bestätigung auf neueren, dann Backtest und Paper-Vergleich mit der aktuellen Version">
        <Table
          rows={challengers.data}
          rowKey={(c) => c.id}
          maxHeight={360}
          onRowClick={(c) => nav(`/strategy-lab/${c.strategy_id}`)}
          empty="Noch keine Herausforderer-Versionen"
          columns={[
            { key: "v", header: "Version", cell: (c) => <span className="num text-ink">{c.id}</span> },
            { key: "n", header: "Strategie", cell: (c) => <span className="block max-w-[220px] truncate text-ink-2">{c.name}</span> },
            { key: "ch", header: "Änderung", cell: (c) => <span className="block max-w-[380px] truncate text-ink-2" title={c.change_summary ?? ""}>{c.change_summary}</span> },
            {
              key: "st",
              header: "Stand",
              cell: (c) =>
                c.challenger_outcome ? (
                  <Badge status={c.challenger_outcome === "retired" ? "REJECTED" : "PAPER_VALIDATED"}>{c.challenger_outcome}</Badge>
                ) : (
                  <Badge status="TESTING">{c.status === "TESTING" ? "Backtest" : "Paper-Vergleich"}</Badge>
                ),
            },
            {
              key: "cmp",
              header: "Paper neu / aktuell",
              align: "right",
              cell: (c) =>
                c.comparison ? (
                  <span className="num">
                    <Pnl value={c.comparison.challenger.mean} digits={5} /> / <Pnl value={c.comparison.incumbent.mean} digits={5} />{" "}
                    <span className="text-muted">({c.comparison.challenger.n})</span>
                  </span>
                ) : (
                  <span className="text-muted">—</span>
                ),
            },
            { key: "r", header: "Grund", cell: (c) => <span className="block max-w-[260px] truncate text-muted" title={c.challenger_reason ?? ""}>{c.challenger_reason ?? ""}</span> },
          ]}
        />
        <div className="border-t border-line px-4 py-2 text-[11px] text-muted">
          Letzte Läufe:{" "}
          {(evoRuns.data ?? []).slice(0, 5).map((r) => (
            <span key={r.id} className="mr-3">
              #{r.id} {dateTime(r.started_at)} · {r.status} · {r.examined} geprüft · {r.proposed} vorgeschlagen
            </span>
          ))}
          {(evoRuns.data ?? []).length === 0 && "noch keine"}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card dense title="Entdeckte Features" subtitle="Vom System gebildete Kombinationen (Verhältnisse, Differenzen, Produkte)">
          <Table
            rows={o?.discoveredFeatures}
            rowKey={(f) => f.name}
            maxHeight={360}
            empty="Noch keine"
            columns={[
              { key: "n", header: "Name", cell: (f) => <span className="num text-ink">{f.name}</span> },
              { key: "d", header: "Herkunft", cell: (f) => <span className="text-ink-2">{f.description}</span> },
              { key: "t", header: "Seit", cell: (f) => <span className="num text-muted">{dateTime(f.created_at)}</span> },
            ]}
          />
        </Card>
        <Card title="Event-Detektoren" subtitle="Kontextuelle Anomalien werden relativ zu vergleichbaren Tokens bewertet">
          <div className="flex flex-wrap gap-1.5">
            {(o?.eventTypes ?? []).map((t) => (
              <Link key={t} to={`/events?type=${encodeURIComponent(t)}`}>
                <Badge>{t}</Badge>
              </Link>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

export function DiscoveryRunPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const [filter, setFilter] = useState<"survived" | "rejected">("survived");
  const q = useApi<{ run: (RunRow & { config: Record<string, unknown> }) | null; hypotheses: Hypothesis[] }>("strategies", `/api/discovery/runs/${id}`);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const run = q.data?.run;
  if (!run) return <ErrorBox error="Lauf nicht gefunden" />;
  const hyps = (q.data?.hypotheses ?? []).filter((h) => h.verdict === filter);
  return (
    <div className="space-y-4">
      <button onClick={() => nav("/research")} className="inline-flex items-center gap-1 text-[11.5px] text-muted hover:text-ink">
        <ArrowLeft size={13} /> Research
      </button>
      <PageHeader title={`Discovery-Lauf #${run.id}`} subtitle={`${dateTime(run.started_at)} · ${run.status}`} actions={<Badge status={runStatus(run.status)}>{run.status}</Badge>} />
      {run.error && <ErrorBox error={run.error} />}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Kpi label="Samples" value={run.dataset.n?.toLocaleString("de-DE") ?? "—"} detail={run.dataset.from ? `${dateTime(run.dataset.from)} – ${dateTime(run.dataset.to)}` : undefined} />
        <Kpi label="Tokens" value={run.dataset.mints ?? "—"} />
        <Kpi label="Features" value={run.dataset.features ?? "—"} />
        <Kpi label="Getestete Hypothesen" value={run.hypotheses_tested.toLocaleString("de-DE")} />
        <Kpi label="Überlebt" value={run.survivors} />
      </div>
      {(run.summary.created?.length ?? 0) > 0 && (
        <Card title="Erzeugte Strategien">
          <div className="flex flex-wrap gap-2">
            {run.summary.created?.map((c) => (
              <Link key={c.versionId} to={`/strategy-lab/${c.strategyId}`} className="num rounded-md bg-surface-2 px-2 py-1 text-[12px] text-accent hover:bg-surface-3">
                {c.versionId}
              </Link>
            ))}
          </div>
        </Card>
      )}
      <Card
        dense
        title="Hypothesen"
        subtitle="Gespeichert werden die besten Kandidaten je Ziel; alle getesteten zählen für die FDR-Korrektur"
        actions={
          <Tabs
            value={filter}
            onChange={setFilter}
            tabs={[
              { key: "survived", label: "Überlebt" },
              { key: "rejected", label: "Verworfen" },
            ]}
          />
        }
      >
        <Table
          rows={hyps}
          rowKey={(h) => String(h.id)}
          maxHeight={560}
          onRowClick={(h) => h.strategy_id && nav(`/strategy-lab/${h.strategy_id}`)}
          empty="Keine"
          columns={[
            {
              key: "c",
              header: "Rezept",
              cell: (h) => <span className="num block max-w-[420px] whitespace-normal text-[11px] text-ink">{h.conditions.conditions.map((c) => describeCondition(c)).join(" ∧ ")}</span>,
            },
            { key: "t", header: "Ziel", cell: (h) => <span className="num text-ink-2">{h.conditions.target}</span> },
            { key: "n", header: "n Train", align: "right", cell: (h) => <span className="num">{h.n_train}</span> },
            { key: "m", header: "Ø Train", align: "right", cell: (h) => <Pnl value={h.mean_train} percent /> },
            { key: "nt", header: "n Test", align: "right", cell: (h) => <span className="num">{h.n_test ?? "—"}</span> },
            { key: "mt", header: "Ø Test", align: "right", cell: (h) => <Pnl value={h.mean_test} percent /> },
            { key: "p", header: "p", align: "right", cell: (h) => <span className="num text-ink-2">{h.p_value.toPrecision(2)}</span> },
            { key: "q", header: "q", align: "right", cell: (h) => <span className="num text-ink-2">{h.q_value?.toPrecision(2) ?? "—"}</span> },
            { key: "r", header: "Grund", cell: (h) => (h.strategy_id ? <StatusBadge status="DISCOVERED" /> : <span className="text-ink-2">{h.reject_reason ?? ""}</span>) },
          ]}
        />
      </Card>
      {(run.summary.log?.length ?? 0) > 0 && (
        <Card title="Protokoll">
          <pre className="num max-h-80 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-ink-2">{run.summary.log?.join("\n")}</pre>
        </Card>
      )}
      <Card title="Konfiguration">
        <KV cols={2} items={Object.entries(run.config ?? {}).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])} />
      </Card>
      <Notice>Ein Überleben in der Discovery ist erst der Anfang: danach folgen Backtest nach Kosten, Paper Trading und laufende Decay-Überwachung.</Notice>
    </div>
  );
}
