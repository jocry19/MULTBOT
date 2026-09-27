import { Play, Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api/client";
import { useAction, useApi } from "../api/hooks";
import type { SplitStats, StrategyRow } from "../api/types";
import { Badge, Button, Card, ErrorBox, Modal, Notice, PageHeader, Pnl, StatusBadge, Table, Tabs, type Column } from "../components/ui";
import { dateTime, pct } from "../lib/format";
import { useQueryClient } from "@tanstack/react-query";

type Filter = "active" | "testing" | "all" | "rejected";
const ACTIVE = ["PAPER_TRADING", "PAPER_VALIDATED", "LIVE_ENABLED", "DEGRADED", "PAUSED"];
const TESTING = ["DISCOVERED", "TESTING"];

/** Best available out-of-sample split for display (holdout > validation > train). */
export function oosSplit(s: StrategyRow): { split: SplitStats | null; label: string } {
  const d = s.discovery;
  if (!d) return { split: null, label: "—" };
  if (d.holdout) return { split: d.holdout, label: "Holdout" };
  if (d.validation) return { split: d.validation, label: "Validierung" };
  return { split: d.train, label: "Training" };
}

export function StrategyLabPage() {
  const nav = useNavigate();
  const [filter, setFilter] = useState<Filter>("active");
  const [creating, setCreating] = useState(false);
  const q = useApi<StrategyRow[]>("strategies", "/api/strategies", 15_000);
  const runDiscovery = useAction("/api/discovery/run", ["strategies"]);
  const rows = (q.data ?? []).filter((s) =>
    filter === "all" ? true : filter === "active" ? ACTIVE.includes(s.status) : filter === "testing" ? TESTING.includes(s.status) : s.status === "REJECTED",
  );
  const counts = {
    active: (q.data ?? []).filter((s) => ACTIVE.includes(s.status)).length,
    testing: (q.data ?? []).filter((s) => TESTING.includes(s.status)).length,
    rejected: (q.data ?? []).filter((s) => s.status === "REJECTED").length,
    all: q.data?.length ?? 0,
  };

  const columns: Column<StrategyRow>[] = [
    {
      key: "id",
      header: "Strategie",
      cell: (s) => (
        <div className="max-w-[360px] whitespace-normal">
          <div className="flex items-center gap-2">
            <span className="num text-[11px] text-muted">{s.id}</span>
            <span className="num text-[11px] text-muted">v{s.version ?? "—"}</span>
            {s.origin !== "discovered" && <Badge>{s.origin}</Badge>}
          </div>
          <div className="text-[12px] text-ink">{s.name}</div>
          <div className="mt-0.5 text-[10.5px] leading-snug text-muted">{s.description.join(" · ")}</div>
        </div>
      ),
    },
    { key: "status", header: "Status", cell: (s) => <StatusBadge status={s.status} />, sort: (s) => s.status },
    { key: "occ", header: "Vorkommen", align: "right", cell: (s) => <span className="num">{s.discovery?.occurrences ?? "—"}</span>, sort: (s) => s.discovery?.occurrences ?? null },
    {
      key: "wr",
      header: "Trefferquote OOS",
      align: "right",
      cell: (s) => {
        const o = oosSplit(s);
        return o.split ? (
          <span className="num" title={o.label}>
            {pct(o.split.winRate, 0, false)} <span className="text-muted">n={o.split.n}</span>
          </span>
        ) : (
          "—"
        );
      },
      sort: (s) => oosSplit(s).split?.winRate ?? null,
    },
    { key: "med", header: "Median netto", align: "right", cell: (s) => <Pnl value={oosSplit(s).split?.median ?? null} percent />, sort: (s) => oosSplit(s).split?.median ?? null },
    { key: "avg", header: "Ø netto", align: "right", cell: (s) => <Pnl value={oosSplit(s).split?.mean ?? null} percent />, sort: (s) => oosSplit(s).split?.mean ?? null },
    { key: "worst", header: "Worst Case", align: "right", cell: (s) => <Pnl value={oosSplit(s).split?.worst ?? null} percent />, sort: (s) => oosSplit(s).split?.worst ?? null },
    { key: "q", header: "q-Wert", align: "right", cell: (s) => <span className="num text-ink-2">{s.discovery ? s.discovery.multipleTesting.qValue.toPrecision(2) : "—"}</span>, sort: (s) => s.discovery?.multipleTesting.qValue ?? null },
    {
      key: "bt",
      header: "Backtest netto",
      align: "right",
      cell: (s) =>
        s.backtest?.stats ? (
          <span title={s.backtest.reason}>
            <Pnl value={s.backtest.netPnlSol ?? s.backtest.stats.sum} digits={4} /> <span className="text-muted">({s.backtest.stats.n})</span>
          </span>
        ) : (
          <span className="text-muted">—</span>
        ),
      sort: (s) => s.backtest?.netPnlSol ?? null,
    },
    { key: "pt", header: "Paper Trades", align: "right", cell: (s) => <span className="num">{s.paper_trades}</span>, sort: (s) => s.paper_trades },
    { key: "pe", header: "Paper Ø / Trade", align: "right", cell: (s) => <Pnl value={s.paper?.stats?.mean ?? null} digits={5} />, sort: (s) => s.paper?.stats?.mean ?? null },
    { key: "live", header: "Live", align: "right", cell: (s) => (s.live_trades > 0 ? <Pnl value={s.live_net_sol} digits={4} /> : <span className="text-muted">—</span>), sort: (s) => s.live_net_sol },
    {
      key: "period",
      header: "Stichprobe",
      align: "right",
      cell: (s) => (s.discovery ? <span className="num text-[10.5px] text-muted">{`${dateTime(s.discovery.samplePeriod.from)} – ${dateTime(s.discovery.samplePeriod.to)}`}</span> : "—"),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Strategy Lab"
        subtitle="Von der Discovery-Engine gefundene Rezepte — mit Belegen, Out-of-Sample-Tests und Lebenszyklus"
        actions={
          <>
            <Button onClick={() => setCreating(true)}>
              <Plus size={13} /> Manuelle Strategie
            </Button>
            <Button variant="primary" onClick={() => runDiscovery.mutate(undefined)} loading={runDiscovery.isPending}>
              <Play size={13} /> Discovery jetzt starten
            </Button>
          </>
        }
      />
      {runDiscovery.isSuccess && <Notice>Discovery-Lauf gestartet. Ergebnisse erscheinen unter Research → Discovery-Läufe.</Notice>}
      {runDiscovery.error && <ErrorBox error={runDiscovery.error} />}
      <Notice>
        Keine Strategie ist garantiert profitabel. Alle Kennzahlen sind <b>netto</b> (Gebühren, Slippage, Priority Fees, Rent, Fehlschläge) und stammen aus Daten, die
        beim Finden der Regel nicht verwendet wurden (Holdout). Echtgeld wird nie automatisch aktiviert.
      </Notice>
      <Card
        dense
        actions={
          <Tabs<Filter>
            value={filter}
            onChange={setFilter}
            tabs={[
              { key: "active", label: `Aktiv (${counts.active})` },
              { key: "testing", label: `Im Test (${counts.testing})` },
              { key: "rejected", label: `Verworfen (${counts.rejected})` },
              { key: "all", label: `Alle (${counts.all})` },
            ]}
          />
        }
        title="Strategien"
      >
        <Table
          rows={q.data ? rows : undefined}
          columns={columns}
          rowKey={(s) => s.id}
          onRowClick={(s) => nav(`/strategy-lab/${s.id}`)}
          maxHeight={780}
          empty="Keine Strategien in dieser Ansicht. Die Discovery-Engine braucht genügend gelabelte Research-Samples (siehe Research)."
        />
      </Card>
      <CreateStrategyModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

const TEMPLATE = {
  family: "manual",
  universe: { venues: ["pump_curve"], minAgeSec: 30, maxAgeSec: 3600 },
  conditions: [{ kind: "feature", feature: "buy_ratio_5m", op: "gt", value: 0.7 }],
  entry: { cooldownSec: 600, maxSlippageBps: 1500 },
  exit: { takeProfitPct: 0.3, stopLossPct: 0.2, maxHoldSec: 600, invalidation: [], expectedValueExit: false },
  horizonSec: 600,
  params: {},
};

function CreateStrategyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("Manuelle Hypothese");
  const [spec, setSpec] = useState(JSON.stringify(TEMPLATE, null, 2));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title="Manuelle Strategie definieren" width={640}>
      <div className="space-y-3 text-[12px]">
        <p className="text-ink-2">
          Eine manuelle Hypothese durchläuft dieselbe Pipeline wie entdeckte Strategien: Backtest nach Kosten → Paper Trading → Validierung. Die Spezifikation wird
          serverseitig geprüft.
        </p>
        <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-lg border border-line-strong bg-surface-2 px-3 py-1.5 outline-none focus:border-accent" />
        <textarea
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
          rows={18}
          spellCheck={false}
          className="num w-full rounded-lg border border-line-strong bg-surface-2 p-3 text-[11.5px] outline-none focus:border-accent"
        />
        {err && <ErrorBox error={err} />}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setErr(null);
              let parsed: unknown;
              try {
                parsed = JSON.parse(spec);
              } catch {
                setErr("Ungültiges JSON");
                return;
              }
              setBusy(true);
              try {
                await api.post("/api/strategies", { name, spec: parsed });
                await qc.invalidateQueries({ queryKey: ["strategies"] });
                onClose();
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Anlegen & testen
          </Button>
        </div>
      </div>
    </Modal>
  );
}
