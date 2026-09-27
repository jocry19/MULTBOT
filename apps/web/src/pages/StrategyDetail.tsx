import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { Settings } from "@multbot/shared";
import { api } from "../api/client";
import { useApi } from "../api/hooks";
import type { Evidence, Perf, Rolling, SplitStats } from "../api/types";
import { BarList, PnlBars, TimeSeriesChart } from "../components/charts/charts";
import { Badge, Button, Card, ConfirmPhrase, ErrorBox, KV, Kpi, Loading, Notice, Pnl, StatusBadge, Table, Toggle, toneOf, type Column } from "../components/ui";
import { dateTime, duration, pct, signed, sol } from "../lib/format";

interface StrategyDetail {
  strategy: {
    id: string;
    name: string;
    family: string;
    origin: string;
    status: string;
    status_reason: string | null;
    current_version_id: string | null;
    parent_strategy_id: string | null;
    live_enabled: boolean;
    paper_enabled: boolean;
    discovery_run_id: number | null;
    created_at: string;
  };
  versions: {
    id: string;
    version: string;
    status: string;
    spec: SpecShape;
    change_summary: string | null;
    parent_version_id: string | null;
    created_at: string;
    description: string[];
  }[];
  results: { id: number; strategy_version_id: string; kind: string; computed_at: string; metrics: Record<string, unknown> }[];
  backtests: {
    id: number;
    strategy_version_id: string;
    created_at: string;
    status: string;
    metrics: BacktestMetrics | null;
    equity_curve: { ts: number; equity: number }[] | null;
    cost_breakdown: Record<string, number> | null;
    regime_breakdown: { label: string; n: number; netSol: number; winRate: number }[] | null;
  }[];
  paperCurve: { ts: string; equity: number; net_pnl_sol: number; net_return: number; exit_reason: string }[];
  worstPaperTrades: { id: string; mint: string; closed_at: string; net_pnl_sol: number; net_return: number; exit_reason: string; regime: { label?: string } | null }[];
  learning: { key: string; value: Record<string, unknown>; updated_at: string }[];
  history: { id: number; from_status: string | null; to_status: string; reason: string | null; actor: string; ts: string; version_id: string | null }[];
}

interface SpecShape {
  family: string;
  universe: { venues: string[]; minAgeSec?: number; maxAgeSec?: number };
  entry: { cooldownSec: number; maxSlippageBps?: number };
  exit: { takeProfitPct?: number; stopLossPct?: number; trailingStopPct?: number; maxHoldSec: number; invalidation: unknown[]; expectedValueExit: boolean };
  horizonSec: number;
  params: Record<string, unknown>;
}

export interface BacktestMetrics {
  stats: Perf;
  returnStats?: Perf;
  failedEntries: number;
  skipped: Record<string, number> | number;
  exitReasons: Record<string, number>;
  avgOpenPositions?: number;
  grossPnlSol: number;
  netPnlSol: number;
  passed: boolean;
  reason: string;
}

const COST_LABELS: Record<string, string> = {
  entrySlippageSol: "Slippage Einstieg",
  exitSlippageSol: "Slippage Ausstieg",
  entryFeesSol: "Gebühren Einstieg",
  exitFeesSol: "Gebühren Ausstieg",
  priorityFeesSol: "Priority Fees",
  networkFeesSol: "Netzwerkgebühren",
  mevImpactSol: "MEV / Latenz",
  rentSol: "Rent (Token-Konto)",
  rentRefundSol: "Rent-Rückerstattung (−)",
};

/** Cost bars without the total (shown separately). */
export function costRows(c: Record<string, number> | null | undefined): { label: string; value: number }[] {
  return Object.entries(c ?? {})
    .filter(([k]) => k !== "totalSol")
    .map(([k, v]) => ({ label: COST_LABELS[k] ?? k, value: v }));
}

export function StrategyDetailPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useApi<StrategyDetail>("strategies", `/api/strategies/${id}`, 20_000);
  const settings = useApi<Settings>("settings", "/api/settings");
  const [confirmLive, setConfirmLive] = useState(false);
  const [actionErr, setActionErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const d = q.data;
  const current = d?.versions.find((v) => v.id === d.strategy.current_version_id) ?? d?.versions[0];
  const evidence = useMemo(() => {
    const r = d?.results.find((x) => x.kind === "discovery" && x.strategy_version_id === current?.id) ?? d?.results.find((x) => x.kind === "discovery");
    return (r?.metrics as unknown as Evidence | undefined) ?? null;
  }, [d, current]);
  const paper = useMemo(() => {
    const r = d?.results.find((x) => x.kind === "paper" && x.strategy_version_id === current?.id);
    return (r?.metrics as { stats?: Perf; rolling?: Rolling | null; confidence?: number } | undefined) ?? null;
  }, [d, current]);
  const bt = d?.backtests.find((b) => b.status === "done");
  const paperSeries = useMemo(() => (d ? [{ name: "Paper netto (kumuliert)", data: d.paperCurve.map((p) => ({ t: new Date(p.ts).getTime(), v: p.equity })) }] : []), [d]);
  const paperBars = useMemo(() => (d ? d.paperCurve.map((p) => ({ t: new Date(p.ts).getTime(), v: p.net_pnl_sol })) : []), [d]);
  const btSeries = useMemo(() => (bt?.equity_curve ? [{ name: "Backtest netto (kumuliert)", data: bt.equity_curve.map((p) => ({ t: p.ts, v: p.equity })) }] : []), [bt]);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (!d || !current) return <ErrorBox error="Strategie nicht gefunden" />;
  const s = d.strategy;

  const act = async (name: string, path: string, body?: unknown) => {
    setBusy(name);
    setActionErr(null);
    try {
      await api.post(path, body);
      await qc.invalidateQueries({ queryKey: ["strategies"] });
    } catch (e) {
      setActionErr(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <button onClick={() => nav("/strategy-lab")} className="mb-2 inline-flex items-center gap-1 text-[11.5px] text-muted hover:text-ink">
          <ArrowLeft size={13} /> Strategy Lab
        </button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="num text-[12px] text-muted">{s.id}</span>
              <StatusBadge status={s.status} />
              <Badge>v{current.version}</Badge>
              <Badge>{s.origin}</Badge>
              {s.parent_strategy_id && (
                <Link to={`/strategy-lab/${s.parent_strategy_id}`} className="text-[11px] text-accent hover:underline">
                  abgeleitet von {s.parent_strategy_id}
                </Link>
              )}
            </div>
            <h1 className="mt-1 text-[18px] font-semibold tracking-tight">{s.name}</h1>
            {s.status_reason && <p className="mt-0.5 text-[12px] text-ink-2">Status-Grund: {s.status_reason}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Toggle checked={s.paper_enabled} onChange={(v) => act("paper", `/api/strategies/${s.id}/paper`, { enabled: v })} label="Paper Trading" />
            <Button onClick={() => act("bt", `/api/strategies/${s.id}/backtest`)} loading={busy === "bt"}>
              Backtest
            </Button>
            <Button onClick={() => act("retest", `/api/strategies/${s.id}/retest`)} loading={busy === "retest"} disabled={s.status === "TESTING"}>
              Neu testen
            </Button>
            {s.status === "PAUSED" ? (
              <Button onClick={() => act("resume", `/api/strategies/${s.id}/resume`)} loading={busy === "resume"}>
                Fortsetzen
              </Button>
            ) : (
              <Button onClick={() => act("pause", `/api/strategies/${s.id}/pause`)} loading={busy === "pause"} disabled={s.status === "REJECTED"}>
                Pausieren
              </Button>
            )}
            <Button variant="ghost" onClick={() => act("disable", `/api/strategies/${s.id}/disable`)} loading={busy === "disable"} disabled={s.status === "REJECTED"}>
              Deaktivieren
            </Button>
            {s.status === "LIVE_ENABLED" ? (
              <Button variant="danger" onClick={() => act("dlive", `/api/strategies/${s.id}/disable-live`)} loading={busy === "dlive"}>
                Echtgeld deaktivieren
              </Button>
            ) : (
              <Button
                variant="success"
                disabled={s.status !== "PAPER_VALIDATED"}
                title={s.status !== "PAPER_VALIDATED" ? "Nur für PAPER_VALIDATED-Strategien möglich" : undefined}
                onClick={() => setConfirmLive(true)}
              >
                ENABLE REAL TRADING
              </Button>
            )}
          </div>
        </div>
      </div>
      {actionErr !== null && <ErrorBox error={actionErr} />}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0 space-y-4">
          <EvidenceCard evidence={evidence} />
          <Card title="Backtest" subtitle={bt ? `#${bt.id} · ${dateTime(bt.created_at)} · kausal, nur Daten, die zum Zeitpunkt verfügbar waren` : "noch kein abgeschlossener Backtest"}>
            {bt?.metrics ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge status={bt.metrics.passed ? "PAPER_VALIDATED" : "REJECTED"}>{bt.metrics.passed ? "bestanden" : "nicht bestanden"}</Badge>
                  <span className="text-[11.5px] text-muted">{bt.metrics.reason}</span>
                  <Link to={`/backtests/${bt.id}`} className="ml-auto text-[11px] text-accent hover:underline">
                    alle Trades →
                  </Link>
                </div>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <Kpi label="Netto P&L" value={<Pnl value={bt.metrics.netPnlSol} />} tone={toneOf(bt.metrics.netPnlSol)} detail={`Brutto ${signed(bt.metrics.grossPnlSol, 4, " SOL")}`} />
                  <Kpi label="Trades" value={bt.metrics.stats.n} detail={`${bt.metrics.failedEntries} fehlgeschlagene Einstiege`} />
                  <Kpi label="Trefferquote" value={pct(bt.metrics.stats.winRate, 1, false)} detail={`PF ${bt.metrics.stats.profitFactor?.toFixed(2) ?? "—"}`} />
                  <Kpi label="Max Drawdown" value={sol(bt.metrics.stats.maxDrawdown, 4)} detail={`Worst ${signed(bt.metrics.stats.worst, 4)}`} />
                </div>
                {btSeries[0] && btSeries[0].data.length > 1 && <TimeSeriesChart series={btSeries} height={200} zeroLine format={(v) => v.toFixed(4)} />}
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <div className="mb-2 text-[11px] text-muted">Kosten (SOL, Summe {bt.cost_breakdown?.totalSol?.toFixed(4) ?? "—"})</div>
                    <BarList rows={costRows(bt.cost_breakdown)} format={(v) => v.toFixed(5)} />
                  </div>
                  <div>
                    <div className="mb-2 text-[11px] text-muted">Ausstiegsgründe</div>
                    <BarList rows={Object.entries(bt.metrics.exitReasons ?? {}).map(([k, v]) => ({ label: k, value: v }))} format={(v) => v.toFixed(0)} />
                  </div>
                </div>
                {bt.regime_breakdown && bt.regime_breakdown.length > 0 && (
                  <div>
                    <div className="mb-2 text-[11px] text-muted">Netto-Ergebnis nach Marktregime (SOL)</div>
                    <BarList signed rows={bt.regime_breakdown.map((r) => ({ label: `${r.label.replace(/_/g, " ")} (${r.n})`, value: r.netSol, hint: `Trefferquote ${pct(r.winRate, 0, false)}` }))} format={(v) => Math.abs(v).toFixed(4)} />
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[12px] text-muted">{d.backtests[0]?.status === "running" ? "Backtest läuft…" : "Noch kein Backtest vorhanden."}</div>
            )}
          </Card>

          <Card title="Paper Trading" subtitle="Echte Live-Marktdaten, simulierte Ausführung mit realistischen Kosten — getrennt von Echtgeld">
            {d.paperCurve.length === 0 ? (
              <div className="text-[12px] text-muted">Noch keine abgeschlossenen Paper Trades.</div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <Kpi label="Netto P&L" value={<Pnl value={paper?.stats?.sum ?? null} />} tone={toneOf(paper?.stats?.sum)} detail={`${paper?.stats?.n ?? d.paperCurve.length} Trades`} />
                  <Kpi label="Erwartungswert / Trade" value={<Pnl value={paper?.stats?.mean ?? null} digits={5} />} tone={toneOf(paper?.stats?.mean)} detail={`Median ${signed(paper?.stats?.median ?? null, 5)}`} />
                  <Kpi label="Trefferquote" value={pct(paper?.stats?.winRate ?? null, 1, false)} detail={`PF ${paper?.stats?.profitFactor?.toFixed(2) ?? "—"}`} />
                  <Kpi label="Konfidenz E>0" value={paper?.confidence !== undefined ? pct(paper.confidence, 1, false) : "—"} detail={`Max DD ${sol(paper?.stats?.maxDrawdown ?? null, 4)}`} />
                </div>
                <TimeSeriesChart series={paperSeries} height={200} zeroLine format={(v) => v.toFixed(4)} />
                <div>
                  <div className="mb-1 text-[11px] text-muted">Netto-Ergebnis je Trade (SOL)</div>
                  <PnlBars points={paperBars} height={120} />
                </div>
                {paper?.rolling && <RollingBlock rolling={paper.rolling} />}
              </div>
            )}
          </Card>

          <Card dense title="Schlechteste Paper Trades" subtitle="Worst Case zuerst — zum Verstehen der Verlustseite">
            <Table
              rows={d.worstPaperTrades}
              rowKey={(t) => t.id}
              onRowClick={(t) => nav(`/trades/paper/${t.id}`)}
              empty="Keine"
              columns={[
                { key: "ts", header: "Geschlossen", cell: (t) => <span className="num text-ink-2">{dateTime(t.closed_at)}</span> },
                { key: "mint", header: "Token", cell: (t) => <span className="num">{t.mint.slice(0, 8)}…</span> },
                { key: "net", header: "Netto", align: "right", cell: (t) => <Pnl value={t.net_pnl_sol} digits={5} /> },
                { key: "ret", header: "Rendite", align: "right", cell: (t) => <Pnl value={t.net_return} percent /> },
                { key: "exit", header: "Ausstieg", cell: (t) => <span className="text-ink-2">{t.exit_reason}</span> },
                { key: "reg", header: "Regime", cell: (t) => <span className="text-muted">{t.regime?.label?.replace(/_/g, " ") ?? "—"}</span> },
              ]}
            />
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card title="Rezept" subtitle={`Version ${current.version} · Horizont ${duration(current.spec.horizonSec)}`}>
            <ol className="space-y-1.5">
              {current.description.map((c, i) => (
                <li key={i} className="num rounded-md bg-surface-2 px-2.5 py-1.5 text-[11.5px] text-ink">
                  {c}
                </li>
              ))}
              {current.description.length === 0 && <li className="text-[12px] text-muted">Keine Einstiegsbedingungen</li>}
            </ol>
            <div className="mt-4">
              <KV
                cols={1}
                items={[
                  ["Venues", current.spec.universe.venues.join(", ")],
                  ["Token-Alter", `${duration(current.spec.universe.minAgeSec ?? 0)} – ${current.spec.universe.maxAgeSec ? duration(current.spec.universe.maxAgeSec) : "∞"}`],
                  ["Take Profit", current.spec.exit.takeProfitPct !== undefined ? pct(current.spec.exit.takeProfitPct, 0) : "—"],
                  ["Stop Loss", current.spec.exit.stopLossPct !== undefined ? pct(-current.spec.exit.stopLossPct, 0) : "—"],
                  ["Trailing Stop", current.spec.exit.trailingStopPct !== undefined ? pct(current.spec.exit.trailingStopPct, 0, false) : "—"],
                  ["Max. Haltedauer", duration(current.spec.exit.maxHoldSec)],
                  ["Invalidierungs-Exits", current.spec.exit.invalidation.length],
                  ["Cooldown je Token", duration(current.spec.entry.cooldownSec)],
                  ["Max. Slippage", current.spec.entry.maxSlippageBps ? `${current.spec.entry.maxSlippageBps / 100}%` : "global"],
                ]}
              />
            </div>
          </Card>

          <Card title="Warum könnte diese Strategie NICHT funktionieren?" subtitle="Anti-Blindness-Report">
            {evidence?.whyItMightFail?.length ? (
              <ul className="space-y-2">
                {evidence.whyItMightFail.map((w, i) => (
                  <li key={i} className="flex gap-2 text-[12px] text-ink-2">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warn" />
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-[12px] text-muted">Kein Report (manuelle Strategie oder noch nicht bewertet).</div>
            )}
          </Card>

          <Card dense title="Versionen" subtitle="Strategie-Evolution">
            <Table
              rows={d.versions}
              rowKey={(v) => v.id}
              empty="—"
              columns={[
                { key: "v", header: "Version", cell: (v) => <span className="num">{v.version}</span> },
                { key: "c", header: "Änderung", cell: (v) => <span className="block max-w-[180px] truncate text-ink-2" title={v.change_summary ?? ""}>{v.change_summary ?? "—"}</span> },
                { key: "t", header: "Erstellt", cell: (v) => <span className="num text-muted">{dateTime(v.created_at)}</span> },
                {
                  key: "a",
                  header: "",
                  align: "right",
                  cell: (v) =>
                    v.id === s.current_version_id ? (
                      <Badge status="ACTIVE">aktiv</Badge>
                    ) : (
                      <Button size="xs" onClick={() => act(`v-${v.id}`, `/api/strategies/${s.id}/versions/${encodeURIComponent(v.id)}/activate`)} loading={busy === `v-${v.id}`}>
                        aktivieren
                      </Button>
                    ),
                },
              ]}
            />
          </Card>

          <Card dense title="Status-Verlauf">
            <ol className="max-h-80 space-y-0 overflow-auto px-4 py-2">
              {d.history.map((h) => (
                <li key={h.id} className="border-b border-line/50 py-1.5 text-[11.5px] last:border-0">
                  <div className="flex items-center gap-1.5">
                    {h.from_status && <StatusBadge status={h.from_status} />}
                    <span className="text-muted">→</span>
                    <StatusBadge status={h.to_status} />
                    <span className="ml-auto num text-[10.5px] text-muted">{dateTime(h.ts)}</span>
                  </div>
                  <div className="mt-0.5 text-ink-2">
                    {h.reason ?? "—"} <span className="text-muted">({h.actor})</span>
                  </div>
                </li>
              ))}
            </ol>
          </Card>

          {d.learning.length > 0 && (
            <Card title="Learning Engine" subtitle="Abgleich Erwartung vs. Ergebnis">
              <div className="space-y-3">
                {d.learning.map((l) => (
                  <div key={l.key}>
                    <div className="mb-1 text-[11px] text-muted">{l.key.split(":").slice(2).join(":") || l.key}</div>
                    <KV cols={1} items={Object.entries(l.value).slice(0, 10).map(([k, v]) => [k, typeof v === "number" ? Number(v.toPrecision(4)) : typeof v === "object" ? JSON.stringify(v).slice(0, 60) : String(v)])} />
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>

      <ConfirmPhrase
        open={confirmLive}
        onClose={() => setConfirmLive(false)}
        title="ENABLE REAL TRADING"
        phrase="ENABLE REAL TRADING"
        danger
        description={
          <div className="space-y-3">
            <p>
              Strategie <b className="text-ink">{s.id}</b> wird für <b className="text-ink">Echtgeld</b> freigegeben. Der Bot kann danach selbständig Trades mit der
              Bot-Wallet eröffnen und schließen.
            </p>
            <Notice tone="warn">
              Vergangene Ergebnisse (Backtest, Paper) garantieren keine zukünftigen Gewinne. Memecoins können in Sekunden wertlos werden; Totalverlust der
              eingesetzten Beträge ist möglich.
            </Notice>
            <KV
              cols={1}
              items={[
                ["Positionsgröße", sol(settings.data?.trading.positionSizeSol ?? null, 4)],
                ["Max. offene Positionen", settings.data?.trading.maxOpenPositions ?? "—"],
                ["Max. Tagesverlust", sol(settings.data?.risk.maxDailyLossSol ?? null, 4)],
                ["Wallet-Reserve", sol(settings.data?.risk.minWalletReserveSol ?? null, 4)],
                ["Paper Trades dieser Strategie", paper?.stats?.n ?? d.paperCurve.length],
              ]}
            />
          </div>
        }
        onConfirm={async () => {
          await api.post(`/api/strategies/${s.id}/enable-live`, { confirm: "ENABLE REAL TRADING" });
          await qc.invalidateQueries();
        }}
      />
    </div>
  );
}

function SplitTable({ evidence }: { evidence: Evidence }) {
  const rows: { name: string; s: SplitStats }[] = [{ name: "Training", s: evidence.train }];
  if (evidence.validation) rows.push({ name: "Validierung", s: evidence.validation });
  if (evidence.holdout) rows.push({ name: "Holdout", s: evidence.holdout });
  const columns: Column<{ name: string; s: SplitStats }>[] = [
    { key: "n", header: "Abschnitt", cell: (r) => <span className="text-ink">{r.name}</span> },
    { key: "c", header: "Trades", align: "right", cell: (r) => <span className="num">{r.s.n}</span> },
    { key: "pn", header: "Positiv / Negativ", align: "right", cell: (r) => <span className="num text-ink-2">{Math.round(r.s.n * r.s.winRate)} / {r.s.n - Math.round(r.s.n * r.s.winRate)}</span> },
    { key: "w", header: "Trefferquote", align: "right", cell: (r) => <span className="num">{pct(r.s.winRate, 1, false)}</span> },
    { key: "med", header: "Median netto", align: "right", cell: (r) => <Pnl value={r.s.median} percent /> },
    { key: "avg", header: "Ø netto", align: "right", cell: (r) => <Pnl value={r.s.mean} percent /> },
    { key: "wo", header: "Worst", align: "right", cell: (r) => <Pnl value={r.s.worst} percent /> },
    { key: "dd", header: "Max DD", align: "right", cell: (r) => <span className="num text-ink-2">{pct(r.s.maxDrawdown, 0, false)}</span> },
    { key: "pf", header: "PF", align: "right", cell: (r) => <span className="num">{Number.isFinite(r.s.profitFactor) ? r.s.profitFactor.toFixed(2) : "∞"}</span> },
    { key: "p", header: "p-Wert", align: "right", cell: (r) => <span className="num text-ink-2">{r.s.pValue.toPrecision(2)}</span> },
  ];
  return <Table rows={rows} columns={columns} rowKey={(r) => r.name} />;
}

function EvidenceCard({ evidence }: { evidence: Evidence | null }) {
  if (!evidence) {
    return (
      <Card title="Belege aus der Discovery">
        <div className="text-[12px] text-muted">Keine Discovery-Belege (manuell angelegt). Bewertung erfolgt über Backtest und Paper Trading.</div>
      </Card>
    );
  }
  const oos = evidence.holdout ?? evidence.validation ?? evidence.train;
  const e = evidence;
  return (
    <Card title="Belege aus der Discovery" subtitle={`Lauf #${e.runId} · Ziel ${e.target} · Stichprobe ${dateTime(e.samplePeriod.from)} – ${dateTime(e.samplePeriod.to)}`}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
          <Kpi label="Vorkommen" value={e.occurrences} />
          <Kpi label="Positiv" value={Math.round(oos.n * oos.winRate)} detail="Out-of-Sample" />
          <Kpi label="Negativ" value={oos.n - Math.round(oos.n * oos.winRate)} detail="Out-of-Sample" />
          <Kpi label="Trefferquote" value={pct(oos.winRate, 1, false)} />
          <Kpi label="Median netto" value={<Pnl value={oos.median} percent />} tone={toneOf(oos.median)} />
          <Kpi label="Ø netto" value={<Pnl value={oos.mean} percent />} tone={toneOf(oos.mean)} detail={`Basis ${pct(e.baselineMean)}`} />
          <Kpi label="Worst Case" value={<Pnl value={oos.worst} percent />} tone="bad" />
          <Kpi label="Max Drawdown" value={pct(oos.maxDrawdown, 0, false)} detail="kumuliert, Rendite" />
        </div>
        <SplitTable evidence={e} />
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="mb-2 text-[11px] font-medium text-ink-2">Statistische Absicherung</div>
            <KV
              cols={1}
              items={[
                ["Getestete Hypothesen", e.multipleTesting.hypothesesTested.toLocaleString("de-DE")],
                ["p-Wert (roh)", e.multipleTesting.pValue.toPrecision(2)],
                ["q-Wert (Benjamini–Hochberg)", `${e.multipleTesting.qValue.toPrecision(2)} (α=${e.multipleTesting.fdrAlpha})`],
                ["Deflated Sharpe", pct(e.overfit.dsr, 1, false)],
                ["Sharpe Training → OOS", `${e.overfit.sharpeTrain.toFixed(3)} → ${e.overfit.sharpeOos?.toFixed(3) ?? "—"}`],
                ["OOS-Retention", e.overfit.oosRetention !== null ? pct(e.overfit.oosRetention, 0, false) : "—"],
                ["Kostenanteil am Brutto-Edge", e.costShare !== null ? pct(e.costShare, 0, false) : "—"],
              ]}
            />
          </div>
          <div className="space-y-4">
            {e.walkForward && (
              <div>
                <div className="mb-2 text-[11px] font-medium text-ink-2">
                  Walk-Forward ({pct(e.walkForward.positiveShare, 0, false)} der Folds positiv)
                </div>
                <BarList signed rows={e.walkForward.folds.map((f, i) => ({ label: `Fold ${i + 1} (n=${f.n})`, value: f.mean * 100, hint: `Trefferquote ${pct(f.winRate, 0, false)}` }))} format={(v) => `${Math.abs(v).toFixed(1)}%`} />
              </div>
            )}
            {e.regimes.length > 0 && (
              <div>
                <div className="mb-2 text-[11px] font-medium text-ink-2">Nach Marktregime (Ø netto)</div>
                <BarList signed rows={e.regimes.map((r) => ({ label: `${r.label.replace(/_/g, " ")} (${r.n})`, value: r.mean * 100, hint: `Trefferquote ${pct(r.winRate, 0, false)}` }))} format={(v) => `${Math.abs(v).toFixed(1)}%`} />
              </div>
            )}
          </div>
        </div>
        {e.nearMisses.length > 0 && (
          <Section title="Robustheit: ohne einzelne Bedingung">
            <Table
              rows={e.nearMisses}
              rowKey={(r) => r.dropped}
              columns={[
                { key: "d", header: "Weggelassen", cell: (r) => <span className="num text-ink-2">{r.dropped}</span> },
                { key: "n", header: "Trades", align: "right", cell: (r) => <span className="num">{r.n}</span> },
                { key: "m", header: "Ø netto", align: "right", cell: (r) => <Pnl value={r.mean} percent /> },
                { key: "dl", header: "Δ zur Strategie", align: "right", cell: (r) => <Pnl value={r.delta} percent /> },
              ]}
            />
          </Section>
        )}
        {e.worstTrades.length > 0 && (
          <Section title="Schlechteste historische Fälle">
            <div className="flex flex-wrap gap-1.5">
              {e.worstTrades.map((w, i) => (
                <Link key={i} to={`/token/${w.mint}`} className="rounded-md bg-surface-2 px-2 py-1 text-[11px] hover:bg-surface-3">
                  <span className="num text-muted">{dateTime(w.ts)}</span> <Pnl value={w.ret} percent />
                </Link>
              ))}
            </div>
          </Section>
        )}
      </div>
    </Card>
  );
}

function RollingBlock({ rolling }: { rolling: Rolling }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <div className="mb-2 text-[11px] font-medium text-ink-2">Letzte {rolling.window} Trades (Decay-Monitor)</div>
        <KV
          cols={1}
          items={[
            ["Erwartungswert", <Pnl key="e" value={rolling.expectancy} digits={5} />],
            ["Trefferquote", pct(rolling.winRate, 1, false)],
            ["Profit Factor", Number.isFinite(rolling.profitFactor) ? rolling.profitFactor.toFixed(2) : "∞"],
            ["Max Drawdown", sol(rolling.maxDrawdown, 4)],
            ["Decay-Test p", rolling.decayPValue !== null ? rolling.decayPValue.toPrecision(2) : "—"],
          ]}
        />
      </div>
      <div>
        <div className="mb-2 text-[11px] font-medium text-ink-2">Feature-Drift (PSI, &gt;0,25 = deutlich)</div>
        {rolling.featureShift.length > 0 ? <BarList rows={rolling.featureShift.map((f) => ({ label: f.feature, value: f.psi }))} format={(v) => v.toFixed(2)} /> : <div className="text-[12px] text-muted">Keine Drift gemessen</div>}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-[11px] font-medium text-ink-2">{title}</div>
      {children}
    </div>
  );
}
