import { X } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import { useApi } from "../api/hooks";
import { Badge, Card, PageHeader, Pnl, Table, type Column } from "../components/ui";
import { dateTime, pct } from "../lib/format";
import type { EventStat } from "./Discoveries";

export interface EventRow {
  id: number;
  type: string;
  label: string;
  mint: string | null;
  symbol?: string | null;
  ts: string;
  severity: number;
  direction: number;
  context: Record<string, unknown>;
  outcome: { ret?: Record<string, number | null>; maxRunup1h?: number | null; maxDrawdown1h?: number | null } | null;
}

export function eventColumns(showToken: boolean): Column<EventRow>[] {
  return [
    { key: "ts", header: "Zeit", cell: (e) => <span className="num text-ink-2">{dateTime(e.ts)}</span>, sort: (e) => new Date(e.ts).getTime() },
    ...(showToken ? [{ key: "t", header: "Token", cell: (e: EventRow) => <span className="text-ink">{e.symbol ?? (e.mint ? `${e.mint.slice(0, 6)}…` : "Markt")}</span> }] : []),
    {
      key: "ty",
      header: "Ereignis",
      cell: (e) => (
        <div>
          <span className="text-ink">{e.label}</span> <span className="num text-[10.5px] text-muted">{e.type}</span>
        </div>
      ),
    },
    { key: "sev", header: "Stärke", align: "right", cell: (e) => <span className="num">{e.severity.toFixed(1)}</span>, sort: (e) => e.severity },
    { key: "dir", header: "Richtung", align: "center", cell: (e) => <span className="text-ink-2">{e.direction > 0 ? "↑" : e.direction < 0 ? "↓" : "·"}</span> },
    { key: "r1", header: "+1 min", align: "right", cell: (e) => <Pnl value={e.outcome?.ret?.["60"] ?? null} percent /> },
    { key: "r5", header: "+5 min", align: "right", cell: (e) => <Pnl value={e.outcome?.ret?.["300"] ?? null} percent />, sort: (e) => e.outcome?.ret?.["300"] ?? null },
    { key: "r60", header: "+1 h", align: "right", cell: (e) => <Pnl value={e.outcome?.ret?.["3600"] ?? null} percent />, sort: (e) => e.outcome?.ret?.["3600"] ?? null },
    { key: "ru", header: "Max-Runup 1 h", align: "right", cell: (e) => <span className="num text-ink-2">{pct(e.outcome?.maxRunup1h ?? null, 0)}</span> },
    { key: "dd", header: "Max-DD 1 h", align: "right", cell: (e) => <span className="num text-ink-2">{pct(e.outcome?.maxDrawdown1h ?? null, 0)}</span> },
  ];
}

export function EventsPage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const type = params.get("type");
  const q = useApi<EventRow[]>("events", `/api/events?limit=500${type ? `&type=${encodeURIComponent(type)}` : ""}`, 10_000);
  const stats = useApi<EventStat[]>("events", "/api/events/stats", 60_000);
  return (
    <div className="space-y-4">
      <PageHeader title="Events" subtitle="Erkannte Marktereignisse der letzten 24 h mit ihrem späteren Verlauf (Mid-Preis, vor Kosten)" />
      <Card title="Ereignistypen" subtitle="7 Tage, Anzahl" dense>
        <div className="flex flex-wrap gap-1.5 p-3">
          {type && (
            <button onClick={() => setParams({})} className="inline-flex items-center gap-1 rounded-md bg-accent/20 px-2 py-0.5 text-[11px] text-ink">
              {type} <X size={11} />
            </button>
          )}
          {(stats.data ?? []).map((s) => (
            <button key={s.type} onClick={() => setParams({ type: s.type })}>
              <Badge status={s.type === type ? "ACTIVE" : undefined}>
                {s.type} <span className="num opacity-70">{s.n}</span>
              </Badge>
            </button>
          ))}
        </div>
      </Card>
      <Card dense title={type ? `Ereignisse: ${type}` : "Alle Ereignisse"} subtitle={`${q.data?.length ?? 0} angezeigt`}>
        <Table rows={q.data} columns={eventColumns(true)} rowKey={(e) => String(e.id)} onRowClick={(e) => e.mint && nav(`/token/${e.mint}`)} maxHeight={720} empty="Keine Ereignisse" />
      </Card>
    </div>
  );
}
