import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  Activity,
  BarChart3,
  Beaker,
  BookOpen,
  Boxes,
  Brain,
  Compass,
  FlaskConical,
  Gauge,
  History,
  Layers,
  LineChart,
  ListChecks,
  OctagonX,
  Radar,
  Receipt,
  Settings,
  ShieldAlert,
  Users,
  Wallet,
} from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router";
import type { ActivityDto, SystemHealthDto } from "@multbot/shared";
import { api } from "../api/client";
import { useLiveStream } from "../api/stream";
import { sol, time } from "../lib/format";
import { Button, ConfirmPhrase, HealthPill, Pnl } from "./ui";

interface StreamState {
  connected: boolean;
  health: SystemHealthDto | null;
  activity: ActivityDto[];
}

const StreamContext = createContext<StreamState>({ connected: false, health: null, activity: [] });
export const useStream = () => useContext(StreamContext);

const NAV: { to: string; label: string; icon: typeof Gauge }[] = [
  { to: "/", label: "Dashboard", icon: Gauge },
  { to: "/markets", label: "Markets", icon: LineChart },
  { to: "/discoveries", label: "Discoveries", icon: Radar },
  { to: "/strategy-lab", label: "Strategy Lab", icon: FlaskConical },
  { to: "/paper", label: "Paper Trading", icon: Beaker },
  { to: "/live", label: "Live Trading", icon: ShieldAlert },
  { to: "/positions", label: "Positions", icon: Layers },
  { to: "/orders", label: "Orders", icon: ListChecks },
  { to: "/portfolio", label: "Portfolio", icon: Boxes },
  { to: "/wallet", label: "Wallet", icon: Wallet },
  { to: "/transactions", label: "Transactions", icon: Receipt },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/backtests", label: "Backtests", icon: History },
  { to: "/research", label: "Research", icon: Brain },
  { to: "/events", label: "Events", icon: Activity },
  { to: "/wallet-intel", label: "Wallet Intelligence", icon: Users },
  { to: "/settings", label: "Settings", icon: Settings },
];

interface DashboardData {
  wallet: { address: string | null; balanceSol: number | null; availableSol: number | null };
  live: { portfolioValueSol: number; totalPnlSol: number; todayPnlSol: number; openPositions: number };
  paper: { portfolioValueSol: number; totalPnlSol: number };
  bot: { running: boolean; liveState: string; emergencyStop: boolean; reconciliation: string };
  regime: { label: string } | null;
}

function TopBar() {
  const { health, connected } = useStream();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["dashboard"], queryFn: () => api.get<DashboardData>("/api/dashboard"), refetchInterval: 10_000 });
  const [confirm, setConfirm] = useState(false);
  const emergency = data?.bot.emergencyStop ?? health?.emergencyStop ?? false;
  const release = useMutation({
    mutationFn: () => api.post("/api/bot/emergency-stop", { active: false }),
    onSuccess: () => qc.invalidateQueries(),
  });
  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line bg-surface px-4">
      <div className="flex min-w-0 flex-1 items-center gap-5 overflow-x-auto text-[12px]">
        <Metric label="Wallet" value={data?.wallet.balanceSol !== undefined ? sol(data.wallet.balanceSol, 4) : "—"} />
        <Metric label="Portfolio (live)" value={sol(data?.live.portfolioValueSol ?? null, 4)} />
        <Metric label="P&L live" value={<Pnl value={data?.live.totalPnlSol ?? null} />} />
        <Metric label="P&L paper" value={<Pnl value={data?.paper.totalPnlSol ?? null} />} />
        <Metric label="Regime" value={<span className="text-ink-2">{data?.regime?.label?.replace(/_/g, " ") ?? "—"}</span>} />
        <div className="flex items-center gap-3 border-l border-line pl-4">
          <HealthPill label="Bot" status={data ? (data.bot.running ? "RUNNING" : "STOPPED") : "UNKNOWN"} />
          <HealthPill label="Real money" status={data?.bot.liveState ?? "LOCKED"} />
          <HealthPill label="Feed" status={health?.dataFeed ?? (connected ? "UNKNOWN" : "DISCONNECTED")} />
        </div>
      </div>
      {emergency ? (
        <Button variant="default" onClick={() => release.mutate()} loading={release.isPending} title="Emergency stop is active">
          <OctagonX size={14} className="text-bad" /> STOP aktiv — freigeben
        </Button>
      ) : (
        <Button variant="danger" onClick={() => setConfirm(true)}>
          <OctagonX size={14} /> EMERGENCY STOP
        </Button>
      )}
      <EmergencyDialog open={confirm} onClose={() => setConfirm(false)} />
    </header>
  );
}

function EmergencyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [closeAll, setCloseAll] = useState(false);
  return (
    <ConfirmPhrase
      open={open}
      onClose={onClose}
      danger
      title="EMERGENCY STOP"
      phrase="STOP"
      description={
        <div className="space-y-3">
          <p>Stoppt sofort alle neuen Trades (live). Paper Trading läuft weiter.</p>
          <label className="flex items-center gap-2 text-ink">
            <input type="checkbox" checked={closeAll} onChange={(e) => setCloseAll(e.target.checked)} />
            Alle offenen Live-Positionen sofort schließen
          </label>
        </div>
      }
      onConfirm={async () => {
        await api.post("/api/bot/emergency-stop", { active: true, closePositions: closeAll });
        await qc.invalidateQueries();
      }}
    />
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col leading-tight">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <span className="num text-[12.5px] text-ink">{value}</span>
    </div>
  );
}

function Sidebar() {
  const { connected } = useStream();
  return (
    <nav className="flex w-52 shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex h-12 items-center gap-2 border-b border-line px-4">
        <div className="grid h-7 w-7 place-items-center rounded-lg bg-accent/15 text-accent">
          <Compass size={16} />
        </div>
        <div className="leading-tight">
          <div className="text-[13px] font-semibold tracking-tight">MULTBOT</div>
          <div className="text-[10px] text-muted">Solana Research Terminal</div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === "/"}
            className={({ isActive }) =>
              clsx(
                "mb-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12.5px] transition-colors",
                isActive ? "bg-surface-3 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
              )
            }
          >
            <n.icon size={15} className="shrink-0 opacity-80" />
            {n.label}
          </NavLink>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-line px-4 py-2 text-[11px] text-muted">
        <span className={clsx("inline-block h-2 w-2 rounded-full", connected ? "pulse-dot bg-good" : "bg-bad")} />
        {connected ? "Live verbunden" : "Getrennt — verbinde neu…"}
      </div>
    </nav>
  );
}

export function ActivityFeed({ items, max = 60, compact }: { items: ActivityDto[]; max?: number; compact?: boolean }) {
  return (
    <ol className="space-y-0.5">
      {items.slice(0, max).map((a) => (
        <li key={`${a.id}-${a.ts}`} className="fade-in grid grid-cols-[56px_1fr] gap-2 rounded px-1 py-0.5 text-[11.5px] hover:bg-surface-2">
          <span className="num text-muted">{time(a.ts)}</span>
          <span
            className={clsx(
              compact && "truncate",
              a.level === "success" && "text-good-text",
              a.level === "error" && "text-bad",
              a.level === "warning" && "text-warn",
              (a.level === "info" || a.level === "debug") && "text-ink-2",
            )}
          >
            {a.message}
          </span>
        </li>
      ))}
      {items.length === 0 && <li className="py-4 text-center text-[12px] text-muted">Noch keine Aktivität</li>}
    </ol>
  );
}

export function Layout() {
  const stream = useLiveStream();
  return (
    <StreamContext.Provider value={stream}>
      <div className="flex h-full">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main className="min-h-0 flex-1 overflow-y-auto p-4">
            <Outlet />
          </main>
        </div>
      </div>
    </StreamContext.Provider>
  );
}
