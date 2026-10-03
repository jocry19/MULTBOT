"use client";
import { useState, type FormEvent } from "react";
import { useShell } from "@/components/shell";
import { Button, Card, ErrorBox, Field, Kpi, PageTitle, Pnl, StateBadge, Table, inputCls } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { ago, eur, short } from "@/lib/format";
import type { LearningSnapshot, PerformanceResponse } from "@/lib/types";

interface Risk { snapshot: { liveLevel: number; levelEligibility: { eligible: boolean; next: number | null; reasons: string[] } | null; levelStats: { netEur: number[]; attempts: number; failures: number; liveVsPaperBps: number | null }; liveGate: { state: string; stoppedReason: string | null }; sizeCap: { live: { capEur: number; binding: string } } } | null; settings: { risk: { liveLevel: number; liveLevelMaxTradeEur: number[] } } }
interface LiveTrade { id: string; ts_detected: string; live_level: number; size_eur: number; status: string; failure_reason: string | null; realized_net_eur: number | null; signature: string | null; via: string }

export default function Live() {
  const { status } = useShell();
  const { data: learning } = useApi<{ snapshot: LearningSnapshot | null }>("/api/learning", 15_000);
  const { data: risk, reload } = useApi<Risk>("/api/risk", 5_000);
  const { data: perf } = useApi<PerformanceResponse>("/api/live/performance", 10_000);
  const { data: trades } = useApi<LiveTrade[]>("/api/live/trades?limit=100", 10_000);
  const [phrase, setPhrase] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const gate = status?.liveGate.state ?? "LIVE_LOCKED";
  const snap = learning?.snapshot;
  const level = risk?.settings.risk.liveLevel ?? 1;
  const caps = risk?.settings.risk.liveLevelMaxTradeEur ?? [1, 2, 3, 5];
  const elig = risk?.snapshot?.levelEligibility;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setErr(null);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      setPassword("");
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const enable = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api("/api/live/enable", { method: "POST", body: { confirmation: phrase, password } }), "Live-Trading aktiviert (Level " + level + ").");
  };
  return (
    <div className="space-y-4">
      <PageTitle title="Live Trading" sub="LIVE_READY ist nur eine Empfehlung. Echtgeld erfordert: LIVE_MODE=true, bestandenes Live-Gate, Bot-Wallet, keine offenen Breaker, die Phrase „ENABLE LIVE TRADING“ und dein Passwort." right={<StateBadge state={gate} />} />
      <ErrorBox error={err} />
      {msg && <div className="rounded border border-good/50 bg-good/10 px-3 py-2 text-[12px] text-good">✓ {msg}</div>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi label="Live-Gate" value={gate.replace(/_/g, " ")} sub={status?.liveGate.stoppedReason ?? undefined} />
        <Kpi label="LIVE_MODE (Umgebung)" value={status?.liveSwitch ? "an" : "aus"} tone={status?.liveSwitch ? "warn" : null} />
        <Kpi label="Live-Level" value={`${level} / 4`} sub={`max. ${eur(caps[level - 1])} pro Trade`} />
        <Kpi label="Live realisiert" value={<Pnl v={perf?.stats?.net_eur ?? null} />} sub={`${perf?.stats?.trades ?? 0} Trades`} />
        <Kpi label="Wallet" value={status?.worker?.wallet.configured ? short(status.worker.wallet.address) : "keine"} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Validierungs-Gate (Paper → Live)">
          <Table head={["Prüfung", "Wert", "Anforderung", ""]} empty={!snap}>
            {(snap?.gate.checks ?? []).map((c) => (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td className="num">{c.value}</td>
                <td className="num text-mute">{c.required}</td>
                <td className={c.ok ? "text-good" : "text-crit"}>{c.ok ? "✓" : "✕"}</td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Live aktivieren / deaktivieren">
          {gate === "LIVE_ENABLED" ? (
            <div className="space-y-3">
              <div className="text-[12px] text-crit">● Echtgeld-Trading ist AKTIV (Level {level}).</div>
              <Button tone="danger" onClick={() => void run(() => api("/api/live/disable", { method: "POST" }), "Live deaktiviert — zurück zu PAPER.")}>Live deaktivieren</Button>
            </div>
          ) : (
            <form onSubmit={enable} className="space-y-3">
              <Field label="Bestätigungsphrase" hint='Exakt eintippen: ENABLE LIVE TRADING'>
                <input className={inputCls} value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" />
              </Field>
              <Field label="Passwort">
                <input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </Field>
              <Button type="submit" tone="danger" disabled={gate !== "LIVE_READY"}>Live-Trading aktivieren</Button>
              {gate !== "LIVE_READY" && <div className="text-[11px] text-mute">Gesperrt, bis das Validierungs-Gate bestanden ist.</div>}
            </form>
          )}
        </Card>
      </div>
      <Card title="Live-Levels (Erhöhung nur manuell, eine Stufe, mit Nachweis; Absenkung automatisch bei Verschlechterung)">
        <div className="mb-3 grid grid-cols-4 gap-2">
          {caps.map((c, i) => (
            <div key={i} className={`rounded border px-3 py-2 ${i + 1 === level ? "border-accent bg-accent/10" : "border-line"}`}>
              <div className="text-[11px] text-mute">Level {i + 1}</div>
              <div className="num">{eur(c)} / Trade</div>
            </div>
          ))}
        </div>
        <div className="text-[12px] text-ink2">{elig ? (elig.eligible ? `✓ Level ${elig.next} ist freigabefähig.` : `Level ${level + 1} noch nicht freigabefähig: ${elig.reasons.join(" · ")}`) : "Noch keine Live-Statistik."}</div>
        <div className="mt-2 flex gap-2">
          <Button disabled={!elig?.eligible || !password} onClick={() => void run(() => api("/api/live/level", { method: "POST", body: { level: level + 1, password } }), `Level ${level + 1} gesetzt.`)}>Level erhöhen (Passwort oben)</Button>
          <Button disabled={level <= 1} onClick={() => void run(() => api("/api/live/level", { method: "POST", body: { level: level - 1 } }), `Level ${level - 1} gesetzt.`)}>Level senken</Button>
        </div>
      </Card>
      <Card title="Live-Trades">
        <Table head={["Zeit", "Level", "Größe", "Weg", "Status", "Realisiert", "Signatur"]} empty={!trades?.length}>
          {(trades ?? []).map((t) => (
            <tr key={t.id}>
              <td className="num text-mute">{ago(t.ts_detected)}</td>
              <td className="num">{t.live_level}</td>
              <td className="num">{eur(t.size_eur)}</td>
              <td>{t.via}</td>
              <td title={t.failure_reason ?? undefined} className={t.status === "CONFIRMED" ? "text-good" : t.status === "FAILED" ? "text-crit" : "text-ink2"}>{t.status}</td>
              <td><Pnl v={t.realized_net_eur} digits={5} /></td>
              <td className="num">{t.signature ? <a className="text-accent hover:underline" href={`https://solscan.io/tx/${t.signature}`} target="_blank" rel="noreferrer noopener">{short(t.signature, 6)}</a> : "–"}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
