import { useQueryClient } from "@tanstack/react-query";
import { Lock, LockOpen, OctagonX, Pause, Play, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { Settings } from "@multbot/shared";
import { api } from "../api/client";
import { useApi } from "../api/hooks";
import type { Dashboard, PositionRow, TradeRow } from "../api/types";
import { PortfolioKpis, PositionsTable, TradesTable } from "../components/trades";
import { Badge, Button, Card, ConfirmPhrase, ErrorBox, HealthPill, KV, Notice, PageHeader, StatusBadge } from "../components/ui";
import { dateTime, sol } from "../lib/format";
import { SignalsTable, type SignalRow } from "./PaperTrading";

interface LiveStatus {
  state: string;
  unlockable: boolean;
  reasons: string[];
  validatedStrategies: { id: string; name: string; status: string }[];
}

interface Recon {
  state: string;
  issues: { severity: string; kind: string; message: string; tradeId?: string; mint?: string }[];
  lastRunAt: number | null;
}

export function LiveTradingPage() {
  const qc = useQueryClient();
  const status = useApi<LiveStatus>("live", "/api/live/status", 10_000);
  const dash = useApi<Dashboard>("dashboard", "/api/dashboard", 10_000);
  const settings = useApi<Settings>("settings", "/api/settings", 15_000);
  const positions = useApi<PositionRow[]>("live", "/api/live/positions", 5_000);
  const trades = useApi<TradeRow[]>("live", "/api/live/trades?limit=300", 10_000);
  const signals = useApi<SignalRow[]>("live", "/api/signals?mode=live&limit=100", 10_000);
  const recon = useApi<Recon>("live", "/api/reconciliation", 15_000);
  const [dialog, setDialog] = useState<null | "unlock" | "closeAll" | { close: PositionRow }>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (name: string, path: string, body?: unknown) => {
    setBusy(name);
    setErr(null);
    try {
      await api.post(path, body);
      await qc.invalidateQueries();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  const live = status.data?.state === "ACTIVE";
  const bot = dash.data?.bot;
  const risk = settings.data?.risk;

  return (
    <div className="space-y-4">
      <PageHeader title="Live Trading" subtitle="Echtgeld. Wird ausschließlich durch eine manuelle Aktion des Benutzers aktiviert." />

      <div className={live ? "rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-4" : "rounded-xl border border-line bg-surface p-4"}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className={live ? "grid h-10 w-10 place-items-center rounded-lg bg-emerald-500/20 text-emerald-300" : "grid h-10 w-10 place-items-center rounded-lg bg-surface-3 text-muted"}>
              {live ? <LockOpen size={20} /> : <Lock size={20} />}
            </div>
            <div>
              <div className="text-[16px] font-semibold tracking-tight">{live ? "REAL MONEY MODE ACTIVE" : "REAL MONEY MODE LOCKED"}</div>
              <div className="text-[12px] text-ink-2">
                {live
                  ? "Der Bot handelt mit echtem SOL — nur Strategien mit Status LIVE_ENABLED."
                  : "LIVE TRADING = MANUAL USER ACTION. Der Bot aktiviert Echtgeld niemals selbst."}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {live ? (
              <Button variant="default" onClick={() => run("lock", "/api/live/lock")} loading={busy === "lock"}>
                <Lock size={13} /> Echtgeld sperren
              </Button>
            ) : (
              <Button variant="success" disabled={!status.data?.unlockable} onClick={() => setDialog("unlock")} title={status.data?.unlockable ? undefined : "Voraussetzungen nicht erfüllt"}>
                <LockOpen size={13} /> ENABLE REAL TRADING
              </Button>
            )}
          </div>
        </div>
        {!live && (status.data?.reasons.length ?? 0) > 0 && (
          <div className="mt-3 space-y-1">
            <div className="text-[11px] text-muted">Freischaltung blockiert:</div>
            {status.data?.reasons.map((r) => (
              <div key={r} className="text-[12px] text-amber-200">
                · {r}
              </div>
            ))}
          </div>
        )}
      </div>
      {err !== null && <ErrorBox error={err} />}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Bot-Steuerung" subtitle="Manuelle Overrides">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-3">
              <HealthPill label="Bot" status={bot ? (bot.running ? "RUNNING" : "STOPPED") : "UNKNOWN"} />
              <HealthPill label="Einstiege" status={risk?.pauseEntries ? "PAUSED" : "ACTIVE"} />
              <HealthPill label="Ausstiege" status={risk?.pauseExits ? "PAUSED" : "ACTIVE"} />
            </div>
            <div className="flex flex-wrap gap-2">
              {bot?.running ? (
                <Button onClick={() => run("stop", "/api/bot/stop")} loading={busy === "stop"}>
                  <Pause size={13} /> Bot stoppen
                </Button>
              ) : (
                <Button variant="primary" onClick={() => run("start", "/api/bot/start")} loading={busy === "start"}>
                  <Play size={13} /> Bot starten
                </Button>
              )}
              <Button onClick={() => run("pe", "/api/bot/pause-entries", { paused: !risk?.pauseEntries })} loading={busy === "pe"}>
                {risk?.pauseEntries ? "Einstiege fortsetzen" : "Einstiege pausieren"}
              </Button>
              <Button onClick={() => run("px", "/api/bot/pause-exits", { paused: !risk?.pauseExits })} loading={busy === "px"}>
                {risk?.pauseExits ? "Ausstiege fortsetzen" : "Ausstiege pausieren"}
              </Button>
              <Button variant="danger" onClick={() => setDialog("closeAll")} disabled={(positions.data?.length ?? 0) === 0}>
                <OctagonX size={13} /> Alle schließen
              </Button>
            </div>
            <p className="text-[11px] text-muted">„Bot stoppen“ verhindert neue Live-Einstiege; laufende Positionen werden weiter nach ihren Exit-Regeln verwaltet.</p>
          </div>
        </Card>

        <Card title="Risiko-Limits" subtitle={<Link to="/settings" className="text-accent hover:underline">in Settings ändern</Link>}>
          <KV
            cols={1}
            items={[
              ["Positionsgröße", sol(settings.data?.trading.positionSizeSol ?? null, 4)],
              ["Max. offene Positionen", settings.data?.trading.maxOpenPositions ?? "—"],
              ["Max. Tagesverlust", sol(risk?.maxDailyLossSol ?? null, 4)],
              ["Max. Portfolio-Exposure", sol(risk?.maxPortfolioExposureSol ?? null, 4)],
              ["Max. je Token", sol(risk?.maxTokenExposureSol ?? null, 4)],
              ["Wallet-Reserve", sol(risk?.minWalletReserveSol ?? null, 4)],
              ["Max. Slippage", settings.data ? `${settings.data.trading.maxSlippageBps / 100}%` : "—"],
            ]}
          />
        </Card>

        <Card
          title="Reconciliation"
          subtitle={recon.data?.lastRunAt ? `zuletzt ${dateTime(recon.data.lastRunAt)}` : "Abgleich DB ↔ Blockchain"}
          actions={
            <Button size="xs" onClick={() => run("recon", "/api/reconciliation/run")} loading={busy === "recon"}>
              <RefreshCw size={12} /> Prüfen
            </Button>
          }
        >
          <div className="space-y-2">
            <HealthPill label="Status" status={recon.data?.state ?? "UNKNOWN"} />
            {recon.data?.state === "REQUIRED" && <Notice tone="warn">RECONCILIATION REQUIRED — Live Trading ist gestoppt, bis die Abweichungen geprüft sind.</Notice>}
            {(recon.data?.issues ?? []).map((i, k) => (
              <div key={k} className="rounded-md bg-surface-2 px-2.5 py-1.5 text-[11.5px]">
                <Badge status={i.severity === "critical" ? "FAILED" : "DEGRADED"}>{i.severity}</Badge> <span className="text-ink-2">{i.message}</span>
              </div>
            ))}
            {recon.data?.state === "REQUIRED" && (
              <Button size="xs" onClick={() => run("ack", "/api/reconciliation/acknowledge")} loading={busy === "ack"}>
                Geprüft — bestätigen
              </Button>
            )}
          </div>
        </Card>
      </div>

      <PortfolioKpis p={dash.data?.live} />

      <Card dense title="Offene Live-Positionen" subtitle="Bewertet zum Liquidationswert (Verkaufsquote inkl. Gebühr)">
        <PositionsTable rows={positions.data} mode="live" onClose={(p) => setDialog({ close: p })} />
      </Card>
      <Card dense title="Live Trades">
        <TradesTable rows={trades.data} mode="live" />
      </Card>
      <Card dense title="Live-Signale">
        <SignalsTable rows={signals.data} />
      </Card>
      {(status.data?.validatedStrategies.length ?? 0) > 0 && (
        <Card title="Validierte Strategien" subtitle="Empfehlungen aus Paper Trading — Freigabe je Strategie im Strategy Lab">
          <div className="flex flex-wrap gap-2">
            {status.data?.validatedStrategies.map((s) => (
              <Link key={s.id} to={`/strategy-lab/${s.id}`} className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-[12px] hover:bg-surface-3">
                <span className="num text-muted">{s.id}</span>
                {s.name}
                <StatusBadge status={s.status} />
              </Link>
            ))}
          </div>
        </Card>
      )}

      <ConfirmPhrase
        open={dialog === "unlock"}
        onClose={() => setDialog(null)}
        title="ENABLE REAL TRADING"
        phrase="ENABLE REAL TRADING"
        danger
        description={
          <div className="space-y-3">
            <p>Aktiviert den Echtgeld-Modus. Gehandelt werden nur Strategien, die du einzeln mit „ENABLE REAL TRADING“ freigegeben hast (Status LIVE_ENABLED).</p>
            <Notice tone="warn">Keine Strategie ist garantiert profitabel. Memecoin-Handel kann zum Totalverlust des eingesetzten Kapitals führen.</Notice>
          </div>
        }
        onConfirm={async () => {
          await api.post("/api/live/unlock", { confirm: "ENABLE REAL TRADING" });
          await qc.invalidateQueries();
        }}
      />
      <ConfirmPhrase
        open={dialog === "closeAll"}
        onClose={() => setDialog(null)}
        title="Alle Live-Positionen schließen"
        phrase="CLOSE ALL"
        danger
        description={<p>Verkauft alle offenen Live-Positionen sofort zum Marktpreis (mit Slippage-Limit und Simulation vor dem Senden).</p>}
        onConfirm={async () => {
          await api.post("/api/live/positions/close-all", { confirm: "CLOSE ALL" });
          await qc.invalidateQueries();
        }}
      />
      <ConfirmPhrase
        open={typeof dialog === "object" && dialog !== null}
        onClose={() => setDialog(null)}
        title="Position schließen"
        phrase="CLOSE"
        danger
        description={
          typeof dialog === "object" && dialog !== null ? (
            <p>
              Verkauft <b className="text-ink">{dialog.close.symbol ?? dialog.close.mint}</b> (Wert ca. {sol(dialog.close.valueSol, 5)}).
            </p>
          ) : null
        }
        onConfirm={async () => {
          if (typeof dialog === "object" && dialog !== null) await api.post(`/api/live/positions/${dialog.close.id}/close`);
          await qc.invalidateQueries();
        }}
      />
    </div>
  );
}
