import { ExternalLink } from "lucide-react";
import { useNavigate } from "react-router";
import { useApi } from "../api/hooks";
import { Card, Notice, PageHeader, StatusBadge, Table, type Column } from "../components/ui";
import { dateTime, shortAddr } from "../lib/format";

interface OrderRow {
  id: string;
  live_trade_id: string | null;
  kind: string;
  mint: string | null;
  status: string;
  provider: string;
  input_amount: string | null;
  min_output_amount: string | null;
  signature: string | null;
  attempts: number;
  sent_at: string | null;
  confirmed_at: string | null;
  error: string | null;
  created_at: string;
  cost_estimate: { amountLamports: number; priorityFeeLamports: number; networkFeeLamports: number; rentLamports: number; priceImpactPct: number } | null;
  result: Record<string, unknown> | null;
}

export function SigLink({ sig }: { sig: string | null | undefined }) {
  if (!sig) return <span className="text-muted">—</span>;
  return (
    <a href={`https://solscan.io/tx/${sig}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="num inline-flex items-center gap-1 text-accent hover:underline">
      {shortAddr(sig, 6)} <ExternalLink size={11} />
    </a>
  );
}

export function OrdersPage() {
  const nav = useNavigate();
  const q = useApi<OrderRow[]>("live", "/api/orders?limit=300", 5_000);
  const columns: Column<OrderRow>[] = [
    { key: "t", header: "Erstellt", cell: (o) => <span className="num text-ink-2">{dateTime(o.created_at)}</span> },
    { key: "k", header: "Art", cell: (o) => <span className="uppercase text-ink">{o.kind}</span> },
    { key: "m", header: "Token", cell: (o) => <span className="num text-ink-2">{shortAddr(o.mint, 5)}</span> },
    { key: "s", header: "Status", cell: (o) => <StatusBadge status={o.status} /> },
    { key: "p", header: "Provider", cell: (o) => <span className="text-ink-2">{o.provider}</span> },
    { key: "in", header: "Input (raw)", align: "right", cell: (o) => <span className="num text-ink-2">{o.input_amount ?? "—"}</span> },
    { key: "min", header: "Min. Output (raw)", align: "right", cell: (o) => <span className="num text-ink-2">{o.min_output_amount ?? "—"}</span> },
    {
      key: "c",
      header: "Gebühren + Rent erwartet",
      align: "right",
      cell: (o) => <span className="num text-ink-2">{o.cost_estimate ? ((o.cost_estimate.priorityFeeLamports + o.cost_estimate.networkFeeLamports + o.cost_estimate.rentLamports) / 1e9).toFixed(6) : "—"}</span>,
    },
    { key: "pi", header: "Price Impact", align: "right", cell: (o) => <span className="num text-ink-2">{o.cost_estimate ? `${o.cost_estimate.priceImpactPct.toFixed(2)}%` : "—"}</span> },
    { key: "a", header: "Versuche", align: "right", cell: (o) => <span className="num">{o.attempts}</span> },
    { key: "sig", header: "Signatur", cell: (o) => <SigLink sig={o.signature} /> },
    { key: "conf", header: "Bestätigt", cell: (o) => <span className="num text-muted">{dateTime(o.confirmed_at)}</span> },
    { key: "e", header: "Fehler", cell: (o) => <span className="block max-w-[260px] truncate text-rose-300" title={o.error ?? ""}>{o.error ?? ""}</span> },
  ];
  return (
    <div className="space-y-4">
      <PageHeader title="Orders" subtitle="Jede Live-Order mit Idempotenz-Schlüssel, Validierung, Simulation und Bestätigungsstatus" />
      <Notice>Vor jeder Signatur: Zieladresse, Netzwerk, Token-Mint und Programme werden geprüft, die Transaktion simuliert und die Kosten berechnet. Diese Prüfungen lassen sich nicht abschalten.</Notice>
      <Card dense>
        <Table rows={q.data} columns={columns} rowKey={(o) => o.id} onRowClick={(o) => o.live_trade_id && nav(`/trades/live/${o.live_trade_id}`)} maxHeight={780} empty="Noch keine Orders" />
      </Card>
    </div>
  );
}
