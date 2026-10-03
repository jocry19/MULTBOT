"use client";
import { useMemo } from "react";
import { HBars, TimeChart } from "@/components/charts";
import { useShell } from "@/components/shell";
import { CandidateTable, OpportunityTable, type CandidateRow, type ScannerRow } from "@/components/tables";
import { Card, Kpi, PageTitle, Pnl } from "@/components/ui";
import { useApi } from "@/lib/api";
import { ago, eur, pct } from "@/lib/format";
import type { ChartsResponse, PerformanceResponse, WhyNoTrade } from "@/lib/types";

export default function Dashboard() {
  const { status, lastEvents } = useShell();
  const { data: scanner } = useApi<{ candidates: CandidateRow[]; opportunities: ScannerRow[]; queue?: { pending: number; remainingThisMinute: number } }>("/api/scanner", 2_000);
  const { data: paper } = useApi<PerformanceResponse>("/api/paper/performance", 5_000);
  const { data: why } = useApi<WhyNoTrade>("/api/why-no-trade?hours=24", 15_000);
  const { data: charts } = useApi<ChartsResponse>("/api/charts?hours=24", 30_000);
  const w = status?.worker;
  const p = paper?.portfolio;
  const winRate = p && p.trades ? p.wins / p.trades : null;
  const equity = useMemo(() => [{ name: "Paper", kind: "area" as const, data: (charts?.equityPaper ?? []).map((x) => ({ t: x.ts, v: x.equity })) }], [charts]);
  const reasons = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of [...(why?.quoteStage ?? []), ...(why?.screeningStage ?? [])]) m.set(r.reason, (m.get(r.reason) ?? 0) + r.count);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
  }, [why]);

  return (
    <div className="space-y-4">
      <PageTitle title="Dashboard" sub="NO NET EDGE = NO TRADE — Paper-Trading auf echten Marktdaten; Echtgeld erst nach Validierung und manueller Freigabe." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Kpi label="Modus" value={status?.botState.replace(/_/g, " ") ?? "–"} sub={status?.liveGate.state.replace(/_/g, " ")} />
        <Kpi label="Paper-Kapital" value={eur(p?.equityEur)} sub={p ? `realisiert ${p.realizedEur >= 0 ? "+" : ""}${p.realizedEur.toFixed(4)} €` : undefined} />
        <Kpi label="P&L heute (Paper)" value={<Pnl v={p?.pnlTodayEur ?? null} />} sub={p ? `Drawdown ${eur(p.drawdownEur, 3)}` : undefined} />
        <Kpi label="Trades · Trefferquote" value={p ? `${p.trades} · ${pct(winRate, 0)}` : "–"} sub={p ? `${p.failures} Reverts/Fehler` : undefined} />
        <Kpi label="Gescreent / min" value={w ? w.scanner.screened1m.toLocaleString("de-DE") : "–"} sub={w ? `${w.scanner.candidates1m} Kandidaten · ${w.scanner.pools} Pools` : undefined} />
        <Kpi label="Ausführbar (24 h)" value={why ? why.executable : "–"} sub={why ? `${(why.quoteStage.reduce((a, r) => a + r.count, 0)).toLocaleString("de-DE")} nach Firm-Quote abgelehnt` : undefined} />
        <Kpi label="Learning" value={w ? `${w.learning.score}/100` : "–"} sub={w?.learning.status.replace(/_/g, " ")} />
        <Kpi label="Quote-Budget" value={w ? `${w.quoteBudget.used1m}/${w.quoteBudget.limit1m}` : "–"} sub={w ? `${w.quoteBudget.rps} rps Plan · Queue ${scanner?.queue?.remainingThisMinute ?? "–"} frei` : undefined} />
      </div>

      <Card title="Live-Scanner — verifizierte Opportunities" right={<span className="text-[11px] text-mute">aktualisiert alle 2 s</span>}>
        <OpportunityTable rows={(scanner?.opportunities ?? []).slice(0, 15)} compact />
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Screening-Kandidaten (Pool-State, vor Firm-Quotes)">
          <CandidateTable rows={(scanner?.candidates ?? []).slice(0, 10)} />
        </Card>
        <Card title="Warum kein Trade? (24 h)">
          <HBars items={reasons.slice(0, 10)} format={(v) => v.toLocaleString("de-DE")} />
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Paper-Equity (realisiert, EUR)">
          <TimeChart series={equity} format={(v) => `${v.toFixed(4)} €`} />
        </Card>
        <Card title="Ereignisse (live)">
          <div className="max-h-[260px] space-y-1 overflow-y-auto text-[11px]">
            {lastEvents.length === 0 && <div className="text-mute">Warte auf Ereignisse …</div>}
            {lastEvents.slice(0, 60).map((e, i) => (
              <div key={i} className="flex gap-2">
                <span className="num w-12 shrink-0 text-mute">{ago(e.ts)}</span>
                <span className="w-44 shrink-0 text-ink2">{e.type}</span>
                <span className="truncate text-ink">{summarize(e.payload)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function summarize(p: unknown): string {
  if (!p || typeof p !== "object") return String(p ?? "");
  const o = p as Record<string, unknown>;
  if (Array.isArray(o.route)) return `${(o.route as string[]).join("→")} ${o.status ?? ""} ${o.reason ?? ""}`;
  if (typeof o.message === "string") return o.message;
  if (typeof o.title === "string") return `${o.title}: ${o.message ?? ""}`;
  return JSON.stringify(o).slice(0, 160);
}
