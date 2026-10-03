"use client";
import { useState } from "react";
import { Button, Card, ErrorBox, Kpi, PageTitle, Table } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { bps, eur, ms, pct, time } from "@/lib/format";
import type { LearningSnapshot, SetPerf } from "@/lib/types";

interface Version { id: string; version: number; parent_id: string | null; status: string; created_by: string; created_at: string; notes: string | null; params: Record<string, unknown> }

function PerfRow({ name, s }: { name: string; s: SetPerf | undefined }) {
  return (
    <tr>
      <td>{name}</td>
      <td className="num">{s?.n ?? "–"}</td>
      <td className="num">{s ? eur(s.netEur, 4) : "–"}</td>
      <td className="num">{s ? eur(s.expectancyEur, 5) : "–"}</td>
      <td className="num">{s ? pct(s.winRate, 0) : "–"}</td>
      <td className="num">{s ? pct(s.failureRate, 0) : "–"}</td>
      <td className="num">{s ? eur(s.maxDrawdownEur, 4) : "–"}</td>
      <td className="num">{s ? s.pValue.toFixed(3) : "–"}</td>
    </tr>
  );
}

export default function Learning() {
  const { data, reload } = useApi<{ snapshot: LearningSnapshot | null; versions: Version[]; history: { ts: string; kind: string; value: Record<string, unknown> }[] }>("/api/learning", 15_000);
  const [err, setErr] = useState<string | null>(null);
  const s = data?.snapshot;
  const r = s?.report;
  const opt = data?.history.find((h) => h.kind === "optimizer");
  return (
    <div className="space-y-4">
      <PageTitle
        title="Learning"
        sub="Statistisches Lernen (kein blindes RL): Ausführungswahrscheinlichkeit, Spread-Decay/Slippage, Latenz, Routen-Zuverlässigkeit, Gebühren — chronologisch validiert (60/20/20 + Walk-Forward). Es kann keine Risikolimits erhöhen und Live nie selbst aktivieren."
        right={<Button onClick={() => void api("/api/learning/optimize", { method: "POST" }).then(() => setTimeout(reload, 2_000)).catch((e: Error) => setErr(e.message))}>Optimierung jetzt ausführen</Button>}
      />
      <ErrorBox error={err} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Kpi label="Score" value={s ? `${s.score}/100` : "–"} sub={s?.status.replace(/_/g, " ")} />
        <Kpi label="Paper-Opportunities" value={s?.counts.paperOpportunities.toLocaleString("de-DE") ?? "–"} sub="Gate: ≥ 5000" />
        <Kpi label="Simulierte Ausführungen" value={s?.counts.simulatedExecutions ?? "–"} sub="Gate: ≥ 500" />
        <Kpi label="Erfolgsquote" value={pct(s?.successRate, 0)} />
        <Kpi label="Erwartete Slippage" value={bps(s?.expectedSlippageBps)} sub={`σ ${bps(s?.slippageStdBps)}`} />
        <Kpi label="Latenz (p75)" value={ms(s?.latencyMs)} sub={`${s?.latencySamples ?? 0} Messungen`} />
        <Kpi label="Ausführungsmodell" value={s?.executionModelTrained ? "trainiert" : "Prior"} sub={r ? `Genauigkeit ${pct(r.executionAccuracy, 0)}` : undefined} />
        <Kpi label="Strategie" value={s?.strategyVersionId ?? "–"} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Live-Gate">
          <Table head={["Prüfung", "Wert", "Anforderung", ""]} empty={!s}>
            {(s?.gate.checks ?? []).map((c) => (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td className="num">{c.value}</td>
                <td className="num text-mute">{c.required}</td>
                <td className={c.ok ? "text-good" : "text-crit"}>{c.ok ? "✓" : "✕"}</td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Chronologische Validierung (Kalibrierung / Validierung / Out-of-Sample)">
          {r ? (
            <>
              <Table head={["Abschnitt", "n", "Netto", "Erwartungswert", "Treffer", "Fehler", "Max. DD", "p-Wert"]}>
                <PerfRow name="Training 60 %" s={r.train} />
                <PerfRow name="Validierung 20 %" s={r.validation} />
                <PerfRow name="Out-of-Sample 20 %" s={r.oos} />
                {r.walkForward.map((f) => <PerfRow key={f.fold} name={`Walk-Forward ${f.fold}`} s={f.test} />)}
              </Table>
              <div className="mt-2 text-[11px] text-ink2">Genauigkeit: Ausführung {pct(r.executionAccuracy, 0)} · Slippage {pct(r.slippageAccuracy, 0)} · Gebühren {pct(r.feeAccuracy, 0)} · stabil: {r.stable ? "✓ ja" : "✕ nein"}</div>
            </>
          ) : (
            <div className="text-[12px] text-mute">Validierung startet ab 50 ausgeführten Paper-Trades.</div>
          )}
        </Card>
      </div>
      <Card title="Strategie-Versionen (automatische Optimierung nur strenger, mit Rollback)">
        <Table head={["Version", "Status", "Erstellt", "von", "Eltern", "Schwellen", "Notiz"]} empty={!data?.versions.length}>
          {(data?.versions ?? []).map((v) => (
            <tr key={v.id}>
              <td className="font-medium">{v.id}</td>
              <td className={v.status === "active" ? "text-good" : v.status === "rolled_back" ? "text-crit" : "text-ink2"}>{v.status}</td>
              <td className="num text-mute">{time(v.created_at)}</td>
              <td>{v.created_by}</td>
              <td>{v.parent_id ?? "–"}</td>
              <td className="num text-[11px] text-ink2">min {String(v.params.minNetProfitEur)} € · {String(v.params.minNetProfitPercent)} % · P≥{String(v.params.minExecutionProbability)} · Puffer {String(v.params.safetyBufferBps)} bps</td>
              <td className="text-[11px] text-ink2">{v.notes ?? ""}</td>
            </tr>
          ))}
        </Table>
        {opt && <div className="mt-2 text-[11px] text-mute">Letzte Optimierung ({time(opt.ts)}): {String(opt.value.reason)}</div>}
      </Card>
    </div>
  );
}
