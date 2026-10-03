"use client";
import Link from "next/link";
import { ago, bps, eur, ms, pct } from "@/lib/format";
import { Pnl, Table } from "./ui";

export interface ScannerRow {
  id: string;
  ts: number;
  type: string;
  route: string[];
  dexes: string[];
  sizeEur: number;
  grossBps: number;
  netEur: number;
  netBps: number;
  probability: number;
  quoteAgeMs: number;
  status: string;
  reason: string | null;
  detail: string | null;
}

export interface CandidateRow {
  key: string;
  type: string;
  route: string[];
  dexes: string[];
  midSpreadBps: number;
  netSpreadBps: number;
  slot: number;
  ageMs: number;
}

export function StatusText({ status, reason }: { status: string; reason?: string | null }) {
  const good = ["EXECUTABLE", "SIMULATED", "CONFIRMED", "PAPER_WIN", "LIVE_CONFIRMED"].includes(status);
  const bad = ["FAILED", "PAPER_FAILED", "LIVE_FAILED"].includes(status);
  return (
    <span className={`text-[11px] ${good ? "text-good" : bad ? "text-crit" : "text-ink2"}`} title={reason ?? undefined}>
      {good ? "✓ " : bad ? "✕ " : ""}
      {status === "REJECTED" ? (reason ?? "REJECTED") : status}
    </span>
  );
}

export function OpportunityTable({ rows, compact = false }: { rows: ScannerRow[]; compact?: boolean }) {
  return (
    <Table head={["Zeit", "Typ", "Route", "DEX", "Größe", "Brutto", "Netto (nutzbar)", "P(Exec)", ...(compact ? [] : ["Quote-Alter"]), "Entscheidung"]} empty={rows.length === 0}>
      {rows.map((o) => (
        <tr key={o.id}>
          <td className="num text-mute">{ago(o.ts)}</td>
          <td>{o.type}</td>
          <td>
            <Link className="text-accent hover:underline" href={`/opportunity?id=${encodeURIComponent(o.id)}`}>
              {o.route.join(" → ")}
            </Link>
          </td>
          <td className="text-ink2">{o.dexes.join(" → ")}</td>
          <td className="num">{o.sizeEur ? eur(o.sizeEur) : "–"}</td>
          <td className="num">{o.sizeEur ? bps(o.grossBps) : "–"}</td>
          <td>{o.sizeEur ? <Pnl v={o.netEur} /> : <span className="text-mute">–</span>}</td>
          <td className="num">{o.sizeEur ? pct(o.probability, 0) : "–"}</td>
          {!compact && <td className="num">{o.sizeEur ? ms(o.quoteAgeMs) : "–"}</td>}
          <td title={o.detail ?? undefined}>
            <StatusText status={o.status} reason={o.reason} />
          </td>
        </tr>
      ))}
    </Table>
  );
}

export function CandidateTable({ rows }: { rows: CandidateRow[] }) {
  return (
    <Table head={["Typ", "Route", "DEX", "Mid-Spread", "nach Pool-Fees", "Slot", "State-Alter"]} empty={rows.length === 0}>
      {rows.map((c) => (
        <tr key={c.key}>
          <td>{c.type}</td>
          <td>{c.route.join(" → ")}</td>
          <td className="text-ink2">{c.dexes.join(" → ")}</td>
          <td className="num">{bps(c.midSpreadBps)}</td>
          <td className="num">{bps(c.netSpreadBps)}</td>
          <td className="num text-mute">{c.slot}</td>
          <td className="num text-mute">{ms(c.ageMs)}</td>
        </tr>
      ))}
    </Table>
  );
}
