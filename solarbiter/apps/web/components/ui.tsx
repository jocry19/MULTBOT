"use client";
import type { ReactNode } from "react";

export function Card({ title, right, children, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-md border border-line bg-s1 ${className}`}>
      {title !== undefined && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
          <h2 className="text-[12px] font-semibold uppercase tracking-wide text-ink2">{title}</h2>
          {right}
        </header>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}

export function Kpi({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "bad" | "warn" | null }) {
  const color = tone === "good" ? "text-good" : tone === "bad" ? "text-crit" : tone === "warn" ? "text-warn" : "text-ink";
  return (
    <div className="rounded-md border border-line bg-s1 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-mute">{label}</div>
      <div className={`num mt-1 text-lg font-semibold ${color}`}>{value}</div>
      {sub !== undefined && <div className="num mt-0.5 text-[11px] text-mute">{sub}</div>}
    </div>
  );
}

const STATE_TONE: Record<string, { cls: string; icon: string }> = {
  PAPER: { cls: "border-accent/50 text-accent", icon: "◇" },
  SHADOW: { cls: "border-accent/50 text-accent", icon: "◈" },
  LIVE: { cls: "border-crit text-crit", icon: "●" },
  PAUSED: { cls: "border-warn/60 text-warn", icon: "❚❚" },
  EMERGENCY_STOP: { cls: "border-crit bg-crit/15 text-crit", icon: "■" },
  NOT_READY: { cls: "border-serious/60 text-serious", icon: "!" },
  INITIALIZING: { cls: "border-line text-ink2", icon: "…" },
  OFFLINE: { cls: "border-line text-mute", icon: "○" },
  LIVE_LOCKED: { cls: "border-line text-mute", icon: "🔒" },
  LIVE_READY: { cls: "border-good/60 text-good", icon: "✓" },
  LIVE_ENABLED: { cls: "border-crit text-crit", icon: "●" },
};

export function StateBadge({ state }: { state: string }) {
  const t = STATE_TONE[state] ?? { cls: "border-line text-ink2", icon: "" };
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-semibold tracking-wide ${t.cls}`}>
      <span aria-hidden>{t.icon}</span>
      {state.replace(/_/g, " ")}
    </span>
  );
}

/** Component status dot — always with a text label (never colour alone). */
export function Status({ label, status, title }: { label: string; status: string; title?: string }) {
  const tone = status === "CONNECTED" ? "bg-good" : status === "DEGRADED" ? "bg-warn" : status === "DISABLED" || status === "UNKNOWN" ? "bg-mute" : "bg-crit";
  const sym = status === "CONNECTED" ? "" : status === "DEGRADED" ? " ~" : status === "DISABLED" ? " –" : status === "UNKNOWN" ? " ?" : " ✕";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] text-ink2" title={title ?? status}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${tone}`} />
      {label}
      {sym}
    </span>
  );
}

export function Pnl({ v, digits = 4 }: { v: number | null | undefined; digits?: number }) {
  if (v === null || v === undefined || !Number.isFinite(v)) return <span className="num text-mute">–</span>;
  const cls = v > 0 ? "text-good" : v < 0 ? "text-crit" : "text-ink2";
  return (
    <span className={`num ${cls}`}>
      {v > 0 ? "▲ +" : v < 0 ? "▼ " : ""}
      {v.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits })} €
    </span>
  );
}

export function Button({ children, onClick, tone = "default", disabled, type = "button", title }: { children: ReactNode; onClick?: () => void; tone?: "default" | "primary" | "danger"; disabled?: boolean; type?: "button" | "submit"; title?: string }) {
  const cls =
    tone === "danger"
      ? "border-crit bg-crit/15 text-crit hover:bg-crit/25"
      : tone === "primary"
        ? "border-accent bg-accent/15 text-accent hover:bg-accent/25"
        : "border-line bg-s2 text-ink hover:border-ink2";
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick} className={`rounded border px-3 py-1.5 text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-40 ${cls}`}>
      {children}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-6 text-center text-[12px] text-mute">{children}</div>;
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="rounded border border-crit/50 bg-crit/10 px-3 py-2 text-[12px] text-crit">⚠ {error}</div>;
}

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {empty && <Empty>Keine Daten</Empty>}
    </div>
  );
}

export function PageTitle({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {sub && <p className="mt-0.5 text-[12px] text-mute">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wide text-mute">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-0.5 block text-[11px] text-mute">{hint}</span>}
    </label>
  );
}

export const inputNarrow = "rounded border border-line bg-bg px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent";
export const inputCls = `w-full ${inputNarrow}`;
