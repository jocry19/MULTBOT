"use client";
import { CandidateTable, OpportunityTable, type CandidateRow, type ScannerRow } from "@/components/tables";
import { Card, Kpi, PageTitle, Table } from "@/components/ui";
import { useShell } from "@/components/shell";
import { useApi } from "@/lib/api";
import { ms } from "@/lib/format";

export default function Arbitrage() {
  const { status } = useShell();
  const { data } = useApi<{ candidates: CandidateRow[]; opportunities: ScannerRow[]; queue?: { pending: number; remainingThisMinute: number; backedOff?: { key: string; strikes: number; untilMs: number }[] } }>("/api/scanner", 2_000);
  const w = status?.worker;
  return (
    <div className="space-y-4">
      <PageTitle title="Arbitrage-Scanner" sub="Stufe 1: Pool-State-Screening (direkt + triangulär). Stufe 2: ausführbare, DEX-gebundene Jupiter-Quotes mit Size-Ladder und vollständigem Kostenmodell." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi label="Routen gescreent / min" value={w ? w.scanner.screened1m.toLocaleString("de-DE") : "–"} />
        <Kpi label="Kandidaten / min" value={w ? w.scanner.candidates1m : "–"} />
        <Kpi label="Pools · Token" value={w ? `${w.scanner.pools} · ${w.scanner.tokens}` : "–"} />
        <Kpi label="Verifikationen frei (min)" value={data?.queue?.remainingThisMinute ?? "–"} sub={`${data?.queue?.pending ?? 0} in der Queue`} />
        <Kpi label="Quote-Requests (60 s)" value={w ? `${w.quoteBudget.used1m}/${w.quoteBudget.limit1m}` : "–"} />
      </div>
      <Card title="Kandidaten aus dem Screening (Marginalpreise nach Pool-Fees)">
        <CandidateTable rows={data?.candidates ?? []} />
      </Card>
      <Card title="Verifizierte Opportunities (Firm-Quotes)">
        <OpportunityTable rows={data?.opportunities ?? []} />
      </Card>
      <Card title="Zurückgestellte Routen (Screening ≠ ausführbare Quote)">
        <Table head={["Route", "Strikes", "wieder prüfbar in"]} empty={!data?.queue?.backedOff?.length}>
          {(data?.queue?.backedOff ?? []).map((b) => (
            <tr key={b.key}>
              <td className="text-ink2">{b.key}</td>
              <td className="num">{b.strikes}</td>
              <td className="num">{ms(b.untilMs)}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
