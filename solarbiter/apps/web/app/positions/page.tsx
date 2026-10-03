"use client";
import { Card, PageTitle, Table } from "@/components/ui";
import { useApi } from "@/lib/api";
import { ago, short } from "@/lib/format";

interface Holding { mint: string; account: string; program: string; raw: string; decimals: number; ui: number }

export default function Positions() {
  const { data } = useApi<{ inflight: Record<string, string | number | null>[]; holdings: Holding[] }>("/api/positions", 3_000);
  return (
    <div className="space-y-4">
      <PageTitle title="Positions" sub="Arbitrage ist atomar: Positionen existieren nur während einer laufenden Ausführung. Token-Bestände im Bot-Wallet werden hier angezeigt." />
      <Card title="Laufende Ausführungen">
        <Table head={["Seit", "Modus", "Opportunity", "Stufe", "Status", "Signatur"]} empty={!data?.inflight.length}>
          {(data?.inflight ?? []).map((a) => (
            <tr key={String(a.id)}>
              <td className="num text-mute">{ago(a.created_at as string)}</td>
              <td>{a.mode}</td>
              <td className="num">{short(String(a.opportunity_id), 6)}</td>
              <td>{a.stage}</td>
              <td>{a.status}</td>
              <td className="num">{short(a.signature as string | null, 6)}</td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Token-Bestände im Bot-Wallet">
        <Table head={["Mint", "Konto", "Programm", "Menge"]} empty={!data?.holdings.length}>
          {(data?.holdings ?? []).map((h) => (
            <tr key={h.account}>
              <td className="num" title={h.mint}>{short(h.mint, 6)}</td>
              <td className="num text-mute">{short(h.account, 6)}</td>
              <td className="text-ink2">{h.program.startsWith("Tokenz") ? "Token-2022" : "SPL Token"}</td>
              <td className="num">{h.ui.toLocaleString("de-DE", { maximumFractionDigits: h.decimals })}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
