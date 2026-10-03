"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { HBars } from "@/components/charts";
import { StatusText } from "@/components/tables";
import { Card, PageTitle, Pnl, Table, inputNarrow } from "@/components/ui";
import { useApi } from "@/lib/api";
import { ago, bps, eur, ms, pct } from "@/lib/format";
import type { WhyNoTrade } from "@/lib/types";

interface Row { id: string; ts: string; mode: string; strategy_type: string; route: string[]; route_dexes: string[]; size_eur: number; gross_profit_percent: number; expected_net_profit_eur: number; execution_probability: number; quote_age_ms: number; status: string; rejection_reason: string | null; rejection_detail: string | null }

export default function Opportunities() {
  const [status, setStatus] = useState("");
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState(24);
  const qs = new URLSearchParams({ limit: "200", ...(status ? { status } : {}), ...(reason ? { reason } : {}) }).toString();
  const { data } = useApi<Row[]>(`/api/opportunities?${qs}`, 5_000);
  const { data: tokens } = useApi<{ tokens: { mint: string; symbol: string }[] }>("/api/markets", 60_000);
  const { data: why } = useApi<WhyNoTrade>(`/api/why-no-trade?hours=${hours}`, 15_000);
  const sym = useMemo(() => {
    const m = new Map((tokens?.tokens ?? []).map((t) => [t.mint, t.symbol]));
    return (x: string) => m.get(x) ?? x.slice(0, 4);
  }, [tokens]);
  const quote = (why?.quoteStage ?? []).map((r) => ({ label: `${r.reason} · ${r.strategyType}`, value: r.count }));
  const screen = (why?.screeningStage ?? []).map((r) => ({ label: `${r.reason} · ${r.strategyType}`, value: r.count }));
  return (
    <div className="space-y-4">
      <PageTitle title="Opportunities" sub="Jede bewertete Opportunity wird gespeichert — auch jede abgelehnte, mit Grund." />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={`WHY NO TRADE? — nach Firm-Quote (${hours} h)`} right={<select className={`${inputNarrow} w-24`} value={hours} onChange={(e) => setHours(Number(e.target.value))}>{[1, 6, 24, 168, 720].map((h) => <option key={h} value={h}>{h} h</option>)}</select>}>
          <HBars items={quote} format={(v) => v.toLocaleString("de-DE")} />
        </Card>
        <Card title="WHY NO TRADE? — Screening (Spread nach Pool-Fees zu klein)">
          <HBars items={screen} format={(v) => v.toLocaleString("de-DE")} slot={1} />
          <div className="mt-2 text-[11px] text-mute">Ausführbar im Zeitraum: {why?.executable ?? "–"}</div>
        </Card>
      </div>
      <Card
        title="Alle Opportunities"
        right={
          <div className="flex gap-2">
            <select className={`${inputNarrow} w-36`} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">alle Status</option>
              {["EXECUTABLE", "REJECTED", "SIMULATED", "CONFIRMED", "FAILED"].map((s) => <option key={s}>{s}</option>)}
            </select>
            <select className={`${inputNarrow} w-56`} value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">alle Gründe</option>
              {[...new Set((why?.quoteStage ?? []).map((r) => r.reason))].map((r) => <option key={r}>{r}</option>)}
            </select>
          </div>
        }
      >
        <Table head={["Zeit", "Modus", "Typ", "Route", "DEX", "Größe", "Brutto", "Netto", "P(Exec)", "Quote-Alter", "Status"]} empty={!data?.length}>
          {(data ?? []).map((o) => (
            <tr key={o.id}>
              <td className="num text-mute">{ago(o.ts)}</td>
              <td>{o.mode}</td>
              <td>{o.strategy_type}</td>
              <td><Link className="text-accent hover:underline" href={`/opportunity?id=${encodeURIComponent(o.id)}`}>{o.route.map(sym).join(" → ")}</Link></td>
              <td className="text-ink2">{o.route_dexes.join(" → ")}</td>
              <td className="num">{o.size_eur ? eur(o.size_eur) : "–"}</td>
              <td className="num">{o.size_eur ? bps(o.gross_profit_percent * 100) : "–"}</td>
              <td>{o.size_eur ? <Pnl v={o.expected_net_profit_eur} /> : "–"}</td>
              <td className="num">{o.size_eur ? pct(o.execution_probability, 0) : "–"}</td>
              <td className="num">{o.size_eur ? ms(o.quote_age_ms) : "–"}</td>
              <td title={o.rejection_detail ?? undefined}><StatusText status={o.status} reason={o.rejection_reason} /></td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
