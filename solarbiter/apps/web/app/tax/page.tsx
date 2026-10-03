"use client";
import { useState } from "react";
import { Card, PageTitle, Table, inputCls } from "@/components/ui";
import { useApi } from "@/lib/api";
import { eur } from "@/lib/format";

export default function Tax() {
  const { data } = useApi<{ byYear: { year: number; kind: string; n: number; pnl_eur: number; fees_eur: number }[]; unknownCostBasis: { n: number } | null; disclaimer: string }>("/api/tax/summary", 60_000);
  const year = new Date().getFullYear();
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const q = `from=${from}T00:00:00Z&to=${to}T23:59:59Z`;
  return (
    <div className="space-y-4">
      <PageTitle title="Tax" sub="Dokumentation aller Live-Transaktionen (FIFO je Asset, EUR-Werte zum SOL/EUR-Kurs des Transaktionszeitpunkts). Paper-Trades sind keine steuerlichen Ereignisse." />
      <div className="rounded border border-warn/50 bg-warn/10 px-3 py-2 text-[12px] text-warn">! Keine Steuerberatung. Die Aufstellung bitte durch Steuerberater bzw. Steuersoftware prüfen lassen.</div>
      <Card title="Export">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-[11px] text-mute">von <input type="date" className={`${inputCls} mt-1`} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="text-[11px] text-mute">bis <input type="date" className={`${inputCls} mt-1`} value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <a className="rounded border border-accent bg-accent/15 px-3 py-1.5 text-[12px] text-accent" href={`/api/tax/export?format=csv&${q}`}>CSV herunterladen</a>
          <a className="rounded border border-line bg-s2 px-3 py-1.5 text-[12px]" href={`/api/tax/export?format=json&${q}`}>JSON herunterladen</a>
        </div>
      </Card>
      <Card title="Übersicht je Jahr">
        <Table head={["Jahr", "Art", "Anzahl", "Realisiert (EUR)", "Gebühren (EUR)"]} empty={!data?.byYear.length}>
          {(data?.byYear ?? []).map((r, i) => (
            <tr key={i}>
              <td className="num">{r.year}</td>
              <td>{r.kind}</td>
              <td className="num">{r.n}</td>
              <td className="num">{eur(r.pnl_eur, 4)}</td>
              <td className="num">{eur(r.fees_eur, 4)}</td>
            </tr>
          ))}
        </Table>
        {(data?.unknownCostBasis?.n ?? 0) > 0 && <div className="mt-2 text-[11px] text-serious">! {data?.unknownCostBasis?.n} Veräußerungen ohne bekannte Anschaffungskosten (z. B. SOL vor Beginn der Aufzeichnung) — werden nicht geschätzt.</div>}
      </Card>
    </div>
  );
}
