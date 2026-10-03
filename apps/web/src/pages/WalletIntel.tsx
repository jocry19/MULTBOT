import { ArrowLeft, ExternalLink } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useApi } from "../api/hooks";
import { Badge, Card, ErrorBox, KV, Kpi, Loading, Notice, PageHeader, Pnl, Table, Tabs, toneOf, type Column } from "../components/ui";
import { dateTime, duration, pct, shortAddr, sol } from "../lib/format";

interface WalletRow {
  address: string;
  firstSeenAt: string;
  trades: number;
  tokensTraded: number;
  volumeSol: number;
  realizedPnlSol: number;
  closedPositions: number;
  winRate: number;
  meanReturn: number;
  skill: number;
  avgHoldSec: number | null;
  avgEntrySol: number | null;
  earlyEntryRate: number;
  clusterId: number | null;
  tokensCreated: number;
}

interface ClusterRow {
  id: number;
  created_at: string;
  method: string;
  size: number;
  members: string[];
  features: Record<string, unknown>;
  stats: Record<string, number>;
}

type Sort = "skill" | "pnl" | "trades" | "early";

export function WalletIntelPage() {
  const nav = useNavigate();
  const [sort, setSort] = useState<Sort>("skill");
  const q = useApi<WalletRow[]>("wallets", `/api/wallets?sort=${sort}&limit=200`, 60_000);
  const clusters = useApi<ClusterRow[]>("wallets", "/api/wallet-clusters", 120_000);
  const columns: Column<WalletRow>[] = [
    { key: "a", header: "Wallet", cell: (w) => <span className="num text-ink">{shortAddr(w.address, 6)}</span> },
    { key: "sk", header: "Skill", align: "right", cell: (w) => <span className="num">{w.skill.toFixed(2)}</span>, sort: (w) => w.skill },
    { key: "pnl", header: "Realisiert", align: "right", cell: (w) => <Pnl value={w.realizedPnlSol} digits={3} />, sort: (w) => w.realizedPnlSol },
    { key: "wr", header: "Trefferquote", align: "right", cell: (w) => <span className="num">{pct(w.winRate, 0, false)}</span>, sort: (w) => w.winRate },
    { key: "mr", header: "Ø Rendite", align: "right", cell: (w) => <Pnl value={w.meanReturn} percent />, sort: (w) => w.meanReturn },
    { key: "cp", header: "Geschl. Positionen", align: "right", cell: (w) => <span className="num">{w.closedPositions}</span>, sort: (w) => w.closedPositions },
    { key: "t", header: "Trades", align: "right", cell: (w) => <span className="num text-ink-2">{w.trades}</span>, sort: (w) => w.trades },
    { key: "v", header: "Volumen", align: "right", cell: (w) => <span className="num text-ink-2">{w.volumeSol.toFixed(1)}</span>, sort: (w) => w.volumeSol },
    { key: "h", header: "Ø Haltedauer", align: "right", cell: (w) => <span className="num text-ink-2">{duration(w.avgHoldSec)}</span>, sort: (w) => w.avgHoldSec },
    { key: "e", header: "Früh-Einstiege", align: "right", cell: (w) => <span className="num text-ink-2">{pct(w.earlyEntryRate, 0, false)}</span>, sort: (w) => w.earlyEntryRate },
    { key: "c", header: "Creator", align: "right", cell: (w) => <span className="num text-ink-2">{w.tokensCreated || ""}</span> },
    { key: "cl", header: "Cluster", align: "right", cell: (w) => (w.clusterId !== null ? <Badge>#{w.clusterId}</Badge> : "") },
  ];
  return (
    <div className="space-y-4">
      <PageHeader
        title="Wallet Intelligence"
        subtitle="Verhalten von Tradern auf Pump.fun, rekonstruiert aus beobachteten Trades"
        actions={
          <Tabs<Sort>
            value={sort}
            onChange={setSort}
            tabs={[
              { key: "skill", label: "Skill" },
              { key: "pnl", label: "P&L" },
              { key: "trades", label: "Aktivität" },
              { key: "early", label: "Früh" },
            ]}
          />
        }
      />
      <Notice>
        „Skill“ ist eine geschrumpfte Schätzung der durchschnittlichen Rendite je Position (wenige Positionen → Richtung 0). Eine hohe Bewertung beweist keinen Vorteil:
        Überlebenseffekt und Zufall spielen bei vielen Wallets eine große Rolle.
      </Notice>
      <Card dense title="Wallets">
        <Table rows={q.data} columns={columns} rowKey={(w) => w.address} onRowClick={(w) => nav(`/wallet-intel/${w.address}`)} maxHeight={640} empty="Noch keine Wallets mit genügend Historie" />
      </Card>
      <Card dense title="Wallet-Cluster" subtitle="Wallets mit ähnlichem Verhalten (z. B. koordinierte Käufe, Bundles)">
        <Table
          rows={clusters.data}
          rowKey={(c) => String(c.id)}
          maxHeight={420}
          empty="Keine Cluster"
          columns={[
            { key: "i", header: "#", cell: (c) => <span className="num text-muted">{c.id}</span> },
            { key: "m", header: "Methode", cell: (c) => <span className="text-ink-2">{c.method}</span> },
            { key: "s", header: "Größe", align: "right", cell: (c) => <span className="num">{c.size}</span> },
            {
              key: "mem",
              header: "Mitglieder",
              cell: (c) => (
                <div className="flex max-w-[520px] flex-wrap gap-1 whitespace-normal">
                  {c.members.slice(0, 8).map((m) => (
                    <Link key={m} to={`/wallet-intel/${m}`} className="num text-[11px] text-accent hover:underline">
                      {shortAddr(m, 4)}
                    </Link>
                  ))}
                  {c.size > 8 && <span className="text-[11px] text-muted">+{c.size - 8}</span>}
                </div>
              ),
            },
            {
              key: "st",
              header: "Kennzahlen",
              cell: (c) => (
                <span className="num text-[11px] text-ink-2">
                  {Object.entries(c.stats)
                    .slice(0, 4)
                    .map(([k, v]) => `${k}: ${typeof v === "number" ? Number(v.toPrecision(3)) : String(v)}`)
                    .join(" · ")}
                </span>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}

interface WalletDetail {
  wallet: Record<string, unknown> & { address: string; first_seen_at: string; last_seen_at: string; trade_count: number; realized_pnl_sol: number; closed_positions: number; winning_positions: number; volume_sol: number; tokens_created: number; labels: string[] };
  profile: Record<string, number | string | null> | null;
  positions: { mint: string; symbol: string | null; cost_sol: number; proceeds_sol: number; buys: number; sells: number; first_buy_at: string | null; first_buy_age_sec: number | null; last_trade_at: string; closed_at: string | null; realized_pnl_sol: number | null }[];
  events: { id: number; ts: string; type: string; mint: string | null; data: Record<string, unknown> }[];
  cluster: ClusterRow | null;
}

export function WalletDetailPage() {
  const { address = "" } = useParams();
  const nav = useNavigate();
  const q = useApi<WalletDetail>("wallets", `/api/wallets/${address}`, 60_000);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data;
  if (!d) return null;
  const w = d.wallet;
  return (
    <div className="space-y-4">
      <button onClick={() => nav("/wallet-intel")} className="inline-flex items-center gap-1 text-[11.5px] text-muted hover:text-ink">
        <ArrowLeft size={13} /> Wallet Intelligence
      </button>
      <PageHeader
        title={shortAddr(w.address, 8)}
        subtitle={
          <span className="num">
            {w.address}{" "}
            <a href={`https://solscan.io/account/${w.address}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
              Solscan <ExternalLink size={11} />
            </a>
          </span>
        }
        actions={w.labels?.map((l) => <Badge key={l}>{l}</Badge>)}
      />
      <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
        <Kpi label="Realisiert" value={<Pnl value={w.realized_pnl_sol} digits={3} />} tone={toneOf(w.realized_pnl_sol)} />
        <Kpi label="Positionen" value={w.closed_positions} detail={`${w.winning_positions} Gewinner`} />
        <Kpi label="Trefferquote" value={w.closed_positions ? pct(w.winning_positions / w.closed_positions, 0, false) : "—"} />
        <Kpi label="Trades" value={w.trade_count} />
        <Kpi label="Volumen" value={sol(w.volume_sol, 2)} />
        <Kpi label="Beobachtet seit" value={<span className="text-[13px]">{dateTime(w.first_seen_at)}</span>} detail={`zuletzt ${dateTime(w.last_seen_at)}`} />
      </div>
      {d.profile && (
        <Card title="Verhaltensprofil">
          <KV cols={3} items={Object.entries(d.profile).map(([k, v]) => [k, typeof v === "number" ? Number(v.toPrecision(4)) : String(v ?? "—")])} />
        </Card>
      )}
      <Card dense title="Positionen" subtitle="je Token (letzte 100)">
        <Table
          rows={d.positions}
          rowKey={(p) => p.mint}
          maxHeight={520}
          onRowClick={(p) => nav(`/token/${p.mint}`)}
          columns={[
            { key: "t", header: "Token", cell: (p) => <span className="text-ink">{p.symbol ?? shortAddr(p.mint, 5)}</span> },
            { key: "f", header: "Erster Kauf", cell: (p) => <span className="num text-ink-2">{dateTime(p.first_buy_at)}</span> },
            { key: "age", header: "Token-Alter bei Kauf", align: "right", cell: (p) => <span className="num text-ink-2">{duration(p.first_buy_age_sec)}</span> },
            { key: "b", header: "Käufe / Verkäufe", align: "right", cell: (p) => <span className="num">{p.buys} / {p.sells}</span> },
            { key: "c", header: "Kosten", align: "right", cell: (p) => <span className="num">{p.cost_sol.toFixed(4)}</span> },
            { key: "pr", header: "Erlös", align: "right", cell: (p) => <span className="num">{p.proceeds_sol.toFixed(4)}</span> },
            { key: "pnl", header: "Realisiert", align: "right", cell: (p) => <Pnl value={p.realized_pnl_sol} digits={4} /> },
            { key: "cl", header: "Geschlossen", cell: (p) => <span className="num text-muted">{p.closed_at ? dateTime(p.closed_at) : "offen"}</span> },
          ]}
        />
      </Card>
      {d.cluster && (
        <Card title={`Cluster #${d.cluster.id}`} subtitle={`${d.cluster.method} · ${d.cluster.size} Wallets`}>
          <div className="flex flex-wrap gap-1.5">
            {d.cluster.members.slice(0, 30).map((m) => (
              <Link key={m} to={`/wallet-intel/${m}`} className="num text-[11px] text-accent hover:underline">
                {shortAddr(m, 4)}
              </Link>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
