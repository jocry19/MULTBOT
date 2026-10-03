import { Search } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../api/hooks";
import type { TokenRow } from "../api/types";
import { Badge, Card, PageHeader, Pnl, Table, Tabs, type Column } from "../components/ui";
import { ago, compact, pct, price } from "../lib/format";

type Sort = "volume" | "discovery" | "new" | "change" | "mcap";
type Venue = "all" | "pump_curve" | "pump_amm";

export function venueLabel(v: string | null | undefined): string {
  return v === "pump_amm" ? "PumpSwap" : v === "pump_curve" ? "Curve" : (v ?? "—");
}

export function TokenName({ t }: { t: { mint: string; symbol?: string | null; name?: string | null; is_mayhem_mode?: boolean } }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <span className="font-medium text-ink">{t.symbol ?? t.mint.slice(0, 6)}</span>
        {t.is_mayhem_mode && <Badge status="DEGRADED">Mayhem</Badge>}
      </div>
      <div className="max-w-[200px] truncate text-[10.5px] text-muted">{t.name ?? t.mint}</div>
    </div>
  );
}

export function MarketsPage() {
  const nav = useNavigate();
  const [sort, setSort] = useState<Sort>("volume");
  const [venue, setVenue] = useState<Venue>("all");
  const [search, setSearch] = useState("");
  const qs = new URLSearchParams({ sort, venue, limit: "200", ...(search.trim().length >= 2 ? { search: search.trim() } : {}) });
  const q = useApi<TokenRow[]>("markets", `/api/markets?${qs.toString()}`, 5_000);

  const columns: Column<TokenRow>[] = [
    { key: "token", header: "Token", cell: (t) => <TokenName t={t} /> },
    { key: "venue", header: "Venue", cell: (t) => <Badge>{venueLabel(t.venue)}</Badge> },
    { key: "age", header: "Alter", align: "right", cell: (t) => <span className="num text-ink-2">{ago(t.created_at)}</span>, sort: (t) => (t.created_at ? -new Date(t.created_at).getTime() : null) },
    { key: "price", header: "Preis (SOL)", align: "right", cell: (t) => <span className="num">{price(t.price_sol)}</span>, sort: (t) => t.price_sol },
    { key: "mcap", header: "Market Cap", align: "right", cell: (t) => <span className="num">{compact(t.market_cap_sol)} SOL</span>, sort: (t) => t.market_cap_sol },
    { key: "liq", header: "Liquidität", align: "right", cell: (t) => <span className="num">{compact(t.liquidity_sol)} SOL</span>, sort: (t) => t.liquidity_sol },
    { key: "v5", header: "Vol 5m", align: "right", cell: (t) => <span className="num">{compact(t.volume_sol_5m)}</span>, sort: (t) => t.volume_sol_5m },
    { key: "v1h", header: "Vol 1h", align: "right", cell: (t) => <span className="num">{compact(t.volume_sol_1h)}</span>, sort: (t) => t.volume_sol_1h ?? null },
    { key: "c5", header: "Δ 5m", align: "right", cell: (t) => <Pnl value={t.price_change_5m} percent />, sort: (t) => t.price_change_5m },
    { key: "c1h", header: "Δ 1h", align: "right", cell: (t) => <Pnl value={t.price_change_1h ?? null} percent />, sort: (t) => t.price_change_1h ?? null },
    {
      key: "bs",
      header: "Buys / Sells 5m",
      align: "right",
      cell: (t) => (
        <span className="num text-ink-2">
          {t.buys_5m ?? "—"} / {t.sells_5m ?? "—"}
        </span>
      ),
      sort: (t) => (t.buys_5m ?? 0) + (t.sells_5m ?? 0),
    },
    { key: "holders", header: "Holder", align: "right", cell: (t) => <span className="num">{t.holders ?? "—"}</span>, sort: (t) => t.holders },
    { key: "top10", header: "Top-10", align: "right", cell: (t) => <span className="num text-ink-2">{pct(t.top10_share ?? null, 0, false)}</span>, sort: (t) => t.top10_share ?? null },
    {
      key: "bond",
      header: "Bonding",
      align: "right",
      cell: (t) =>
        t.venue === "pump_curve" && t.bonding_progress !== null && t.bonding_progress !== undefined ? (
          <div className="ml-auto flex w-20 items-center gap-1.5">
            <div className="h-1.5 flex-1 rounded-full bg-surface-3">
              <div className="h-1.5 rounded-full bg-series-1" style={{ width: `${Math.min(100, t.bonding_progress * 100)}%` }} />
            </div>
            <span className="num text-[10.5px] text-ink-2">{(t.bonding_progress * 100).toFixed(0)}%</span>
          </div>
        ) : (
          <span className="text-muted">—</span>
        ),
      sort: (t) => t.bonding_progress ?? null,
    },
    { key: "disc", header: "Auffälligkeit", align: "right", cell: (t) => <span className="num">{t.discovery_score ? t.discovery_score.toFixed(1) : "—"}</span>, sort: (t) => t.discovery_score },
  ];

  return (
    <div>
      <PageHeader title="Markets" subtitle="Aktive Pump.fun-Tokens (Bonding Curve & PumpSwap), Handel in der letzten Stunde — live aus dem eigenen Indexer" />
      <Card
        dense
        title={`${q.data?.length ?? "…"} Tokens`}
        actions={
          <>
            <div className="relative">
              <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Symbol, Name, Mint"
                className="h-7 w-52 rounded-lg border border-line-strong bg-surface-2 pl-7 pr-2 text-[12px] outline-none focus:border-accent"
              />
            </div>
            <Tabs<Venue>
              value={venue}
              onChange={setVenue}
              tabs={[
                { key: "all", label: "Alle" },
                { key: "pump_curve", label: "Curve" },
                { key: "pump_amm", label: "PumpSwap" },
              ]}
            />
            <Tabs<Sort>
              value={sort}
              onChange={setSort}
              tabs={[
                { key: "volume", label: "Volumen" },
                { key: "discovery", label: "Auffällig" },
                { key: "new", label: "Neu" },
                { key: "change", label: "Δ 5m" },
                { key: "mcap", label: "MCap" },
              ]}
            />
          </>
        }
      >
        <Table rows={q.data} columns={columns} rowKey={(t) => t.mint} onRowClick={(t) => nav(`/token/${t.mint}`)} maxHeight={760} empty="Keine aktiven Tokens (läuft die Datenaufnahme?)" />
      </Card>
    </div>
  );
}
