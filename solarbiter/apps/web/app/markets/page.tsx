"use client";
import { useMemo, useState } from "react";
import { Card, PageTitle, Table, inputNarrow } from "@/components/ui";
import { useApi } from "@/lib/api";
import { bps, ms, short } from "@/lib/format";

interface Market { pool: string; dex: string; kind: string; label: string; pair: string; price: number | null; feeBps: number; tvlUsd: number; slot: number | null; ageMs: number | null; active: boolean }
interface Token { mint: string; symbol: string; name: string; decimals: number; program: string | null; mint_authority: string | null; freeze_authority: string | null; allowlisted: boolean; denylisted: boolean; safe: boolean; safety_reasons: string[] }

const fmtPrice = (p: number | null) => (p === null ? "–" : p >= 1000 ? p.toLocaleString("de-DE", { maximumFractionDigits: 2 }) : p >= 1 ? p.toFixed(4) : p.toPrecision(5));

export default function Markets() {
  const { data } = useApi<{ markets: { ts: number; slot: number; markets: Market[] } | null; tokens: Token[] }>("/api/markets", 3_000);
  const [q, setQ] = useState("");
  const rows = useMemo(() => (data?.markets?.markets ?? []).filter((m) => !q || m.pair.toLowerCase().includes(q.toLowerCase()) || m.dex.includes(q.toLowerCase())).sort((a, b) => a.pair.localeCompare(b.pair) || b.tvlUsd - a.tvlUsd), [data, q]);
  return (
    <div className="space-y-4">
      <PageTitle title="Markets" sub="Dekodierter On-Chain-Pool-State (Marginalpreise, nur für das Screening — Entscheidungen fallen ausschließlich auf ausführbaren Quotes)." right={<input className={`${inputNarrow} w-56`} placeholder="Filter (Paar oder DEX)" value={q} onChange={(e) => setQ(e.target.value)} />} />
      <Card title={`Pools (${rows.length})`} right={<span className="num text-[11px] text-mute">Slot {data?.markets?.slot ?? "–"}</span>}>
        <Table head={["Paar", "DEX", "Typ", "Preis (B je A)", "Pool-Fee", "TVL", "State-Alter", "Aktiv", "Pool"]} empty={rows.length === 0}>
          {rows.map((m) => (
            <tr key={m.pool}>
              <td className="font-medium">{m.pair}</td>
              <td>{m.dex}</td>
              <td className="text-ink2">{m.label}</td>
              <td className="num">{fmtPrice(m.price)}</td>
              <td className="num">{bps(m.feeBps)}</td>
              <td className="num">{Math.round(m.tvlUsd).toLocaleString("de-DE")} $</td>
              <td className="num text-mute">{ms(m.ageMs)}</td>
              <td>{m.active ? <span className="text-good">✓</span> : <span className="text-crit">✕ inaktiv</span>}</td>
              <td className="num text-mute" title={m.pool}>{short(m.pool)}</td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Token-Universum (On-Chain geprüft)">
        <Table head={["Symbol", "Mint", "Decimals", "Programm", "Mint-Authority", "Freeze-Authority", "Allow/Deny", "Handelbar", "Hinweise"]} empty={!data?.tokens.length}>
          {(data?.tokens ?? []).map((t) => (
            <tr key={t.mint}>
              <td className="font-medium">{t.symbol}</td>
              <td className="num text-mute" title={t.mint}>{short(t.mint, 6)}</td>
              <td className="num">{t.decimals}</td>
              <td className="text-ink2">{t.program?.startsWith("Tokenz") ? "Token-2022" : "SPL Token"}</td>
              <td className="num text-mute">{short(t.mint_authority)}</td>
              <td className="num text-mute">{short(t.freeze_authority)}</td>
              <td>{t.denylisted ? "Deny" : t.allowlisted ? "Allow" : "–"}</td>
              <td>{t.safe ? <span className="text-good">✓ ja</span> : <span className="text-crit">✕ nein</span>}</td>
              <td className="text-[11px] text-ink2">{(t.safety_reasons ?? []).join("; ")}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
