"use client";
import { useEffect, useState } from "react";
import { useShell } from "@/components/shell";
import { Button, Card, ErrorBox, Field, PageTitle, Table, inputCls, inputNarrow } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { ago, time } from "@/lib/format";

type Settings = Record<string, Record<string, unknown>>;
const SECTIONS: [string, string][] = [
  ["capital", "Kapital"],
  ["risk", "Risiko (Erhöhungen nur mit Passwort)"],
  ["strategy", "Strategie (Schwellen; der Optimizer darf nur verschärfen)"],
  ["scanner", "Scanner"],
  ["paper", "Paper"],
  ["learning", "Learning / Live-Gate"],
];
const LOCKED = new Set(["risk.liveLevel", "risk.emergencyStop"]);

function parse(orig: unknown, text: string): unknown {
  if (typeof orig === "number") return Number(text);
  if (typeof orig === "boolean") return text === "true";
  if (Array.isArray(orig)) {
    const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
    return typeof orig[0] === "number" || (orig.length === 0 && parts.every((p) => /^[\d.]+$/.test(p))) ? parts.map(Number) : parts;
  }
  return text;
}

export default function SettingsPage() {
  const { status } = useShell();
  const { data, reload } = useApi<{ settings: Settings; audit: { id: number; ts: string; actor: string }[] }>("/api/settings", 0);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => setDraft({}), [data]);
  const w = status?.worker;

  const save = async () => {
    if (!data) return;
    const patch: Settings = {};
    for (const [k, v] of Object.entries(draft)) {
      const [sec, key] = k.split(".") as [string, string];
      const orig = data.settings[sec]?.[key];
      patch[sec] = { ...(patch[sec] ?? {}), [key]: parse(orig, v) };
    }
    setErr(null);
    setMsg(null);
    try {
      await api("/api/settings", { method: "PUT", body: { patch, password: password || undefined } });
      setMsg("Gespeichert (mit Audit-Eintrag).");
      setPassword("");
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const act = (path: string, body?: unknown) => api(path, { method: "POST", body }).then(() => setMsg("OK")).catch((e: Error) => setErr(e.message));

  return (
    <div className="space-y-4">
      <PageTitle title="Settings" sub="Alle Änderungen werden validiert und im Audit-Log gespeichert. Geheimnisse (RPC-Keys, Passphrase) stehen nur in der Umgebung, nie hier." />
      <ErrorBox error={err} />
      {msg && <div className="rounded border border-good/50 bg-good/10 px-3 py-2 text-[12px] text-good">✓ {msg}</div>}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Bot">
          <div className="flex flex-wrap gap-2">
            <Button tone="primary" onClick={() => void act("/api/bot/start")}>Start (Paper)</Button>
            <Button onClick={() => void act("/api/bot/stop", { reason: "pausiert im Dashboard" })}>Pause</Button>
          </div>
          <div className="mt-3 text-[11px] text-mute">Start führt immer in PAPER (oder SHADOW). Echtgeld nur über „Live Trading“.</div>
        </Card>
        <Card title="Startsequenz" className="xl:col-span-2">
          <Table head={["Schritt", "Ergebnis", ""]} empty={!status?.startup?.steps.length}>
            {(status?.startup?.steps ?? []).map((s) => (
              <tr key={s.step}>
                <td>{s.step}</td>
                <td className="text-ink2">{s.detail}</td>
                <td className={s.ok ? "text-good" : "text-crit"}>{s.ok ? "✓" : "✕"}</td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
      <Card title="Circuit Breaker">
        <Table head={["Breaker", "Status", "seit", "Grund", "nur Live", ""]} empty={!w?.breakers.length}>
          {(w?.breakers ?? []).map((b) => (
            <tr key={b.id}>
              <td>{b.id}</td>
              <td className={b.open ? "text-crit" : "text-good"}>{b.open ? "✕ offen" : "✓ geschlossen"}</td>
              <td className="num text-mute">{b.since ? ago(b.since) : "–"}</td>
              <td className="text-ink2">{b.reason ?? ""}</td>
              <td>{b.liveOnly ? "ja" : "–"}</td>
              <td>{b.open && <Button onClick={() => void act(`/api/breakers/${b.id}/reset`)}>Zurücksetzen</Button>}</td>
            </tr>
          ))}
        </Table>
      </Card>
      {data &&
        SECTIONS.map(([sec, title]) => (
          <Card key={sec} title={title}>
            <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-4">
              {Object.entries(data.settings[sec] ?? {}).map(([key, val]) => {
                const id = `${sec}.${key}`;
                const locked = LOCKED.has(id);
                const shown = draft[id] ?? (Array.isArray(val) ? val.join(", ") : String(val));
                return (
                  <Field key={id} label={key} hint={locked ? "über Live Trading / Emergency Stop" : undefined}>
                    {typeof val === "boolean" ? (
                      <select disabled={locked} className={inputCls} value={shown} onChange={(e) => setDraft({ ...draft, [id]: e.target.value })}>
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    ) : (
                      <input disabled={locked} className={`${inputCls} num ${draft[id] !== undefined ? "border-warn" : ""}`} value={shown} onChange={(e) => setDraft({ ...draft, [id]: e.target.value })} />
                    )}
                  </Field>
                );
              })}
            </div>
          </Card>
        ))}
      <Card title="Speichern">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Passwort (nötig, wenn ein Risikolimit erhöht wird)">
            <input className={`${inputNarrow} w-64`} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button tone="primary" disabled={Object.keys(draft).length === 0} onClick={() => void save()}>{Object.keys(draft).length} Änderung(en) speichern</Button>
          <Button disabled={Object.keys(draft).length === 0} onClick={() => setDraft({})}>Verwerfen</Button>
        </div>
        <div className="mt-3 text-[11px] text-mute">Letzte Änderungen: {(data?.audit ?? []).slice(0, 5).map((a) => `${time(a.ts)} (${a.actor})`).join(" · ")}</div>
      </Card>
    </div>
  );
}
