import { CheckCircle2, Copy, ExternalLink, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { describeCondition, type Condition } from "@multbot/shared";
import { useApi } from "../api/hooks";
import type { DiscoveryReason, TokenRow } from "../api/types";
import { CandleChart, type Candle } from "../components/charts/charts";
import { Badge, Card, ErrorBox, KV, Kpi, Loading, Notice, Pnl, StatusBadge, Table, Tabs } from "../components/ui";
import { ago, compact, dateTime, pct, price, shortAddr } from "../lib/format";
import { eventColumns, type EventRow } from "./Events";
import { venueLabel } from "./Markets";

interface OutcomeSummary {
  n: number;
  mean: number;
  median: number;
  positive: number;
  negative: number;
  winRate: number;
  worst: number;
  best: number;
  p10: number;
  p90: number;
  maxRunupMedian: number;
  maxDrawdownMedian: number;
  timeToPeakMedianSec: number;
}

interface TokenDetail {
  token: { mint: string; name: string | null; symbol: string | null; creator: string | null; created_at: string | null; is_mayhem_mode: boolean; complete_at: string | null; migrated_at: string | null; amm_pool: string | null; mint_authority: string | null; freeze_authority: string | null; uri: string | null } | null;
  state: (TokenRow & { discovery_reasons: DiscoveryReason[] }) | null;
  creator: { address: string; tokens_created: number; tokens_completed: number; tokens_rugged: number; first_created_at: string | null; stats: Record<string, number> } | null;
  holders: { owner: string; balance: string; first_acquired_at: string | null; last_change_at: string }[];
  events: EventRow[];
  features: Record<string, number> | null;
  strategyMatches: { strategyId: string; name: string; status: string; matched: boolean; similarity: number; conditions: { condition: Condition; holds: boolean }[] }[];
  analogues: { similarSituations: number; similarity: number; horizons: Record<string, OutcomeSummary>; examples: { mint: string; ts: number; ret300: number | null }[] } | null;
  trades: { paper: OwnTrade[]; live: OwnTrade[] };
  live: { venue: string; price: number; liquiditySol: number; marketCapSol: number; bondingProgress: number | null; holders: number; trades: number; buys: number; sells: number; athPrice: number; seenFromCreation: boolean } | null;
}

interface OwnTrade {
  id: string;
  strategy_id: string;
  status: string;
  opened_at: string | null;
  closed_at: string | null;
  net_pnl_sol: number | null;
  net_return: number | null;
  exit_reason: string | null;
}

interface TapeTrade {
  signature: string;
  ts: string;
  trader: string;
  is_buy: boolean;
  sol_amount: number;
  token_amount: string;
  price_sol: number;
  venue: string;
}

const HORIZONS: [string, string][] = [
  ["60", "1 min"],
  ["300", "5 min"],
  ["900", "15 min"],
  ["3600", "1 h"],
  ["14400", "4 h"],
];

export function TokenPage() {
  const { mint = "" } = useParams();
  const nav = useNavigate();
  const [hours, setHours] = useState("6");
  const q = useApi<TokenDetail>("token", `/api/tokens/${mint}`, 10_000);
  const candles = useApi<Candle[]>("token", `/api/tokens/${mint}/candles?hours=${hours}`, 15_000);
  const tape = useApi<TapeTrade[]>("token", `/api/tokens/${mint}/trades?limit=100`, 5_000);
  const [featFilter, setFeatFilter] = useState("");
  const [copied, setCopied] = useState(false);
  const features = useMemo(
    () =>
      Object.entries(q.data?.features ?? {})
        .filter(([k]) => k.toLowerCase().includes(featFilter.toLowerCase()))
        .sort(([a], [b]) => a.localeCompare(b)),
    [q.data, featFilter],
  );

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data;
  if (!d) return null;
  const t = d.token;
  const s = d.state;
  const l = d.live;
  const symbol = t?.symbol ?? s?.symbol ?? mint.slice(0, 6);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[20px] font-semibold tracking-tight">{symbol}</h1>
            <span className="text-[13px] text-ink-2">{t?.name}</span>
            <Badge>{venueLabel(l?.venue ?? s?.venue)}</Badge>
            {t?.is_mayhem_mode && <Badge status="DEGRADED">Mayhem Mode</Badge>}
            {t?.migrated_at && <Badge status="PAPER_VALIDATED">migriert {ago(t.migrated_at)}</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-[11.5px]">
            <span className="num text-muted">{mint}</span>
            <button
              className="text-muted hover:text-ink"
              onClick={async () => {
                await navigator.clipboard.writeText(mint);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
              title="Mint kopieren"
            >
              <Copy size={12} />
            </button>
            {copied && <span className="text-good-text">kopiert</span>}
            <a href={`https://solscan.io/token/${mint}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
              Solscan <ExternalLink size={11} />
            </a>
            <a href={`https://pump.fun/coin/${mint}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
              pump.fun <ExternalLink size={11} />
            </a>
            <span className="text-muted">erstellt {dateTime(t?.created_at)} ({ago(t?.created_at)})</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
        <Kpi label="Preis" value={<span className="num">{price(l?.price ?? s?.price_sol)}</span>} detail={<span>5m <Pnl value={s?.price_change_5m ?? null} percent /></span>} />
        <Kpi label="Market Cap" value={`${compact(l?.marketCapSol ?? s?.market_cap_sol)} SOL`} detail={`ATH-Preis ${price(l?.athPrice ?? s?.ath_price_sol)}`} />
        <Kpi label="Liquidität" value={`${compact(l?.liquiditySol ?? s?.liquidity_sol)} SOL`} />
        <Kpi label="Bonding" value={l?.bondingProgress !== null && l?.bondingProgress !== undefined ? pct(l.bondingProgress, 0, false) : "—"} />
        <Kpi label="Holder" value={l?.holders ?? s?.holders ?? "—"} detail={`Top-10 ${pct(s?.top10_share ?? null, 0, false)}`} />
        <Kpi label="Volumen 5m / 1h" value={`${compact(s?.volume_sol_5m)} / ${compact(s?.volume_sol_1h)}`} />
        <Kpi label="Trades" value={l?.trades ?? s?.trades_total ?? "—"} detail={`${l?.buys ?? "—"} Käufe · ${l?.sells ?? "—"} Verkäufe`} />
        <Kpi label="Datenabdeckung" value={l ? (l.seenFromCreation ? "ab Erstellung" : "teilweise") : "—"} detail={l ? undefined : "nicht im Live-Speicher"} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-4">
          <Card
            title="Chart"
            subtitle="1-Minuten-Kerzen aus eigenen Trade-Daten (Kauf-Kerze hohl, Verkauf-Kerze gefüllt)"
            actions={
              <Tabs
                value={hours}
                onChange={setHours}
                tabs={[
                  { key: "1", label: "1h" },
                  { key: "6", label: "6h" },
                  { key: "24", label: "24h" },
                ]}
              />
            }
          >
            {(candles.data?.length ?? 0) > 0 ? <CandleChart candles={candles.data ?? []} height={340} /> : <div className="py-10 text-center text-[12px] text-muted">Keine Kerzen im Zeitraum</div>}
          </Card>

          <Card title="Historische Analogien" subtitle="Ähnliche Situationen (gleiches Alter & Venue, ähnliche Merkmale) und was danach passierte — Mid-Preis, vor Kosten">
            {d.analogues && d.analogues.similarSituations > 0 ? (
              <div className="space-y-3">
                <div className="text-[13px] text-ink">
                  Die aktuelle Situation ähnelt <b>{d.analogues.similarSituations}</b> historischen Situationen (Ähnlichkeit {pct(d.analogues.similarity, 0, false)}).
                </div>
                <Table
                  rows={HORIZONS.filter(([h]) => d.analogues?.horizons[h])}
                  rowKey={([h]) => h}
                  columns={[
                    { key: "h", header: "Danach", cell: ([, lbl]) => <span className="text-ink">{lbl}</span> },
                    { key: "n", header: "n", align: "right", cell: ([h]) => <span className="num">{d.analogues?.horizons[h]?.n}</span> },
                    { key: "pn", header: "Positiv / Negativ", align: "right", cell: ([h]) => <span className="num text-ink-2">{d.analogues?.horizons[h]?.positive} / {d.analogues?.horizons[h]?.negative}</span> },
                    { key: "m", header: "Median", align: "right", cell: ([h]) => <Pnl value={d.analogues?.horizons[h]?.median ?? null} percent /> },
                    { key: "a", header: "Ø", align: "right", cell: ([h]) => <Pnl value={d.analogues?.horizons[h]?.mean ?? null} percent /> },
                    { key: "p", header: "P10 / P90", align: "right", cell: ([h]) => <span className="num text-ink-2">{pct(d.analogues?.horizons[h]?.p10 ?? null, 0)} / {pct(d.analogues?.horizons[h]?.p90 ?? null, 0)}</span> },
                    { key: "w", header: "Worst", align: "right", cell: ([h]) => <Pnl value={d.analogues?.horizons[h]?.worst ?? null} percent /> },
                    { key: "ru", header: "Median Runup", align: "right", cell: ([h]) => <span className="num text-ink-2">{pct(d.analogues?.horizons[h]?.maxRunupMedian ?? null, 0)}</span> },
                  ]}
                />
                <Notice>Analogien beschreiben die Verteilung vergangener Verläufe — sie sind keine Vorhersage für diesen Token.</Notice>
              </div>
            ) : (
              <div className="text-[12px] text-muted">Keine Analogien verfügbar (Index noch leer oder Token nicht im Live-Speicher).</div>
            )}
          </Card>

          <Card dense title="Letzte Trades" subtitle="Live-Tape">
            <Table
              rows={tape.data}
              rowKey={(r) => r.signature}
              maxHeight={380}
              columns={[
                { key: "t", header: "Zeit", cell: (r) => <span className="num text-ink-2">{dateTime(r.ts)}</span> },
                { key: "s", header: "Seite", cell: (r) => <span className={r.is_buy ? "text-good-text" : "text-bad"}>{r.is_buy ? "Kauf" : "Verkauf"}</span> },
                { key: "a", header: "SOL", align: "right", cell: (r) => <span className="num">{r.sol_amount.toFixed(4)}</span> },
                { key: "p", header: "Preis", align: "right", cell: (r) => <span className="num text-ink-2">{price(r.price_sol)}</span> },
                {
                  key: "w",
                  header: "Trader",
                  cell: (r) => (
                    <Link to={`/wallet-intel/${r.trader}`} className="num text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
                      {shortAddr(r.trader, 4)}
                    </Link>
                  ),
                },
              ]}
            />
          </Card>

          <Card dense title="Ereignisse" subtitle="mit späterem Verlauf">
            <Table rows={d.events} columns={eventColumns(false)} rowKey={(e) => String(e.id)} maxHeight={380} empty="Keine Ereignisse" />
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          {s?.discovery_reasons && s.discovery_reasons.length > 0 && (
            <Card title="Warum auffällig?">
              <ul className="space-y-1.5">
                {s.discovery_reasons.map((r, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 text-[12px]">
                    <span className="text-ink">{r.label}</span>
                    <span className="num text-muted">
                      {r.severity.toFixed(1)} · {ago(r.ts)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="Strategie-Abgleich" subtitle="Aktive Strategien und welche Bedingungen gerade erfüllt sind">
            {d.strategyMatches.length === 0 ? (
              <div className="text-[12px] text-muted">Keine aktiven Strategien</div>
            ) : (
              <div className="space-y-3">
                {d.strategyMatches.slice(0, 8).map((m) => (
                  <div key={m.strategyId} className="rounded-lg bg-surface-2 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <Link to={`/strategy-lab/${m.strategyId}`} className="text-[12px] text-ink hover:underline">
                        <span className="num text-muted">{m.strategyId}</span> {m.name}
                      </Link>
                      {m.matched ? <Badge status="ENTER">passt</Badge> : <span className="num text-[11px] text-muted">{pct(m.similarity, 0, false)}</span>}
                    </div>
                    <ul className="mt-1.5 space-y-0.5">
                      {m.conditions.map((c, i) => (
                        <li key={i} className="flex items-center gap-1.5 text-[11px]">
                          {c.holds ? <CheckCircle2 size={12} className="shrink-0 text-good-text" /> : <XCircle size={12} className="shrink-0 text-muted" />}
                          <span className={c.holds ? "num text-ink-2" : "num text-muted"}>{describeCondition(c.condition)}</span>
                          {c.condition.kind === "feature" && d.features && d.features[c.condition.feature] !== undefined && (
                            <span className="num ml-auto text-muted">= {Number(d.features[c.condition.feature]?.toPrecision(4))}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {(d.trades.paper.length > 0 || d.trades.live.length > 0) && (
            <Card dense title="Eigene Trades in diesem Token">
              <div className="divide-y divide-line/60">
                {[...d.trades.live.map((x) => ({ ...x, mode: "live" as const })), ...d.trades.paper.map((x) => ({ ...x, mode: "paper" as const }))].map((x) => (
                  <button key={x.id} onClick={() => nav(`/trades/${x.mode}/${x.id}`)} className="flex w-full items-center justify-between gap-2 px-4 py-1.5 text-left text-[11.5px] hover:bg-surface-2">
                    <span>
                      <Badge status={x.mode === "live" ? "LIVE_ENABLED" : "PAPER_TRADING"}>{x.mode}</Badge> <span className="num text-ink-2">{x.strategy_id}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <StatusBadge status={x.status} />
                      <Pnl value={x.net_pnl_sol} digits={5} />
                    </span>
                  </button>
                ))}
              </div>
            </Card>
          )}

          <Card title="Creator">
            {d.creator ? (
              <KV
                cols={1}
                items={[
                  [
                    "Adresse",
                    <Link key="c" to={`/wallet-intel/${d.creator.address}`} className="text-accent hover:underline">
                      {shortAddr(d.creator.address, 5)}
                    </Link>,
                  ],
                  ["Erstellte Tokens", d.creator.tokens_created],
                  ["Davon Curve abgeschlossen", d.creator.tokens_completed],
                  ["Schnelle Abverkäufe", d.creator.tokens_rugged],
                  ["Erster Token", dateTime(d.creator.first_created_at)],
                ]}
              />
            ) : (
              <div className="text-[12px] text-muted">{t?.creator ? shortAddr(t.creator, 5) : "unbekannt"}</div>
            )}
          </Card>

          <Card title="Token-Rechte">
            <KV
              cols={1}
              items={[
                ["Mint Authority", t?.mint_authority ? shortAddr(t.mint_authority, 5) : "keine / ungeprüft"],
                ["Freeze Authority", t?.freeze_authority ? shortAddr(t.freeze_authority, 5) : "keine / ungeprüft"],
                ["Curve abgeschlossen", t?.complete_at ? dateTime(t.complete_at) : "—"],
                ["AMM-Pool", t?.amm_pool ? shortAddr(t.amm_pool, 5) : "—"],
              ]}
            />
          </Card>

          <Card dense title="Top-Holder" subtitle="aus beobachteten Trades">
            <Table
              rows={d.holders}
              rowKey={(h) => h.owner}
              maxHeight={300}
              empty="—"
              columns={[
                { key: "o", header: "Wallet", cell: (h) => <Link to={`/wallet-intel/${h.owner}`} className="num text-accent hover:underline">{shortAddr(h.owner, 4)}</Link> },
                { key: "b", header: "Anteil", align: "right", cell: (h) => <span className="num">{pct(Number(h.balance) / 1e15, 2, false)}</span> },
                { key: "f", header: "Seit", align: "right", cell: (h) => <span className="num text-muted">{ago(h.first_acquired_at)}</span> },
              ]}
            />
          </Card>

          {d.features && (
            <Card dense title="Features (jetzt)" subtitle={`${Object.keys(d.features).length} berechnet · kausal, nur bereits verfügbare Daten`}>
              <div className="p-3">
                <input
                  value={featFilter}
                  onChange={(e) => setFeatFilter(e.target.value)}
                  placeholder="Filter…"
                  className="mb-2 h-7 w-full rounded-lg border border-line-strong bg-surface-2 px-2 text-[12px] outline-none focus:border-accent"
                />
                <div className="max-h-96 overflow-auto">
                  {features.map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-2 border-b border-line/40 py-0.5 text-[11px]">
                      <span className="num truncate text-ink-2">{k}</span>
                      <span className="num text-ink">{Number.isFinite(v) ? Number(v.toPrecision(4)) : "—"}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
