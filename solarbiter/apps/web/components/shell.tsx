"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, useApi, useEvents, type RealtimeEvent } from "@/lib/api";
import { ago, eur, ms } from "@/lib/format";
import { Button, StateBadge, Status, inputCls } from "./ui";

export interface StatusResponse {
  botState: string;
  workerOnline: boolean;
  heartbeatAgeMs: number | null;
  liveSwitch: boolean;
  paperSwitch: boolean;
  liveGate: { state: string; stoppedReason: string | null; enabledAt: number | null; enabledBy: string | null };
  startup: { steps: { step: string; ok: boolean; detail: string }[]; ready: boolean; notReadyReasons: string[] } | null;
  api: { database: string; redis: string };
  worker: {
    ready: boolean;
    notReadyReasons: string[];
    shadow: boolean;
    components: { name: string; status: string; detail?: string; lastError?: string | null }[];
    breakers: { id: string; open: boolean; since: number | null; reason: string | null; liveOnly: boolean }[];
    solEur: number | null;
    slot: number | null;
    quoteBudget: { rps: number; used1m: number; limit1m: number };
    scanner: { pools: number; tokens: number; lastScanAt: number | null; candidates1m: number; screened1m: number };
    learning: { score: number; status: string };
    wallet: { configured: boolean; address: string | null; balanceLamports: string | null };
    metrics: { cpuPct: number; rssMb: number; eventLoopLagMs: number };
  } | null;
}

interface ShellCtx {
  status: StatusResponse | null;
  lastEvents: RealtimeEvent[];
  wsConnected: boolean;
}
const Ctx = createContext<ShellCtx>({ status: null, lastEvents: [], wsConnected: false });
export const useShell = () => useContext(Ctx);

const NAV: [string, string][] = [
  ["/", "Dashboard"],
  ["/markets", "Markets"],
  ["/arbitrage", "Arbitrage"],
  ["/opportunities", "Opportunities"],
  ["/paper", "Paper Trading"],
  ["/live", "Live Trading"],
  ["/positions", "Positions"],
  ["/orders", "Orders"],
  ["/portfolio", "Portfolio"],
  ["/watchlist", "Watchlist"],
  ["/performance", "Performance"],
  ["/learning", "Learning"],
  ["/tax", "Tax"],
  ["/logs", "Logs"],
  ["/settings", "Settings"],
];

function Login({ setupRequired, onDone }: { setupRequired: boolean; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("/api/auth/login", { method: "POST", body: { username, password } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="flex min-h-screen items-center justify-center">
      <form onSubmit={submit} className="w-80 space-y-3 rounded-md border border-line bg-s1 p-5">
        <div className="text-lg font-semibold tracking-wide">SOLARBITER</div>
        <div className="text-[12px] text-mute">Solana Multi-DEX Arbitrage Terminal</div>
        {setupRequired && (
          <div className="rounded border border-warn/50 bg-warn/10 p-2 text-[12px] text-warn">
            Noch kein Benutzer angelegt. Im Projekt ausführen: <code className="num">pnpm user:create admin</code>
          </div>
        )}
        <input className={inputCls} placeholder="Benutzer" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input className={inputCls} placeholder="Passwort" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="text-[12px] text-crit">⚠ {error}</div>}
        <Button type="submit" tone="primary">
          Anmelden
        </Button>
      </form>
    </div>
  );
}

function EmergencyStop({ state }: { state: string }) {
  const [busy, setBusy] = useState(false);
  const active = state === "EMERGENCY_STOP";
  const stop = async () => {
    if (!window.confirm("EMERGENCY STOP: keine neuen Trades, Live wird deaktiviert, Logs und Zustand bleiben erhalten. Fortfahren?")) return;
    setBusy(true);
    try {
      await api("/api/emergency-stop", { method: "POST", body: { reason: "Emergency Stop im Dashboard" } });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      onClick={stop}
      disabled={busy || active}
      className="rounded border border-crit bg-crit px-3 py-1.5 text-[12px] font-bold tracking-wide text-white hover:brightness-110 disabled:opacity-60"
      title="Stoppt sofort alle neuen Trades und sperrt Live-Trading"
    >
      ■ {active ? "NOTSTOPP AKTIV" : "EMERGENCY STOP"}
    </button>
  );
}

function TopBar({ s, ws }: { s: StatusResponse | null; ws: boolean }) {
  const w = s?.worker;
  const comp = (name: string) => w?.components.find((c) => c.name === name);
  const openBreakers = w?.breakers.filter((b) => b.open) ?? [];
  return (
    <header className="sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-bg/95 px-4 py-2 backdrop-blur">
      <StateBadge state={s?.botState ?? "OFFLINE"} />
      <StateBadge state={s?.liveGate.state ?? "LIVE_LOCKED"} />
      {!s?.liveSwitch && <span className="text-[11px] text-mute" title="LIVE_MODE=false: Echtgeld technisch unmöglich">LIVE_MODE aus</span>}
      <div className="flex flex-wrap items-center gap-3">
        <Status label="RPC" status={comp("solana_rpc")?.status ?? "UNKNOWN"} title={comp("solana_rpc")?.detail} />
        <Status label="Jupiter" status={comp("jupiter")?.status ?? "UNKNOWN"} title={comp("jupiter")?.lastError ?? undefined} />
        <Status label="Raydium" status={comp("raydium")?.status ?? "UNKNOWN"} />
        <Status label="Orca" status={comp("orca")?.status ?? "UNKNOWN"} />
        <Status label="Meteora" status={comp("meteora")?.status ?? "UNKNOWN"} />
        <Status label="Jito" status={comp("jito")?.status ?? "UNKNOWN"} />
        <Status label="DB" status={s?.api.database ?? "UNKNOWN"} />
        <Status label="Redis" status={s?.api.redis ?? "UNKNOWN"} />
        <Status label="WS" status={ws ? "CONNECTED" : "DISCONNECTED"} />
      </div>
      <div className="num ml-auto flex items-center gap-4 text-[11px] text-ink2">
        <span title="SOL/EUR (Kraken)">SOL {w?.solEur ? eur(w.solEur) : "–"}</span>
        <span title="Slot der letzten Pool-Abfrage">Slot {w?.slot ?? "–"}</span>
        <span title="Jupiter-Requests im 60-s-Fenster">Quotes {w ? `${w.quoteBudget.used1m}/${w.quoteBudget.limit1m}` : "–"}</span>
        <span title="Heartbeat des Workers">♥ {s?.heartbeatAgeMs !== null && s?.heartbeatAgeMs !== undefined ? ms(s.heartbeatAgeMs) : "–"}</span>
        {openBreakers.length > 0 && (
          <span className="rounded border border-crit/60 px-1.5 py-0.5 text-crit" title={openBreakers.map((b) => `${b.id}: ${b.reason}`).join("\n")}>
            ⚡ {openBreakers.length} Breaker
          </span>
        )}
        <EmergencyStop state={s?.botState ?? ""} />
      </div>
    </header>
  );
}

function Sidebar({ s }: { s: StatusResponse | null }) {
  const path = usePathname();
  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.reload();
  };
  return (
    <aside className="sticky top-0 hidden h-screen w-52 shrink-0 flex-col border-r border-line bg-s1 md:flex">
      <div className="px-4 py-3">
        <div className="text-[15px] font-bold tracking-[0.2em]">SOLARBITER</div>
        <div className="text-[10px] uppercase tracking-wide text-mute">Multi-DEX Arbitrage</div>
      </div>
      <nav className="flex-1 overflow-y-auto px-2">
        {NAV.map(([href, label]) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
          return (
            <Link key={href} href={href} className={`block rounded px-3 py-1.5 text-[12px] ${active ? "bg-s2 text-ink" : "text-ink2 hover:bg-s2 hover:text-ink"}`}>
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="space-y-1 border-t border-line px-4 py-3 text-[11px] text-mute">
        <div>Learning {s?.worker ? `${s.worker.learning.score}/100 · ${s.worker.learning.status.replace(/_/g, " ")}` : "–"}</div>
        <div>Scan {s?.worker?.scanner.lastScanAt ? `vor ${ago(s.worker.scanner.lastScanAt)}` : "–"}</div>
        <button onClick={logout} className="text-ink2 hover:text-ink">
          Abmelden
        </button>
      </div>
    </aside>
  );
}

function MobileNav() {
  const path = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-line px-2 py-1 md:hidden">
      {NAV.map(([href, label]) => (
        <Link key={href} href={href} className={`whitespace-nowrap rounded px-2 py-1 text-[11px] ${path === href ? "bg-s2 text-ink" : "text-ink2"}`}>
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<{ authenticated: boolean; setupRequired: boolean } | null>(null);
  const check = useCallback(() => {
    api<{ authenticated: boolean; setupRequired: boolean }>("/api/auth/status")
      .then(setAuth)
      .catch(() => setAuth({ authenticated: false, setupRequired: false }));
  }, []);
  useEffect(() => {
    check();
    const h = () => check();
    window.addEventListener("sb:unauthorized", h);
    return () => window.removeEventListener("sb:unauthorized", h);
  }, [check]);
  if (!auth) return <div className="p-6 text-mute">Lade …</div>;
  if (!auth.authenticated) return <Login setupRequired={auth.setupRequired} onDone={check} />;
  return <Authed>{children}</Authed>;
}

function Authed({ children }: { children: ReactNode }) {
  const { data: status } = useApi<StatusResponse>("/api/status", 2_000);
  const [lastEvents, setLastEvents] = useState<RealtimeEvent[]>([]);
  const ws = useEvents((e) => {
    if (e.type === "STATUS_UPDATED") return;
    setLastEvents((xs) => [e, ...xs].slice(0, 200));
  });
  return (
    <Ctx.Provider value={{ status, lastEvents, wsConnected: ws }}>
      <div className="flex min-h-screen">
        <Sidebar s={status} />
        <div className="min-w-0 flex-1">
          <TopBar s={status} ws={ws} />
          <MobileNav />
          {status && !status.workerOnline && (
            <div className="mx-4 mt-3 rounded border border-serious/60 bg-serious/10 px-3 py-2 text-[12px] text-serious">! Worker offline — keine Marktdaten, kein Trading. Start: <code className="num">pnpm dev:worker</code></div>
          )}
          {status?.worker && !status.worker.ready && (
            <div className="mx-4 mt-3 rounded border border-serious/60 bg-serious/10 px-3 py-2 text-[12px] text-serious">
              ! BOT NOT READY: {status.worker.notReadyReasons.join(" · ") || "Startsequenz läuft"}
            </div>
          )}
          <main className="p-4">{children}</main>
        </div>
      </div>
    </Ctx.Provider>
  );
}
