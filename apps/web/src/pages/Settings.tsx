import { useQueryClient } from "@tanstack/react-query";
import { Save, Undo2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { Settings, SystemHealthDto } from "@multbot/shared";
import { api } from "../api/client";
import { useApi } from "../api/hooks";
import { useStream } from "../components/Layout";
import { Badge, Button, Card, ErrorBox, HealthPill, Notice, PageHeader, Table, Tabs, Toggle } from "../components/ui";
import { dateTime } from "../lib/format";

type Tab = "trading" | "risk" | "research" | "system" | "audit";
const DAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-line/50 py-2.5 md:grid-cols-[260px_1fr] md:items-center md:gap-4">
      <div>
        <div className="text-[12.5px] text-ink">{label}</div>
        {hint && <div className="text-[11px] text-muted">{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Num({ value, onChange, step = "any", unit, min, max }: { value: number; onChange: (v: number) => void; step?: string; unit?: string; min?: number; max?: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <div className="flex items-center gap-2">
      <input
        value={text}
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value.replace(",", "."));
          if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange(n);
        }}
        className="num h-7 w-36 rounded-lg border border-line-strong bg-surface-2 px-2 text-[12px] outline-none focus:border-accent"
      />
      {unit && <span className="text-[11px] text-muted">{unit}</span>}
    </div>
  );
}

function Select<T extends string>({ value, options, onChange }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)} className="h-7 rounded-lg border border-line-strong bg-surface-2 px-2 text-[12px]">
      {options.map((o) => (
        <option key={o.v} value={o.v}>
          {o.l}
        </option>
      ))}
    </select>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("trading");
  const q = useApi<Settings>("settings", "/api/settings");
  const [draft, setDraft] = useState<Settings | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data && !draft) setDraft(structuredClone(q.data));
  }, [q.data, draft]);
  const dirty = draft !== null && q.data !== undefined && JSON.stringify(draft) !== JSON.stringify(q.data);

  const setT = <K extends keyof Settings["trading"]>(k: K, v: Settings["trading"][K]) => draft && setDraft({ ...draft, trading: { ...draft.trading, [k]: v } });
  const setR = <K extends keyof Settings["risk"]>(k: K, v: Settings["risk"][K]) => draft && setDraft({ ...draft, risk: { ...draft.risk, [k]: v } });
  const setS = <K extends keyof Settings["research"]>(k: K, v: Settings["research"][K]) => draft && setDraft({ ...draft, research: { ...draft.research, [k]: v } });

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setErr(null);
    try {
      const next = await api.put<Settings>("/api/settings", draft);
      qc.setQueryData(["settings", "/api/settings"], next);
      setDraft(structuredClone(next));
      await qc.invalidateQueries();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Settings"
        subtitle="Alle Parameter sind hier sichtbar und änderbar. Jede Änderung wird serverseitig geprüft und im Audit-Log gespeichert."
        actions={
          <>
            <Tabs<Tab>
              value={tab}
              onChange={setTab}
              tabs={[
                { key: "trading", label: "Trading" },
                { key: "risk", label: "Risiko" },
                { key: "research", label: "Research" },
                { key: "system", label: "System" },
                { key: "audit", label: "Audit" },
              ]}
            />
            {tab !== "system" && tab !== "audit" && (
              <>
                <Button variant="ghost" disabled={!dirty} onClick={() => q.data && setDraft(structuredClone(q.data))}>
                  <Undo2 size={13} /> Verwerfen
                </Button>
                <Button variant="primary" disabled={!dirty} loading={busy} onClick={save}>
                  <Save size={13} /> Speichern
                </Button>
              </>
            )}
          </>
        }
      />
      {err !== null && <ErrorBox error={err} />}
      {saved && <Notice>Gespeichert.</Notice>}
      {!draft && tab !== "system" && tab !== "audit" && <div className="text-muted">Lade…</div>}

      {draft && tab === "trading" && (
        <Card title="Trading" subtitle="Positionsgröße und Ausführung (Live und Paper getrennt)">
          <Field label="Positionsgröße Live" hint="SOL je Trade vor Gebühren. Kosten werden zusätzlich berechnet und geprüft.">
            <Num value={draft.trading.positionSizeSol} onChange={(v) => setT("positionSizeSol", v)} unit="SOL" />
          </Field>
          <Field label="Max. offene Live-Positionen">
            <Num value={draft.trading.maxOpenPositions} onChange={(v) => setT("maxOpenPositions", Math.round(v))} />
          </Field>
          <Field label="Max. Slippage" hint="Harte Grenze für jede Order">
            <Num value={draft.trading.maxSlippageBps} onChange={(v) => setT("maxSlippageBps", Math.round(v))} unit={`bps (${(draft.trading.maxSlippageBps / 100).toFixed(1)}%)`} />
          </Field>
          <Field label="Priority Fee Modus">
            <Select value={draft.trading.priorityFeeMode} onChange={(v) => setT("priorityFeeMode", v)} options={[{ v: "auto", l: "Automatisch (Helius-Schätzung)" }, { v: "manual", l: "Manuell" }]} />
          </Field>
          {draft.trading.priorityFeeMode === "manual" && (
            <Field label="Manuelle Priority Fee">
              <Num value={draft.trading.manualPriorityFeeMicroLamports} onChange={(v) => setT("manualPriorityFeeMicroLamports", Math.round(v))} unit="µLamports / CU" />
            </Field>
          )}
          <Field label="Max. Priority Fee je Transaktion">
            <Num value={draft.trading.maxPriorityFeeSol} onChange={(v) => setT("maxPriorityFeeSol", v)} unit="SOL" />
          </Field>
          <Field label="Ausführungs-Provider">
            <Select value={draft.trading.executionProvider} onChange={(v) => setT("executionProvider", v)} options={[{ v: "jupiter", l: "Jupiter" }, { v: "pumpportal", l: "PumpPortal" }]} />
          </Field>
          <Field label="Strategie-Auswahl" hint="auto: alle LIVE_ENABLED-Strategien; manuell: nur erlaubte Liste (Risiko)">
            <Select value={draft.trading.strategySelection} onChange={(v) => setT("strategySelection", v)} options={[{ v: "auto", l: "Automatisch" }, { v: "manual", l: "Manuell" }]} />
          </Field>
          <div className="mt-4 mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Paper Trading</div>
          <Field label="Paper Trading aktiv">
            <Toggle checked={draft.trading.paperTradingEnabled} onChange={(v) => setT("paperTradingEnabled", v)} />
          </Field>
          <Field label="Virtuelles Kapital">
            <Num value={draft.trading.paperCapitalSol} onChange={(v) => setT("paperCapitalSol", v)} unit="SOL" />
          </Field>
          <Field label="Paper-Positionsgröße">
            <Num value={draft.trading.paperPositionSizeSol} onChange={(v) => setT("paperPositionSizeSol", v)} unit="SOL" />
          </Field>
          <Field label="Max. Paper-Positionen je Strategie">
            <Num value={draft.trading.paperMaxOpenPositionsPerStrategy} onChange={(v) => setT("paperMaxOpenPositionsPerStrategy", Math.round(v))} />
          </Field>
        </Card>
      )}

      {draft && tab === "risk" && (
        <div className="space-y-4">
          <Notice>
            Technische Integritätsprüfungen (Adress-, Netzwerk- und Mint-Validierung, Programm-Allowlist, Simulation, Kosten- und Guthabenprüfung, Reconciliation) sind
            unabhängig von diesen Einstellungen immer aktiv.
          </Notice>
          <Card title="Risiko-Limits (Live)">
            <Field label="Max. Tagesverlust" hint="Neue Einstiege stoppen, wenn der realisierte + unrealisierte Tagesverlust erreicht ist">
              <Num value={draft.risk.maxDailyLossSol} onChange={(v) => setR("maxDailyLossSol", v)} unit="SOL" />
            </Field>
            <Field label="Max. Portfolio-Exposure">
              <Num value={draft.risk.maxPortfolioExposureSol} onChange={(v) => setR("maxPortfolioExposureSol", v)} unit="SOL" />
            </Field>
            <Field label="Max. Exposure je Token">
              <Num value={draft.risk.maxTokenExposureSol} onChange={(v) => setR("maxTokenExposureSol", v)} unit="SOL" />
            </Field>
            <Field label="Mindest-Reserve in der Wallet" hint="Für Gebühren, Rent und Notfall-Exits">
              <Num value={draft.risk.minWalletReserveSol} onChange={(v) => setR("minWalletReserveSol", v)} unit="SOL" />
            </Field>
            <Field label="Max. Datenalter" hint="Kein Einstieg mit veralteten Marktdaten">
              <Num value={draft.risk.maxDataStalenessSec} onChange={(v) => setR("maxDataStalenessSec", Math.round(v))} unit="s" />
            </Field>
          </Card>
          <Card title="Steuerung">
            <Field label="Einstiege pausieren">
              <Toggle checked={draft.risk.pauseEntries} onChange={(v) => setR("pauseEntries", v)} />
            </Field>
            <Field label="Automatische Ausstiege pausieren" hint="Achtung: Positionen werden dann nur noch manuell geschlossen">
              <Toggle checked={draft.risk.pauseExits} onChange={(v) => setR("pauseExits", v)} />
            </Field>
            <Field label="Emergency Stop aktiv">
              <Toggle checked={draft.risk.emergencyStop} onChange={(v) => setR("emergencyStop", v)} />
            </Field>
            <Field label="Bei Emergency Stop Positionen schließen" hint="aus: Positionen bleiben offen und werden weiter verwaltet">
              <Toggle checked={draft.risk.emergencyStopClosePositions} onChange={(v) => setR("emergencyStopClosePositions", v)} />
            </Field>
          </Card>
          <Card title="Handelszeiten (UTC)">
            <Field label="Handelszeiten aktiv">
              <Toggle checked={draft.risk.tradingHours.enabled} onChange={(v) => setR("tradingHours", { ...draft.risk.tradingHours, enabled: v })} />
            </Field>
            <Field label="Von / Bis">
              <div className="flex items-center gap-2">
                <input type="time" value={draft.risk.tradingHours.startUtc} onChange={(e) => setR("tradingHours", { ...draft.risk.tradingHours, startUtc: e.target.value })} className="num h-7 rounded-lg border border-line-strong bg-surface-2 px-2 text-[12px]" />
                <span className="text-muted">–</span>
                <input type="time" value={draft.risk.tradingHours.endUtc} onChange={(e) => setR("tradingHours", { ...draft.risk.tradingHours, endUtc: e.target.value })} className="num h-7 rounded-lg border border-line-strong bg-surface-2 px-2 text-[12px]" />
              </div>
            </Field>
            <Field label="Tage">
              <div className="flex gap-1">
                {DAYS.map((d, i) => {
                  const on = draft.risk.tradingHours.days.includes(i);
                  return (
                    <button
                      key={d}
                      onClick={() => setR("tradingHours", { ...draft.risk.tradingHours, days: on ? draft.risk.tradingHours.days.filter((x) => x !== i) : [...draft.risk.tradingHours.days, i].sort() })}
                      className={on ? "h-7 w-8 rounded-md bg-accent/25 text-[11px] text-ink" : "h-7 w-8 rounded-md bg-surface-2 text-[11px] text-muted"}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            </Field>
          </Card>
          <Card title="Erlaubte Strategien" subtitle="Leer = alle für Echtgeld freigegebenen Strategien">
            <Field label="Strategie-IDs" hint="Kommagetrennt, z. B. S-000012, S-000031">
              <input
                value={draft.risk.allowedStrategyIds.join(", ")}
                onChange={(e) => setR("allowedStrategyIds", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
                className="num h-7 w-full max-w-lg rounded-lg border border-line-strong bg-surface-2 px-2 text-[12px]"
              />
            </Field>
            <Field label="Versions-IDs" hint="z. B. S-000012@1.1">
              <input
                value={draft.risk.allowedStrategyVersionIds.join(", ")}
                onChange={(e) => setR("allowedStrategyVersionIds", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
                className="num h-7 w-full max-w-lg rounded-lg border border-line-strong bg-surface-2 px-2 text-[12px]"
              />
            </Field>
          </Card>
        </div>
      )}

      {draft && tab === "research" && (
        <div className="space-y-4">
          <Card title="Kostenmodell für Backtests & Paper" subtitle="Konservativ wählen — lieber Kosten überschätzen">
            <Field label="Ausführungsverzögerung">
              <Num value={draft.research.executionDelayMs} onChange={(v) => setS("executionDelayMs", Math.round(v))} unit="ms" />
            </Field>
            <Field label="Fehlerrate Transaktionen">
              <Num value={draft.research.failedTxRate} onChange={(v) => setS("failedTxRate", v)} unit="Anteil (0–0,9)" />
            </Field>
            <Field label="Angenommene Priority Fee">
              <Num value={draft.research.assumedPriorityFeeSol} onChange={(v) => setS("assumedPriorityFeeSol", v)} unit="SOL" />
            </Field>
            <Field label="MEV-/Latenz-Aufschlag">
              <Num value={draft.research.mevImpactBps} onChange={(v) => setS("mevImpactBps", Math.round(v))} unit="bps" />
            </Field>
          </Card>
          <Card title="Discovery & Statistik">
            <Field label="Mindest-Stichprobe">
              <Num value={draft.research.minSampleSize} onChange={(v) => setS("minSampleSize", Math.round(v))} />
            </Field>
            <Field label="False Discovery Rate (α)" hint="Benjamini–Hochberg über alle getesteten Hypothesen">
              <Num value={draft.research.fdrAlpha} onChange={(v) => setS("fdrAlpha", v)} />
            </Field>
            <Field label="Walk-Forward-Folds">
              <Num value={draft.research.walkForwardFolds} onChange={(v) => setS("walkForwardFolds", Math.round(v))} />
            </Field>
            <Field label="Max. Bedingungen je Rezept">
              <Num value={draft.research.maxConditionsPerRecipe} onChange={(v) => setS("maxConditionsPerRecipe", Math.round(v))} />
            </Field>
            <Field label="Max. Hypothesen je Lauf">
              <Num value={draft.research.maxHypothesesPerRun} onChange={(v) => setS("maxHypothesesPerRun", Math.round(v))} />
            </Field>
            <Field label="Discovery-Intervall" hint="0 = nur manuell">
              <Num value={draft.research.discoveryIntervalMin} onChange={(v) => setS("discoveryIntervalMin", Math.round(v))} unit="min" />
            </Field>
            <Field label="Evolutions-Intervall" hint="Suche nach besseren Varianten bestehender Strategien; 0 = aus">
              <Num value={draft.research.evolutionIntervalMin} onChange={(v) => setS("evolutionIntervalMin", Math.round(v))} unit="min" />
            </Field>
            <Field label="Mindest-Trades für Herausforderer" hint="Paper Trades, bevor eine neue Version mit der aktuellen verglichen wird">
              <Num value={draft.research.challengerMinTrades} onChange={(v) => setS("challengerMinTrades", Math.round(v))} unit="Trades" />
            </Field>
            <Field label="Decay-Fenster">
              <Num value={draft.research.decayWindowTrades} onChange={(v) => setS("decayWindowTrades", Math.round(v))} unit="Trades" />
            </Field>
          </Card>
          <Card title="Paper-Validierung" subtitle="Kriterien für PAPER_VALIDATED — nur eine Empfehlung, Echtgeld bleibt manuell">
            <Field label="Min. Trades">
              <Num value={draft.research.paperValidation.minTrades} onChange={(v) => setS("paperValidation", { ...draft.research.paperValidation, minTrades: Math.round(v) })} />
            </Field>
            <Field label="Min. Profit Factor">
              <Num value={draft.research.paperValidation.minProfitFactor} onChange={(v) => setS("paperValidation", { ...draft.research.paperValidation, minProfitFactor: v })} />
            </Field>
            <Field label="Min. Konfidenz E>0">
              <Num value={draft.research.paperValidation.minConfidence} onChange={(v) => setS("paperValidation", { ...draft.research.paperValidation, minConfidence: v })} />
            </Field>
            <Field label="Max. Drawdown">
              <Num value={draft.research.paperValidation.maxDrawdownSol} onChange={(v) => setS("paperValidation", { ...draft.research.paperValidation, maxDrawdownSol: v })} unit="SOL" />
            </Field>
          </Card>
          <Card title="Datenaufbewahrung" subtitle="Ältere Tagespartitionen werden gelöscht">
            {(["rawTradesDays", "researchSamplesDays", "snapshotsDays", "eventsDays"] as const).map((k) => (
              <Field key={k} label={{ rawTradesDays: "Rohe Trades", researchSamplesDays: "Research-Samples", snapshotsDays: "Snapshots", eventsDays: "Events" }[k]}>
                <Num value={draft.research.retention[k]} onChange={(v) => setS("retention", { ...draft.research.retention, [k]: Math.round(v) })} unit="Tage" />
              </Field>
            ))}
          </Card>
        </div>
      )}

      {tab === "system" && <SystemTab />}
      {tab === "audit" && <AuditTab />}
    </div>
  );
}

function SystemTab() {
  const { health } = useStream();
  const q = useApi<SystemHealthDto>("health", "/api/health", 10_000);
  const h = health ?? q.data;
  if (!h) return <div className="text-muted">Lade…</div>;
  return (
    <div className="space-y-4">
      <Card title="Komponenten">
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <HealthPill label="RPC" status={h.rpc} />
          <HealthPill label="Datenfeed" status={h.dataFeed} />
          <HealthPill label="Datenbank" status={h.database} />
          <HealthPill label="Wallet" status={h.wallet} />
          <HealthPill label="Trading Engine" status={h.tradingEngine} />
          <HealthPill label="Paper Engine" status={h.paperEngine} />
          <HealthPill label="Live Trading" status={h.liveTrading} />
          <HealthPill label="Reconciliation" status={h.reconciliation} />
        </div>
        <div className="mt-3 text-[11.5px] text-ink-2">
          Datenaufnahme: {h.ingest.eventsPerMinute.toFixed(0)} Ereignisse/min · letzter Eintrag {dateTime(h.ingest.lastEventAt)} · Dekodierfehler {h.ingest.decodeErrors}
        </div>
      </Card>
      <Card dense title="RPC-Endpunkte" subtitle="Failover, Latenz und Slot-Abstand">
        <Table
          rows={h.rpcEndpoints}
          rowKey={(e) => e.name}
          columns={[
            { key: "n", header: "Endpunkt", cell: (e) => <span className="text-ink">{e.name}</span> },
            { key: "k", header: "Art", cell: (e) => <Badge>{e.kind}</Badge> },
            { key: "s", header: "Status", cell: (e) => <HealthPill label="" status={e.status} /> },
            { key: "l", header: "Latenz", align: "right", cell: (e) => <span className="num">{e.latencyMs !== null ? `${e.latencyMs.toFixed(0)} ms` : "—"}</span> },
            { key: "sl", header: "Slot", align: "right", cell: (e) => <span className="num text-ink-2">{e.slot ?? "—"}</span> },
            { key: "lag", header: "Slot-Lag", align: "right", cell: (e) => <span className="num text-ink-2">{e.slotLag ?? "—"}</span> },
            { key: "ws", header: "WebSocket", align: "center", cell: (e) => (e.wsConnected ? "●" : "") },
            { key: "er", header: "Fehlerrate", align: "right", cell: (e) => <span className="num text-ink-2">{(e.errorRate * 100).toFixed(1)}%</span> },
            { key: "rq", header: "Requests", align: "right", cell: (e) => <span className="num text-ink-2">{e.requests}</span> },
          ]}
        />
      </Card>
      <Card dense title="Module" subtitle="Supervisor: jedes Modul wird überwacht und bei Fehlern mit Backoff neu gestartet">
        <Table
          rows={h.modules}
          rowKey={(m) => m.name}
          columns={[
            { key: "n", header: "Modul", cell: (m) => <span className="text-ink">{m.name}</span> },
            { key: "s", header: "Zustand", cell: (m) => <HealthPill label="" status={m.status} /> },
            { key: "st", header: "Engine", cell: (m) => <span className="text-ink-2">{m.state}</span> },
            { key: "d", header: "Detail", cell: (m) => <span className="block max-w-[420px] truncate text-ink-2">{m.detail ?? ""}</span> },
            { key: "e", header: "Letzter Fehler", cell: (m) => <span className="block max-w-[320px] truncate text-rose-300" title={m.lastError ?? ""}>{m.lastError ?? ""}</span> },
          ]}
        />
      </Card>
    </div>
  );
}

function AuditTab() {
  const q = useApi<{ id: number; ts: string; actor: string; old_value: unknown; new_value: unknown }[]>("settings", "/api/settings/audit");
  return (
    <Card dense title="Änderungsprotokoll">
      <Table
        rows={q.data}
        rowKey={(r) => String(r.id)}
        maxHeight={720}
        empty="Keine Änderungen"
        columns={[
          { key: "t", header: "Zeit", cell: (r) => <span className="num text-ink-2">{dateTime(r.ts)}</span> },
          { key: "a", header: "Von", cell: (r) => <span className="text-ink">{r.actor}</span> },
          { key: "d", header: "Änderung", cell: (r) => <span className="num block max-w-[760px] whitespace-normal break-all text-[11px] text-ink-2">{diff(r.old_value, r.new_value).join(" · ") || "—"}</span> },
        ]}
      />
    </Card>
  );
}

function diff(a: unknown, b: unknown, path = ""): string[] {
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null && !Array.isArray(a)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`];
}
