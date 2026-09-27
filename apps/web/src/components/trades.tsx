import { useNavigate } from "react-router";
import type { PortfolioSummary, PositionRow, TradeRow } from "../api/types";
import { dateTime, duration, pct, price, sol } from "../lib/format";
import { Kpi, Pnl, StatusBadge, Table, toneOf, type Column } from "./ui";

export function totalCosts(t: TradeRow): number {
  return (
    t.entry_fees_sol +
    t.exit_fees_sol +
    t.entry_slippage_sol +
    t.exit_slippage_sol +
    t.priority_fees_sol +
    t.network_fees_sol +
    t.mev_impact_sol +
    t.entry_rent_sol -
    t.exit_rent_refund_sol
  );
}

function holdSec(t: TradeRow): number | null {
  if (!t.opened_at) return null;
  const end = t.closed_at ? new Date(t.closed_at).getTime() : Date.now();
  return (end - new Date(t.opened_at).getTime()) / 1000;
}

export function TradesTable({ rows, mode, maxHeight = 520, showStrategy = true }: { rows: TradeRow[] | undefined; mode: "paper" | "live"; maxHeight?: number; showStrategy?: boolean }) {
  const nav = useNavigate();
  const columns: Column<TradeRow>[] = [
    { key: "ts", header: "Entscheidung", cell: (t) => <span className="num text-ink-2">{dateTime(t.decision_ts)}</span>, sort: (t) => new Date(t.decision_ts).getTime() },
    { key: "token", header: "Token", cell: (t) => <span className="text-ink">{t.symbol ?? `${t.mint.slice(0, 6)}…`}</span> },
    ...(showStrategy ? [{ key: "strat", header: "Strategie", cell: (t: TradeRow) => <span className="num text-ink-2">{t.strategy_version_id}</span> }] : []),
    { key: "status", header: "Status", cell: (t) => <StatusBadge status={t.status} /> },
    { key: "size", header: "Größe", align: "right", cell: (t) => <span className="num">{t.position_size_sol.toFixed(3)}</span> },
    { key: "entry", header: "Einstieg", align: "right", cell: (t) => <span className="num text-ink-2">{price(t.entry_price)}</span> },
    { key: "exit", header: "Ausstieg", align: "right", cell: (t) => <span className="num text-ink-2">{price(t.exit_price)}</span> },
    { key: "gross", header: "Brutto", align: "right", cell: (t) => <Pnl value={t.gross_pnl_sol} digits={5} />, sort: (t) => t.gross_pnl_sol },
    { key: "costs", header: "Kosten", align: "right", cell: (t) => <span className="num text-ink-2">{totalCosts(t).toFixed(5)}</span>, sort: (t) => totalCosts(t) },
    { key: "net", header: "Netto", align: "right", cell: (t) => <Pnl value={t.net_pnl_sol} digits={5} />, sort: (t) => t.net_pnl_sol },
    { key: "ret", header: "Rendite", align: "right", cell: (t) => <Pnl value={t.net_return} percent />, sort: (t) => t.net_return },
    { key: "hold", header: "Dauer", align: "right", cell: (t) => <span className="num text-muted">{duration(holdSec(t))}</span>, sort: (t) => holdSec(t) },
    { key: "reason", header: "Grund", cell: (t) => <span className="text-ink-2">{t.exit_reason ?? t.failed_reason ?? "—"}</span> },
  ];
  return <Table rows={rows} columns={columns} rowKey={(t) => t.id} onRowClick={(t) => nav(`/trades/${mode}/${t.id}`)} maxHeight={maxHeight} empty="Keine Trades" />;
}

export function PositionsTable({ rows, mode, onClose }: { rows: PositionRow[] | undefined; mode: "paper" | "live"; onClose?: (p: PositionRow) => void }) {
  const nav = useNavigate();
  const columns: Column<PositionRow>[] = [
    { key: "token", header: "Token", cell: (p) => <span className="text-ink">{p.symbol ?? `${p.mint.slice(0, 6)}…`}</span> },
    { key: "strat", header: "Strategie", cell: (p) => <span className="num text-ink-2">{p.strategy_version_id}</span> },
    { key: "status", header: "Status", cell: (p) => <StatusBadge status={p.status} /> },
    { key: "opened", header: "Eröffnet", cell: (p) => <span className="num text-ink-2">{dateTime(p.opened_at)}</span> },
    { key: "hold", header: "Dauer", align: "right", cell: (p) => <span className="num text-muted">{duration(holdSec(p))}</span> },
    { key: "size", header: "Einsatz", align: "right", cell: (p) => <span className="num">{p.position_size_sol.toFixed(3)}</span> },
    { key: "entry", header: "Einstieg", align: "right", cell: (p) => <span className="num text-ink-2">{price(p.entry_price)}</span> },
    { key: "value", header: "Liquidationswert", align: "right", cell: (p) => <span className="num">{sol(p.valueSol, 5)}</span>, sort: (p) => p.valueSol },
    { key: "unr", header: "Unrealisiert netto", align: "right", cell: (p) => <Pnl value={p.unrealizedSol} digits={5} />, sort: (p) => p.unrealizedSol },
    {
      key: "unrp",
      header: "%",
      align: "right",
      cell: (p) => <Pnl value={p.position_size_sol > 0 ? p.unrealizedSol / p.position_size_sol : null} percent />,
      sort: (p) => p.unrealizedSol / Math.max(1e-9, p.position_size_sol),
    },
    ...(onClose
      ? [
          {
            key: "close",
            header: "",
            align: "right" as const,
            cell: (p: PositionRow) => (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(p);
                }}
                className="rounded-md border border-rose-500/40 px-2 py-0.5 text-[11px] text-rose-300 hover:bg-rose-500/10"
              >
                Schließen
              </button>
            ),
          },
        ]
      : []),
  ];
  return <Table rows={rows} columns={columns} rowKey={(p) => p.id} onRowClick={(p) => nav(`/trades/${mode}/${p.id}`)} empty={`Keine offenen ${mode === "paper" ? "Paper" : "Live"}-Positionen`} />;
}

export function PortfolioKpis({ p, winRate, expectancy }: { p: PortfolioSummary | undefined; winRate?: number | null; expectancy?: number | null }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
      <Kpi label={p?.mode === "paper" ? "Virtuelles Kapital" : "Wallet"} value={sol(p?.capitalSol ?? null, 4)} />
      <Kpi label="Portfolio-Wert" value={sol(p?.portfolioValueSol ?? null, 4)} detail="Liquidationswert" />
      <Kpi label="Verfügbar" value={sol(p?.cashSol ?? null, 4)} detail={`gebunden ${sol(p?.lockedSol ?? null, 4)}`} />
      <Kpi label="Offene Positionen" value={p?.openPositions ?? "—"} detail={`${p?.closedTrades ?? 0} geschlossen · ${p?.failedTrades ?? 0} fehlgeschlagen`} />
      <Kpi label="Realisiert netto" value={<Pnl value={p?.realizedPnlSol ?? null} />} tone={toneOf(p?.realizedPnlSol)} />
      <Kpi label="Unrealisiert netto" value={<Pnl value={p?.unrealizedPnlSol ?? null} />} tone={toneOf(p?.unrealizedPnlSol)} />
      <Kpi label="Heute netto" value={<Pnl value={p?.todayPnlSol ?? null} />} tone={toneOf(p?.todayPnlSol)} />
      <Kpi label="Gesamt netto" value={<Pnl value={p?.totalPnlSol ?? null} />} tone={toneOf(p?.totalPnlSol)} detail={<span>Brutto <Pnl value={p?.grossPnlSol ?? null} /></span>} />
      <Kpi label="Gebühren" value={sol(p?.feesSol ?? null, 5)} detail="DEX + Netzwerk + Priority" />
      <Kpi label="Slippage" value={sol(p?.slippageSol ?? null, 5)} detail="inkl. MEV/Latenz" />
      <Kpi label="Trefferquote" value={winRate !== undefined ? pct(winRate ?? null, 1, false) : "—"} />
      <Kpi label="Ø netto / Trade" value={<Pnl value={expectancy ?? null} digits={5} />} tone={toneOf(expectancy)} />
    </div>
  );
}
