import { useNavigate } from "react-router";
import { useApi } from "../api/hooks";
import type { TokenRow } from "../api/types";
import { Badge, Card, Notice, PageHeader, Pnl, Table, type Column } from "../components/ui";
import { ago, compact, pct, price } from "../lib/format";
import { TokenName, venueLabel } from "./Markets";

export interface EventStat {
  type: string;
  n: number;
  avg_ret_5m: number | null;
  median_ret_5m: number | null;
  positive_share: number | null;
}

export function DiscoveriesPage() {
  const nav = useNavigate();
  const disc = useApi<TokenRow[]>("discoveries", "/api/discoveries?limit=100", 5_000);
  const stats = useApi<EventStat[]>("events", "/api/events/stats", 60_000);

  const columns: Column<TokenRow>[] = [
    { key: "token", header: "Token", cell: (t) => <TokenName t={t} /> },
    { key: "venue", header: "Venue", cell: (t) => <Badge>{venueLabel(t.venue)}</Badge> },
    {
      key: "why",
      header: "Warum auffällig",
      cell: (t) => (
        <div className="flex max-w-[520px] flex-wrap gap-1 whitespace-normal">
          {t.discovery_reasons.slice(0, 6).map((r, i) => (
            <Badge key={i} status="DISCOVERED">
              {r.label}
              <span className="num opacity-70">{r.severity.toFixed(1)}</span>
            </Badge>
          ))}
        </div>
      ),
    },
    { key: "score", header: "Score", align: "right", cell: (t) => <span className="num">{t.discovery_score?.toFixed(1) ?? "—"}</span>, sort: (t) => t.discovery_score },
    { key: "price", header: "Preis", align: "right", cell: (t) => <span className="num">{price(t.price_sol)}</span> },
    { key: "c5", header: "Δ 5m", align: "right", cell: (t) => <Pnl value={t.price_change_5m} percent />, sort: (t) => t.price_change_5m },
    { key: "liq", header: "Liquidität", align: "right", cell: (t) => <span className="num">{compact(t.liquidity_sol)} SOL</span>, sort: (t) => t.liquidity_sol },
    { key: "vol", header: "Vol 5m", align: "right", cell: (t) => <span className="num">{compact(t.volume_sol_5m)}</span>, sort: (t) => t.volume_sol_5m },
    { key: "age", header: "Aktualisiert", align: "right", cell: (t) => <span className="num text-muted">{ago(t.updated_at)}</span> },
  ];

  const statCols: Column<EventStat>[] = [
    { key: "type", header: "Ereignis", cell: (s) => <span className="text-ink">{s.type}</span> },
    { key: "n", header: "Anzahl 7 T", align: "right", cell: (s) => <span className="num">{s.n}</span>, sort: (s) => s.n },
    { key: "avg", header: "Ø Rendite 5 min", align: "right", cell: (s) => <Pnl value={s.avg_ret_5m} percent />, sort: (s) => s.avg_ret_5m },
    { key: "med", header: "Median 5 min", align: "right", cell: (s) => <Pnl value={s.median_ret_5m} percent />, sort: (s) => s.median_ret_5m },
    { key: "pos", header: "Anteil positiv", align: "right", cell: (s) => <span className="num">{pct(s.positive_share, 0, false)}</span>, sort: (s) => s.positive_share },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Discoveries" subtitle="Ungewöhnliche Marktsituationen, erkannt relativ zu vergleichbaren Tokens (gleiches Alter, gleiche Venue)" />
      <Notice>
        Discoveries sind <b>Beobachtungen</b>, keine Kaufsignale. Ob eine Situation einen verwertbaren Vorteil hat, entscheidet erst die statistische Prüfung im
        Strategy Lab (nach Kosten, außerhalb der Stichprobe, mit Korrektur für multiples Testen).
      </Notice>
      <Card dense title="Aktuell auffällige Tokens" subtitle="letzte 15 Minuten">
        <Table rows={disc.data} columns={columns} rowKey={(t) => t.mint} onRowClick={(t) => nav(`/token/${t.mint}`)} maxHeight={560} empty="Gerade keine auffälligen Situationen" />
      </Card>
      <Card dense title="Was passierte historisch nach diesen Ereignissen?" subtitle="Marktbewegung 5 min nach dem Ereignis (Mid-Preis, ohne Handelskosten — nicht direkt handelbar)">
        <Table rows={stats.data} columns={statCols} rowKey={(s) => s.type} onRowClick={(s) => nav(`/events?type=${encodeURIComponent(s.type)}`)} maxHeight={480} empty="Noch keine abgeschlossenen Ereignis-Outcomes" />
      </Card>
    </div>
  );
}
