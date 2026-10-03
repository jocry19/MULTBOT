"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";
import { HBars } from "@/components/charts";
import { StatusText } from "@/components/tables";
import { Card, ErrorBox, Kpi, PageTitle, Pnl, Table } from "@/components/ui";
import { useApi } from "@/lib/api";
import { bps, eur, lamportsEur, ms, pct, short, time } from "@/lib/format";

interface Detail {
  opportunity: Record<string, unknown> & { id: string; ts: string; status: string; rejection_reason: string | null; strategy_type: string; mode: string; sol_eur: number; size_eur: number; expected_net_profit_eur: number; execution_probability: number; quote_age_ms: number; decision_log: { label: string; bps: number | null; lamports: string | null }[]; size_ladder: { sizeEur: number; netEur: number; interpolated: boolean; costs: { grossProfitBps: number; usableEdgeBps: number } }[]; legs: { source: string; inputMint: string; outputMint: string; inputAmount: string; outputAmount: string; minOutputAmount: string; slippageBps: number; slot: number | null; latencyMs: number; route: { label: string; pool: string }[] }[] };
  explanation: string[];
  paperTrades: Record<string, unknown>[];
  liveTrades: Record<string, unknown>[];
}

function DetailView() {
  const id = useSearchParams().get("id");
  const { data, error } = useApi<Detail>(id ? `/api/opportunities/${encodeURIComponent(id)}` : null, 0);
  const o = data?.opportunity;
  const ladder = useMemo(() => (o?.size_ladder ?? []).map((e) => ({ label: `${e.sizeEur.toFixed(2)} €${e.interpolated ? " (modelliert)" : " (Firm-Quote)"}`, value: e.netEur })), [o]);
  if (!id) return <ErrorBox error="keine Opportunity-ID" />;
  if (error) return <ErrorBox error={error} />;
  if (!o) return <div className="text-mute">Lade …</div>;
  return (
    <div className="space-y-4">
      <PageTitle title="Opportunity" sub={`${o.id} · ${time(o.ts)}`} right={<StatusText status={o.status} reason={o.rejection_reason} />} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi label="Typ · Modus" value={`${o.strategy_type} · ${o.mode}`} />
        <Kpi label="Größe" value={o.size_eur ? eur(o.size_eur) : "–"} />
        <Kpi label="Nutzbare Kante" value={<Pnl v={o.expected_net_profit_eur} />} tone={o.expected_net_profit_eur > 0 ? "good" : "bad"} />
        <Kpi label="P(Ausführung)" value={pct(o.execution_probability, 0)} />
        <Kpi label="Quote-Alter" value={ms(o.quote_age_ms)} />
      </div>
      <Card title="Warum will der Bot diesen Trade machen?">
        <ol className="list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed text-ink">
          {data.explanation.map((l, i) => <li key={i}>{l}</li>)}
        </ol>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Entscheidungs-Wasserfall">
          <Table head={["Posten", "bps", "EUR"]} empty={!o.decision_log.length}>
            {o.decision_log.map((l, i) => (
              <tr key={i} className={/Usable|Gross|Net if|Expected value/.test(l.label) ? "font-semibold" : ""}>
                <td>{l.label}</td>
                <td className="num">{l.bps === null ? "–" : bps(l.bps)}</td>
                <td className="num">{l.lamports === null ? "–" : <Pnl v={lamportsEur(l.lamports, o.sol_eur)} digits={5} />}</td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Size-Ladder: erwarteter Nettogewinn je Größe">
          <HBars items={ladder} format={(v) => `${v.toFixed(5)} €`} />
          <div className="mt-2 text-[11px] text-mute">Die gewählte Größe wird immer mit einer echten Firm-Quote verifiziert.</div>
        </Card>
      </div>
      <Card title="Legs (ausführbare Quotes)">
        <Table head={["#", "DEX", "Venue", "Pool", "Input", "Output", "Min-Output", "Slippage", "Slot", "Latenz"]} empty={!o.legs.length}>
          {o.legs.map((l, i) => (
            <tr key={i}>
              <td className="num">{i + 1}</td>
              <td>{l.source}</td>
              <td className="text-ink2">{l.route.map((r) => r.label).join(", ")}</td>
              <td className="num text-mute" title={l.route[0]?.pool}>{short(l.route[0]?.pool)}</td>
              <td className="num">{l.inputAmount}</td>
              <td className="num">{l.outputAmount}</td>
              <td className="num">{l.minOutputAmount}</td>
              <td className="num">{bps(l.slippageBps, 0)}</td>
              <td className="num text-mute">{l.slot ?? "–"}</td>
              <td className="num">{ms(l.latencyMs)}</td>
            </tr>
          ))}
        </Table>
      </Card>
      {(data.paperTrades.length > 0 || data.liveTrades.length > 0) && (
        <Card title="Ausführung">
          <pre className="num max-h-80 overflow-auto whitespace-pre-wrap text-[11px] text-ink2">{JSON.stringify({ paper: data.paperTrades, live: data.liveTrades }, null, 2)}</pre>
        </Card>
      )}
    </div>
  );
}

export default function OpportunityPage() {
  return (
    <Suspense fallback={<div className="text-mute">Lade …</div>}>
      <DetailView />
    </Suspense>
  );
}
