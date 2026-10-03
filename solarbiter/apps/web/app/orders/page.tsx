"use client";
import { Card, PageTitle, Table } from "@/components/ui";
import { useApi } from "@/lib/api";
import { ago, short } from "@/lib/format";

type Attempt = Record<string, string | number | null>;

export default function Orders() {
  const { data } = useApi<{ transactions: Record<string, string | number | null>[]; attempts: Attempt[]; bundles: Record<string, string | number | null>[] }>("/api/transactions?limit=200", 5_000);
  return (
    <div className="space-y-4">
      <PageTitle title="Orders" sub="Ausführungsversuche (idempotent pro Opportunity), Transaktionen und Jito-Bundles. Jede Opportunity wird höchstens einmal ausgeführt." />
      <Card title="Ausführungsversuche">
        <Table head={["Zeit", "Modus", "Stufe", "Status", "Weg", "CU-Limit", "Priority", "Tip", "Signatur", "Fehler"]} empty={!data?.attempts.length}>
          {(data?.attempts ?? []).map((a) => (
            <tr key={String(a.id)}>
              <td className="num text-mute">{ago(a.created_at as string)}</td>
              <td>{a.mode}</td>
              <td>{a.stage}</td>
              <td>{a.status}</td>
              <td>{a.via ?? "–"}</td>
              <td className="num">{a.cu_limit ?? "–"}</td>
              <td className="num">{a.priority_fee_lamports ?? "–"}</td>
              <td className="num">{a.jito_tip_lamports ?? "–"}</td>
              <td className="num">{short(a.signature as string | null, 6)}</td>
              <td className="max-w-[320px] truncate text-crit" title={String(a.error ?? "")}>{a.error ?? ""}</td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Transaktionen">
        <Table head={["Zeit", "Typ", "Status", "SOL-Änderung", "Gebühr", "Ergebnis", "Signatur"]} empty={!data?.transactions.length}>
          {(data?.transactions ?? []).map((t) => (
            <tr key={String(t.signature)}>
              <td className="num text-mute">{ago(t.ts as string)}</td>
              <td>{t.type}</td>
              <td>{t.status}</td>
              <td className="num">{t.sol_change_lamports ?? "–"}</td>
              <td className="num">{t.fee_lamports ?? "–"}</td>
              <td className="num">{t.profit_lamports ?? "–"}</td>
              <td className="num"><a className="text-accent hover:underline" href={`https://solscan.io/tx/${t.signature}`} target="_blank" rel="noreferrer noopener">{short(String(t.signature), 6)}</a></td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Jito-Bundles">
        <Table head={["Zeit", "Bundle", "Tip", "Status", "Slot"]} empty={!data?.bundles.length}>
          {(data?.bundles ?? []).map((b) => (
            <tr key={String(b.bundle_id)}>
              <td className="num text-mute">{ago(b.ts as string)}</td>
              <td className="num">{short(String(b.bundle_id), 6)}</td>
              <td className="num">{b.tip_lamports}</td>
              <td>{b.status}</td>
              <td className="num">{b.landed_slot ?? "–"}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
