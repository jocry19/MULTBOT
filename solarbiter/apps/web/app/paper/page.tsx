"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { TimeChart } from "@/components/charts";
import { useShell } from "@/components/shell";
import { Button, Card, ErrorBox, Field, Kpi, PageTitle, Pnl, Table, inputNarrow } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { ago, bps, eur, ms, pct, sol } from "@/lib/format";
import type { ChartsResponse, PerformanceResponse } from "@/lib/types";

interface PaperTrade { id: string; opportunity_id: string; shadow: boolean; ts_detected: string; latency_ms: number; size_eur: number; predicted_net: string; realized_net: string | null; realized_net_eur: number | null; success: boolean | null; failure_reason: string | null; prediction_error_bps: number | null; route: { mints: string[]; dexes: string[] }; sol_eur: number }

export default function Paper() {
  const { status } = useShell();
  const { data: perf } = useApi<PerformanceResponse>("/api/paper/performance", 5_000);
  const { data: trades } = useApi<PaperTrade[]>("/api/paper/trades?limit=200", 5_000);
  const { data: charts } = useApi<ChartsResponse>("/api/charts?hours=720", 30_000);
  const [err, setErr] = useState<string | null>(null);
  const p = perf?.portfolio;
  const s = perf?.stats;
  const equity = useMemo(() => [{ name: "Paper", kind: "area" as const, data: (charts?.equityPaper ?? []).map((x) => ({ t: x.ts, v: x.equity })) }], [charts]);
  const shadow = status?.worker?.shadow ?? false;
  const toggleShadow = () => api("/api/bot/shadow", { method: "POST", body: { enabled: !shadow } }).catch((e: Error) => setErr(e.message));
  const [capital, setCapital] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const capitalEur = Number(capital.replace(",", "."));
  const capitalOk = Number.isFinite(capitalEur) && capitalEur >= 1 && capitalEur <= 1_000_000;
  const resetPaper = () => {
    setErr(null);
    api("/api/paper/reset", { method: "POST", body: { capitalEur } })
      .then(() => { setMsg(`Paper-Konto startet neu mit ${eur(capitalEur)}.`); setConfirming(false); setCapital(""); })
      .catch((e: Error) => { setErr(e.message); setConfirming(false); });
  };
  return (
    <div className="space-y-4">
      <PageTitle
        title="Paper Trading"
        sub="Echte Marktdaten, virtuelle Ausführung: nach der gelernten Latenz wird jede Leg neu gequotet; dieselben Mindest-Outputs wie live entscheiden über Erfolg oder Revert. Paper und Live sind strikt getrennt."
        right={<Button onClick={toggleShadow} title="SHADOW: zusätzlich echte simulateTransaction mit dem Bot-Wallet (nichts wird gesendet)">{shadow ? "Shadow-Modus aus" : "Shadow-Modus an"}</Button>}
      />
      <ErrorBox error={err} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Kpi label="Kapital (virtuell)" value={eur(p?.equityEur)} sub={p ? sol(p.balanceLamports) : undefined} />
        <Kpi label="Realisiert" value={<Pnl v={p?.realizedEur ?? null} />} />
        <Kpi label="Heute" value={<Pnl v={p?.pnlTodayEur ?? null} />} />
        <Kpi label="Trades" value={s?.trades ?? "–"} sub={s ? `${s.wins} ▲ / ${s.losses} ▼` : undefined} />
        <Kpi label="Erwartungswert" value={<Pnl v={s?.expectancy_eur ?? null} digits={5} />} sub="pro Trade" />
        <Kpi label="Max. Drawdown" value={eur(p?.maxDrawdownEur, 4)} />
        <Kpi label="Ø Prognosefehler" value={bps(s?.avg_prediction_error_bps)} sub="erwartet − realisiert" />
        <Kpi label="Fehlschläge in Folge" value={p?.consecutiveFailures ?? "–"} tone={(p?.consecutiveFailures ?? 0) > 0 ? "warn" : null} />
      </div>
      <Card title="Paper-Konto neu starten">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Neues Startkapital (EUR)" hint={perf?.since ? `aktuelles Konto seit ${new Date(perf.since).toLocaleString("de-DE")}` : undefined}>
            <input id="paper-capital" className={`${inputNarrow} w-36`} inputMode="decimal" placeholder="z. B. 300" value={capital} onChange={(e) => { setCapital(e.target.value); setConfirming(false); setMsg(null); }} />
          </Field>
          {!confirming ? (
            <Button disabled={!capitalOk} onClick={() => setConfirming(true)}>Neu starten …</Button>
          ) : (
            <>
              <Button tone="primary" onClick={resetPaper}>Ja, mit {eur(capitalEur)} neu starten</Button>
              <Button onClick={() => setConfirming(false)}>Abbrechen</Button>
            </>
          )}
        </div>
        <p className="mt-2 text-[11px] text-mute">Nur Simulation, kein Echtgeld. Bisherige Paper-Trades bleiben gespeichert (Verlauf, Learning); Kapital, Ergebnis und Kennzahlen zählen ab dem Neustart. Größere Trades erst, wenn du unter Einstellungen „maxTradeEur“ und die Trade-Größen erhöhst (Passwort nötig).</p>
        {msg && <p className="mt-1 text-[12px] text-good">{msg}</p>}
      </Card>
      <Card title="Equity-Kurve (realisierte Paper-Ergebnisse, EUR)">
        <TimeChart series={equity} format={(v) => `${v.toFixed(4)} €`} />
      </Card>
      <Card title="Paper-Trades">
        <Table head={["Zeit", "Route", "DEX", "Größe", "Latenz", "Erwartet", "Realisiert", "Fehler", "Ergebnis"]} empty={!trades?.length}>
          {(trades ?? []).map((t) => (
            <tr key={t.id}>
              <td className="num text-mute">{ago(t.ts_detected)}</td>
              <td><Link className="text-accent hover:underline" href={`/opportunity?id=${encodeURIComponent(t.opportunity_id)}`}>{t.route.mints.length} Hops{t.shadow ? " · shadow" : ""}</Link></td>
              <td className="text-ink2">{t.route.dexes.join(" → ")}</td>
              <td className="num">{eur(t.size_eur)}</td>
              <td className="num">{ms(t.latency_ms)}</td>
              <td><Pnl v={(Number(t.predicted_net) / 1e9) * t.sol_eur} digits={5} /></td>
              <td><Pnl v={t.realized_net_eur} digits={5} /></td>
              <td className="num">{bps(t.prediction_error_bps)}</td>
              <td className={t.success ? "text-good" : t.success === false ? "text-crit" : "text-mute"} title={t.failure_reason ?? undefined}>{t.success ? "✓ gelandet" : t.success === false ? `✕ ${t.failure_reason?.split(":")[0] ?? "Fehler"}` : "? unbekannt"}</td>
            </tr>
          ))}
        </Table>
        {p && <div className="mt-2 text-[11px] text-mute">Trefferquote {pct(p.trades ? p.wins / p.trades : null, 0)} · nicht beobachtbar im Paper: Konkurrenz um Blockplatz (wird live gemessen und verglichen).</div>}
      </Card>
    </div>
  );
}
