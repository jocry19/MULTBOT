import { clsx } from "clsx";
import { AlertTriangle, CheckCircle2, CircleSlash, Loader2, XCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { signed, pct } from "../lib/format";

export function Card({ title, subtitle, actions, children, className, dense }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; dense?: boolean }) {
  return (
    <section className={clsx("rounded-xl border border-line bg-surface", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <div className="min-w-0">
            {title && <h2 className="truncate text-[13px] font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="truncate text-[11px] text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={dense ? "" : "p-4"}>{children}</div>
    </section>
  );
}

/** Stat tile: label · value · optional delta/detail. Proportional figures for the big value. */
export function Kpi({ label, value, detail, tone, hint }: { label: string; value: ReactNode; detail?: ReactNode; tone?: "good" | "bad" | "warn" | "neutral"; hint?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface px-3.5 py-3" title={hint}>
      <div className="truncate text-[11px] text-muted">{label}</div>
      <div
        className={clsx(
          "mt-1 truncate text-lg font-semibold",
          tone === "good" && "text-good-text",
          tone === "bad" && "text-bad",
          tone === "warn" && "text-warn",
          (!tone || tone === "neutral") && "text-ink",
        )}
      >
        {value}
      </div>
      {detail && <div className="mt-0.5 truncate text-[11px] text-ink-2">{detail}</div>}
    </div>
  );
}

export function toneOf(v: number | null | undefined): "good" | "bad" | "neutral" {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return "neutral";
  return v > 0 ? "good" : "bad";
}

/** Signed P&L: colour + explicit sign (colour is never the only cue). */
export function Pnl({ value, digits, unit = " SOL", percent = false }: { value: number | null | undefined; digits?: number; unit?: string; percent?: boolean }) {
  const t = toneOf(value);
  const d = digits ?? (percent ? 1 : 4);
  return (
    <span className={clsx("num", t === "good" && "text-good-text", t === "bad" && "text-bad", t === "neutral" && "text-ink-2")}>
      {percent ? pct(value ?? null, d) : signed(value ?? null, d, unit)}
    </span>
  );
}

const STATUS_STYLES: Record<string, string> = {
  DISCOVERED: "bg-sky-500/10 text-sky-300 ring-sky-500/30",
  TESTING: "bg-indigo-500/10 text-indigo-300 ring-indigo-500/30",
  PAPER_TRADING: "bg-blue-500/10 text-blue-300 ring-blue-500/30",
  PAPER_VALIDATED: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30",
  LIVE_ENABLED: "bg-emerald-500/20 text-emerald-200 ring-emerald-400/50",
  DEGRADED: "bg-amber-500/10 text-amber-300 ring-amber-500/30",
  PAUSED: "bg-zinc-500/10 text-zinc-300 ring-zinc-500/30",
  REJECTED: "bg-rose-500/10 text-rose-300 ring-rose-500/30",
  OPEN: "bg-blue-500/10 text-blue-300 ring-blue-500/30",
  OPENING: "bg-indigo-500/10 text-indigo-300 ring-indigo-500/30",
  CLOSING: "bg-indigo-500/10 text-indigo-300 ring-indigo-500/30",
  CLOSED: "bg-zinc-500/10 text-zinc-300 ring-zinc-500/30",
  FAILED: "bg-rose-500/10 text-rose-300 ring-rose-500/30",
  CONFIRMED: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30",
  LOCKED: "bg-zinc-500/10 text-zinc-300 ring-zinc-500/30",
  ACTIVE: "bg-emerald-500/20 text-emerald-200 ring-emerald-400/50",
  ENTER: "bg-blue-500/10 text-blue-300 ring-blue-500/30",
  NO_TRADE: "bg-zinc-500/10 text-zinc-300 ring-zinc-500/30",
};

export function Badge({ children, status, className }: { children: ReactNode; status?: string; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ring-1 ring-inset",
        status ? (STATUS_STYLES[status] ?? "bg-zinc-500/10 text-zinc-300 ring-zinc-500/30") : "bg-zinc-500/10 text-zinc-300 ring-zinc-500/30",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge status={status}>{status.replace(/_/g, " ")}</Badge>;
}

/** Health status with icon + label (never colour alone). */
export function HealthPill({ label, status }: { label: string; status: string }) {
  const good = status === "CONNECTED" || status === "RUNNING" || status === "OK" || status === "ACTIVE";
  const bad = status === "DISCONNECTED" || status === "ERROR" || status === "REQUIRED";
  const off = status === "DISABLED" || status === "STOPPED" || status === "LOCKED" || status === "PAUSED";
  const Icon = good ? CheckCircle2 : bad ? XCircle : off ? CircleSlash : AlertTriangle;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px]">
      <Icon size={13} className={clsx(good && "text-good-text", bad && "text-bad", off && "text-muted", !good && !bad && !off && "text-warn")} />
      <span className="text-muted">{label}</span>
      <span className="font-medium text-ink-2">{status}</span>
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  loading,
  size = "sm",
  type = "button",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "ghost" | "success";
  disabled?: boolean;
  loading?: boolean;
  size?: "xs" | "sm" | "md";
  type?: "button" | "submit";
  title?: string;
}) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled || loading}
      onClick={onClick}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40",
        size === "xs" && "h-6 px-2 text-[11px]",
        size === "sm" && "h-7 px-2.5 text-[12px]",
        size === "md" && "h-9 px-4 text-[13px]",
        variant === "default" && "border border-line-strong bg-surface-2 text-ink hover:bg-surface-3",
        variant === "ghost" && "text-ink-2 hover:bg-surface-2 hover:text-ink",
        variant === "primary" && "bg-accent text-white hover:brightness-110",
        variant === "success" && "bg-emerald-600 text-white hover:bg-emerald-500",
        variant === "danger" && "bg-rose-600 text-white hover:bg-rose-500",
      )}
    >
      {loading && <Loader2 size={13} className="animate-spin" />}
      {children}
    </button>
  );
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  sort?: (row: T) => number | string | null;
}

export function Table<T>({ rows, columns, onRowClick, empty, rowKey, maxHeight }: { rows: T[] | undefined; columns: Column<T>[]; onRowClick?: (row: T) => void; empty?: ReactNode; rowKey: (row: T, i: number) => string; maxHeight?: number }) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [dir, setDir] = useState<1 | -1>(-1);
  const col = columns.find((c) => c.key === sortKey);
  const data = rows ? [...rows] : [];
  if (col?.sort) {
    data.sort((a, b) => {
      const va = col.sort?.(a) ?? null;
      const vb = col.sort?.(b) ?? null;
      if (va === vb) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va > vb ? 1 : -1) * dir;
    });
  }
  return (
    <div className="overflow-auto" style={maxHeight ? { maxHeight } : undefined}>
      <table className="w-full border-collapse text-[12px]">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-b border-line text-[10.5px] uppercase tracking-wide text-muted">
            {columns.map((c) => (
              <th
                key={c.key}
                className={clsx("whitespace-nowrap px-3 py-2 font-medium", c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left", c.sort && "cursor-pointer select-none hover:text-ink-2")}
                onClick={() => {
                  if (!c.sort) return;
                  if (sortKey === c.key) setDir((d) => (d === 1 ? -1 : 1));
                  else {
                    setSortKey(c.key);
                    setDir(-1);
                  }
                }}
              >
                {c.header}
                {sortKey === c.key ? (dir === 1 ? " ▲" : " ▼") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-8 text-center text-muted">
                {rows === undefined ? <Loader2 size={16} className="mx-auto animate-spin" /> : (empty ?? "Keine Daten")}
              </td>
            </tr>
          )}
          {data.map((r, i) => (
            <tr key={rowKey(r, i)} onClick={onRowClick ? () => onRowClick(r) : undefined} className={clsx("border-b border-line/60 transition-colors hover:bg-surface-2", onRowClick && "cursor-pointer")}>
              {columns.map((c) => (
                <td key={c.key} className={clsx("whitespace-nowrap px-3 py-1.5", c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left", c.className)}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Tabs<K extends string>({ tabs, value, onChange }: { tabs: { key: K; label: ReactNode }[]; value: K; onChange: (k: K) => void }) {
  return (
    <div className="flex gap-1 rounded-lg bg-surface-2 p-0.5">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={clsx("rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors", value === t.key ? "bg-surface-3 text-ink shadow-sm" : "text-muted hover:text-ink-2")}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, width = 520 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="fade-in max-h-[90vh] w-full overflow-auto rounded-xl border border-line-strong bg-surface shadow-2xl" style={{ maxWidth: width }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="border-b border-line px-5 py-3 text-[14px] font-semibold">{title}</header>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/** Confirmation that requires typing an exact phrase (real-money actions). */
export function ConfirmPhrase({ open, onClose, title, phrase, description, onConfirm, danger }: { open: boolean; onClose: () => void; title: string; phrase: string; description: ReactNode; onConfirm: () => Promise<void>; danger?: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setText("");
      setErr(null);
    }
  }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-4 text-[13px] text-ink-2">
        {description}
        <div>
          <label className="mb-1 block text-[11px] text-muted">
            Zur Bestätigung <span className="num text-ink">{phrase}</span> eingeben
          </label>
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} className="num w-full rounded-lg border border-line-strong bg-surface-2 px-3 py-2 text-ink outline-none focus:border-accent" />
        </div>
        {err && <ErrorBox error={err} />}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            variant={danger ? "danger" : "success"}
            disabled={text !== phrase}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await onConfirm();
                onClose();
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {title}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
      <XCircle size={14} className="mt-0.5 shrink-0" />
      <span>{msg}</span>
    </div>
  );
}

export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" }) {
  return (
    <div className={clsx("flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px]", tone === "warn" ? "border-amber-500/30 bg-amber-500/10 text-amber-100" : "border-sky-500/20 bg-sky-500/5 text-sky-100")}>
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

export function Loading({ label = "Lade…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-muted">
      <Loader2 size={15} className="animate-spin" />
      {label}
    </div>
  );
}

export function KV({ items, cols = 2 }: { items: [ReactNode, ReactNode][]; cols?: number }) {
  return (
    <dl className="grid gap-x-6 gap-y-1.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {items.map(([k, v], i) => (
        <div key={i} className="flex items-baseline justify-between gap-3 border-b border-line/50 py-1">
          <dt className="text-[11.5px] text-muted">{k}</dt>
          <dd className="num text-right text-[12px] text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[18px] font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[12px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-ink-2">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={clsx("relative h-4.5 w-8 rounded-full transition-colors", checked ? "bg-accent" : "bg-surface-3")}
        style={{ height: 18, width: 32 }}
      >
        <span className={clsx("absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all", checked ? "left-4" : "left-0.5")} style={{ height: 14, width: 14 }} />
      </button>
      {label}
    </label>
  );
}

export function Pct({ value, digits = 1 }: { value: number | null | undefined; digits?: number }) {
  return <Pnl value={value} percent digits={digits} />;
}
