import { ArrowLeft, CheckCircle2, XCircle } from "lucide-react";
import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { describeCondition, type Condition } from "@multbot/shared";
import { useApi } from "../api/hooks";
import type { TradeRow } from "../api/types";
import { BarList, CandleChart, type Candle } from "../components/charts/charts";
import { totalCosts } from "../components/trades";
import { Badge, Card, ErrorBox, KV, Kpi, Loading, Notice, Pnl, StatusBadge, Table, toneOf } from "../components/ui";
import { dateTime, duration, pct, price, signed, sol } from "../lib/format";
import { SigLink } from "./Orders";

interface TradeFull extends TradeRow {
  name?: string | null;
  features: Record<string, number> | null;
  expected: {
    expectedNetReturn?: number | null;
    expectedSlippageSol?: number | null;
    breakEvenMove?: number | null;
    estimatedCostSol?: number | null;
    regimeCovered?: boolean | null;
    dataAgeSec?: number | null;
    trigger?: string;
    conditions?: { condition: Condition; holds: boolean }[];
  } | null;
  actual: { netReturn?: number; marketMove?: number; exitSpot?: number; peak?: number; trough?: number } | null;
  regime: { label?: string; levels?: Record<string, string> } | null;
}

interface Signal {
  id: string;
  ts: string;
  decision: string;
  reasons: { trigger?: string; conditions?: { condition: Condition; holds: boolean }[] };
  expected: TradeFull["expected"];
}

interface Learning {
  prediction: Record<string, unknown>;
  actual: Record<string, unknown>;
  prediction_error: number | null;
  decision_quality: string;
  outcome_quality: string;
  attribution: { exitReason?: string | null; regime?: string | null; slippageShare?: number | null; marketMove?: number | null; issues?: string[] };
  action: string | null;
}

interface Resp {
  trade: TradeFull | null;
  signal: Signal | null;
  learning: Learning | null;
  orders?: { id: string; kind: string; status: string; signature: string | null; attempts: number; created_at: string; confirmed_at: string | null; error: string | null }[];
  ledger?: { id: number; ts: string; entry_type: string; signature: string | null; hash: string }[];
}

const EXIT_TEXT: Record<string, string> = {
  TAKE_PROFIT: "Kursziel erreicht (Take Profit)",
  STOP_LOSS: "Stop Loss ausgelöst",
  TRAILING_STOP: "Trailing Stop ausgelöst",
  MAX_HOLD: "Maximale Haltedauer erreicht",
  SIGNAL_INVALIDATED: "Einstiegssignal ungültig geworden",
  MOMENTUM_REVERSAL: "Momentum hat gedreht",
  LIQUIDITY_DETERIORATION: "Liquidität verschlechtert",
  SELL_PRESSURE: "Starker Verkaufsdruck",
  STRATEGY_DEGRADED: "Strategie als DEGRADED markiert",
  EXPECTED_VALUE_NEGATIVE: "Erwartungswert des Haltens negativ",
  EMERGENCY_STOP: "Emergency Stop",
  MANUAL: "Manuell geschlossen",
  RECONCILIATION: "Durch Reconciliation geschlossen",
  EXIT_FAILED: "Ausstieg fehlgeschlagen",
};

export function TradeDetailPage() {
  const { mode = "paper", id = "" } = useParams();
  const nav = useNavigate();
  const q = useApi<Resp>(mode, `/api/${mode}/trades/${id}`, 10_000);
  const t = q.data?.trade;
  const candles = useApi<Candle[]>("token", t ? `/api/tokens/${t.mint}/candles?hours=24` : null);
  const around = useMemo(() => {
    if (!t || !candles.data) return [];
    const from = new Date(t.decision_ts).getTime() - 30 * 60_000;
    const to = (t.closed_at ? new Date(t.closed_at).getTime() : Date.now()) + 30 * 60_000;
    return candles.data.filter((c) => c.t >= from && c.t <= to);
  }, [t, candles.data]);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (!t) return <ErrorBox error="Trade nicht gefunden" />;
  const sig = q.data?.signal;
  const exp = t.expected ?? sig?.expected ?? null;
  const conditions = exp?.conditions ?? sig?.reasons.conditions ?? [];
  const trigger = exp?.trigger ?? sig?.reasons.trigger;
  const learning = q.data?.learning;
  const costs = totalCosts(t);
  const hold = t.opened_at ? ((t.closed_at ? new Date(t.closed_at).getTime() : Date.now()) - new Date(t.opened_at).getTime()) / 1000 : null;
  const costRows = [
    { label: "Slippage Einstieg", value: t.entry_slippage_sol },
    { label: "Slippage Ausstieg", value: t.exit_slippage_sol },
    { label: "DEX-Gebühren", value: t.entry_fees_sol + t.exit_fees_sol },
    { label: "Priority Fees", value: t.priority_fees_sol },
    { label: "Netzwerkgebühren", value: t.network_fees_sol },
    { label: "MEV / Latenz", value: t.mev_impact_sol },
    { label: "Rent netto", value: t.entry_rent_sol - t.exit_rent_refund_sol },
  ];

  return (
    <div className="space-y-4">
      <button onClick={() => nav(-1)} className="inline-flex items-center gap-1 text-[11.5px] text-muted hover:text-ink">
        <ArrowLeft size={13} /> zurück
      </button>
      <div className="flex flex-wrap items-center gap-2">
        <Badge status={mode === "live" ? "LIVE_ENABLED" : "PAPER_TRADING"}>{mode === "live" ? "LIVE — Echtgeld" : "PAPER"}</Badge>
        <h1 className="text-[18px] font-semibold tracking-tight">
          <Link to={`/token/${t.mint}`} className="hover:underline">
            {t.symbol ?? t.mint.slice(0, 8)}
          </Link>
        </h1>
        <StatusBadge status={t.status} />
        <Link to={`/strategy-lab/${t.strategy_id}`} className="num text-[12px] text-accent hover:underline">
          {t.strategy_version_id}
        </Link>
        <span className="num text-[11.5px] text-muted">{t.id}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
        <Kpi label="Einsatz" value={sol(t.position_size_sol, 4)} />
        <Kpi label="Brutto" value={<Pnl value={t.gross_pnl_sol} digits={5} />} tone={toneOf(t.gross_pnl_sol)} />
        <Kpi label="Kosten" value={sol(costs, 5)} detail={t.position_size_sol > 0 ? `${pct(costs / t.position_size_sol, 1, false)} des Einsatzes` : undefined} />
        <Kpi label="Netto" value={<Pnl value={t.net_pnl_sol} digits={5} />} tone={toneOf(t.net_pnl_sol)} detail={<Pnl value={t.net_return} percent />} />
        <Kpi label="Haltedauer" value={duration(hold)} />
        <Kpi label="Max. Runup" value={pct(t.max_runup, 1)} />
        <Kpi label="Max. Drawdown" value={pct(t.max_drawdown, 1)} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Warum wurde gekauft?" subtitle={`Entscheidung ${dateTime(t.decision_ts)}${trigger ? ` · Auslöser: ${trigger}` : ""}`}>
          <ul className="space-y-1">
            {conditions.map((c, i) => (
              <li key={i} className="flex items-center gap-2 text-[12px]">
                {c.holds ? <CheckCircle2 size={13} className="text-good-text" /> : <XCircle size={13} className="text-bad" />}
                <span className="num text-ink">{describeCondition(c.condition)}</span>
                {c.condition.kind === "feature" && t.features?.[c.condition.feature] !== undefined && (
                  <span className="num ml-auto text-muted">war {Number(t.features[c.condition.feature]?.toPrecision(4))}</span>
                )}
              </li>
            ))}
            {conditions.length === 0 && <li className="text-[12px] text-muted">Keine Bedingungen gespeichert</li>}
          </ul>
          <div className="mt-4">
            <KV
              cols={2}
              items={[
                ["Erwartete Netto-Rendite", <Pnl key="e" value={exp?.expectedNetReturn ?? null} percent />],
                ["Break-even-Bewegung", pct(exp?.breakEvenMove ?? null, 1)],
                ["Geschätzte Kosten", sol(exp?.estimatedCostSol ?? null, 5)],
                ["Erwartete Slippage", sol(exp?.expectedSlippageSol ?? null, 5)],
                ["Regime durch Belege gedeckt", exp?.regimeCovered === null || exp?.regimeCovered === undefined ? "—" : exp.regimeCovered ? "ja" : "nein"],
                ["Datenalter bei Entscheidung", exp?.dataAgeSec !== null && exp?.dataAgeSec !== undefined ? `${exp.dataAgeSec.toFixed(1)} s` : "—"],
                ["Regime", t.regime?.label?.replace(/_/g, " ") ?? "—"],
                ["Erwarteter Einstiegspreis", price((t as unknown as { expected_entry_price?: number | null }).expected_entry_price ?? null)],
              ]}
            />
          </div>
        </Card>

        <Card title="Was ist passiert?" subtitle={t.closed_at ? `geschlossen ${dateTime(t.closed_at)}` : "Position offen"}>
          <div className="space-y-3">
            <KV
              cols={2}
              items={[
                ["Einstieg", `${dateTime(t.opened_at)} @ ${price(t.entry_price)}`],
                ["Ausstieg", t.closed_at ? `${dateTime(t.closed_at)} @ ${price(t.exit_price)}` : "—"],
                ["Ausstiegsgrund", t.exit_reason ? (EXIT_TEXT[t.exit_reason] ?? t.exit_reason) : "—"],
                ["Marktbewegung", pct(t.actual?.marketMove ?? null, 1)],
                ["Fehlergrund", t.failed_reason ?? "—"],
                ["Brutto → Netto", `${signed(t.gross_pnl_sol, 5)} → ${signed(t.net_pnl_sol, 5)}`],
              ]}
            />
            <div>
              <div className="mb-2 text-[11px] text-muted">Kosten dieses Trades (SOL)</div>
              <BarList rows={costRows} format={(v) => v.toFixed(6)} />
            </div>
          </div>
        </Card>
      </div>

      {learning && (
        <Card title="Bewertung durch die Learning Engine" subtitle="Entscheidungsqualität wird getrennt vom Ergebnis beurteilt">
          <div className="grid gap-4 md:grid-cols-2">
            <KV
              cols={1}
              items={[
                ["Entscheidung", <Badge key="d" status={learning.decision_quality === "good" ? "PAPER_VALIDATED" : learning.decision_quality === "poor" ? "REJECTED" : "DEGRADED"}>{learning.decision_quality}</Badge>],
                ["Ergebnis", learning.outcome_quality],
                ["Prognosefehler", learning.prediction_error !== null ? pct(learning.prediction_error, 1) : "—"],
                ["Folgeaktion", learning.action ?? "keine"],
                ["Slippage-Anteil", pct(learning.attribution.slippageShare ?? null, 2, false)],
              ]}
            />
            <div>
              <div className="mb-1 text-[11px] text-muted">Auffälligkeiten</div>
              {(learning.attribution.issues ?? []).length > 0 ? (
                <ul className="space-y-1 text-[12px] text-amber-200">
                  {learning.attribution.issues?.map((i) => (
                    <li key={i}>· {i}</li>
                  ))}
                </ul>
              ) : (
                <div className="text-[12px] text-ink-2">Keine — die Entscheidung entsprach den Regeln und Annahmen.</div>
              )}
            </div>
          </div>
        </Card>
      )}

      {around.length > 0 && (
        <Card title="Kursverlauf rund um den Trade" subtitle="±30 min, 1-Minuten-Kerzen">
          <CandleChart candles={around} height={300} />
        </Card>
      )}

      {mode === "live" && (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card dense title="Orders">
            <Table
              rows={q.data?.orders}
              rowKey={(o) => o.id}
              empty="Keine"
              columns={[
                { key: "k", header: "Art", cell: (o) => <span className="uppercase">{o.kind}</span> },
                { key: "s", header: "Status", cell: (o) => <StatusBadge status={o.status} /> },
                { key: "a", header: "Versuche", align: "right", cell: (o) => <span className="num">{o.attempts}</span> },
                { key: "sig", header: "Signatur", cell: (o) => <SigLink sig={o.signature} /> },
                { key: "e", header: "Fehler", cell: (o) => <span className="text-rose-300">{o.error ?? ""}</span> },
              ]}
            />
          </Card>
          <Card dense title="Ledger-Einträge">
            <Table
              rows={q.data?.ledger}
              rowKey={(l) => String(l.id)}
              empty="Keine"
              columns={[
                { key: "t", header: "Zeit", cell: (l) => <span className="num text-ink-2">{dateTime(l.ts)}</span> },
                { key: "e", header: "Art", cell: (l) => <Badge>{l.entry_type}</Badge> },
                { key: "sig", header: "Signatur", cell: (l) => <SigLink sig={l.signature} /> },
                { key: "h", header: "Hash", cell: (l) => <span className="num text-[11px] text-muted">{l.hash.slice(0, 12)}…</span> },
              ]}
            />
          </Card>
        </div>
      )}

      {t.features && (
        <Card title="Merkmale zum Entscheidungszeitpunkt" subtitle="Nur Daten, die zum Zeitpunkt der Entscheidung verfügbar waren">
          <div className="grid grid-cols-1 gap-x-6 md:grid-cols-3">
            {Object.entries(t.features)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2 border-b border-line/40 py-0.5 text-[11px]">
                  <span className="num truncate text-ink-2">{k}</span>
                  <span className="num text-ink">{typeof v === "number" && Number.isFinite(v) ? Number(v.toPrecision(4)) : String(v)}</span>
                </div>
              ))}
          </div>
        </Card>
      )}
      {mode === "paper" && <Notice>Paper Trade: Ausführung simuliert mit den Kostenannahmen aus Settings → Research.</Notice>}
    </div>
  );
}
