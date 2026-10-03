"use client";
import { useShell } from "@/components/shell";
import { Button, Card, Kpi, PageTitle, Pnl, Table } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { eur, lamportsEur, short, sol, time } from "@/lib/format";
import type { PerformanceResponse } from "@/lib/types";

export default function Portfolio() {
  const { status } = useShell();
  const { data: paper } = useApi<PerformanceResponse>("/api/paper/performance", 5_000);
  const { data: live } = useApi<PerformanceResponse>("/api/live/performance", 5_000);
  const { data: wallet } = useApi<{ wallet: { configured: boolean; address: string | null; balanceLamports: string | null } | null; solEur: number | null; balanceChecks: { ts: string; onchain_lamports: string; expected_lamports: string | null; matched: boolean; note: string | null }[] }>("/api/wallet", 10_000);
  const w = wallet?.wallet;
  const solEur = wallet?.solEur ?? status?.worker?.solEur ?? null;
  return (
    <div className="space-y-4">
      <PageTitle title="Portfolio" sub="Paper- und Live-Portfolio werden getrennt geführt und nie vermischt." right={<Button onClick={() => void api("/api/wallet/refresh", { method: "POST" })}>Wallet aktualisieren</Button>} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Paper (virtuell)">
          <div className="grid grid-cols-2 gap-3">
            <Kpi label="Kapital" value={eur(paper?.portfolio?.equityEur)} sub={paper?.portfolio ? sol(paper.portfolio.balanceLamports) : undefined} />
            <Kpi label="Realisiert" value={<Pnl v={paper?.portfolio?.realizedEur ?? null} />} />
            <Kpi label="Heute" value={<Pnl v={paper?.portfolio?.pnlTodayEur ?? null} />} />
            <Kpi label="Trades" value={paper?.portfolio?.trades ?? "–"} />
          </div>
        </Card>
        <Card title="Live (Bot-Wallet, echte Werte von der Chain)">
          <div className="grid grid-cols-2 gap-3">
            <Kpi label="Wallet" value={w?.configured ? short(w.address, 6) : "nicht konfiguriert"} />
            <Kpi label="SOL-Bestand" value={w?.balanceLamports ? sol(w.balanceLamports) : "–"} sub={w?.balanceLamports ? eur(lamportsEur(w.balanceLamports, solEur)) : undefined} />
            <Kpi label="Realisiert" value={<Pnl v={live?.portfolio?.realizedEur ?? null} />} />
            <Kpi label="Trades" value={live?.portfolio?.trades ?? "–"} />
          </div>
          {!w?.configured && <div className="mt-3 text-[12px] text-mute">Wallet anlegen: <code className="num">pnpm wallet:create</code> (verschlüsselter Keystore; der private Schlüssel verlässt nie den Worker).</div>}
        </Card>
      </div>
      <Card title="Saldenabgleich (On-Chain vs. erfasste Live-Ergebnisse)">
        <Table head={["Zeit", "On-Chain", "Erwartet", "Ergebnis", "Notiz"]} empty={!wallet?.balanceChecks.length}>
          {(wallet?.balanceChecks ?? []).map((c, i) => (
            <tr key={i}>
              <td className="num text-mute">{time(c.ts)}</td>
              <td className="num">{sol(c.onchain_lamports, 6)}</td>
              <td className="num">{c.expected_lamports ? sol(c.expected_lamports, 6) : "–"}</td>
              <td className={c.matched ? "text-good" : "text-crit"}>{c.matched ? "✓ stimmt" : "✕ Abweichung"}</td>
              <td className="text-ink2">{c.note ?? ""}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
