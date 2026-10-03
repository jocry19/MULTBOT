import { useQueryClient } from "@tanstack/react-query";
import { Download, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { api } from "../api/client";
import { useApi } from "../api/hooks";
import { Badge, Button, Card, ErrorBox, Kpi, Notice, PageHeader, Pnl, Table, Tabs, type Column } from "../components/ui";
import { dateTime, shortAddr } from "../lib/format";
import { SigLink } from "./Orders";

interface TxRow {
  signature: string;
  slot: number;
  ts: string | null;
  type: string;
  status: string;
  sol_change_lamports: number;
  fee_lamports: number;
  token_mint: string | null;
  token_change: string | null;
  counterparty: string | null;
  live_trade_id: string | null;
}

interface LedgerRow {
  id: number;
  ts: string;
  entry_type: string;
  trade_id: string | null;
  signature: string | null;
  data: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

interface TaxSummary {
  year: number;
  disclaimer: string;
  disposals: number;
  gains: number | null;
  losses: number | null;
  unknown: number;
}

interface TaxLot {
  id: number;
  asset: string;
  acquired_at: string;
  quantity: string;
  remaining: string;
  cost_eur: number | null;
  cost_sol: number | null;
  fees_eur: number;
  source: string;
  signature: string | null;
  notes: string | null;
}

const eur = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toLocaleString("de-DE", { style: "currency", currency: "EUR" }));

export function TransactionsPage() {
  const [tab, setTab] = useState<"chain" | "ledger" | "tax">("chain");
  return (
    <div className="space-y-4">
      <PageHeader
        title="Transactions"
        subtitle="On-Chain-Historie der Bot-Wallet, unveränderliches Ledger und steuerliche Dokumentation"
        actions={
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { key: "chain", label: "On-Chain" },
              { key: "ledger", label: "Ledger" },
              { key: "tax", label: "Steuer (DE)" },
            ]}
          />
        }
      />
      {tab === "chain" && <ChainTab />}
      {tab === "ledger" && <LedgerTab />}
      {tab === "tax" && <TaxTab />}
    </div>
  );
}

function ChainTab() {
  const q = useApi<TxRow[]>("wallet", "/api/wallet/transactions?limit=500", 30_000);
  const columns: Column<TxRow>[] = [
    { key: "ts", header: "Zeit", cell: (t) => <span className="num text-ink-2">{dateTime(t.ts)}</span> },
    { key: "type", header: "Typ", cell: (t) => <Badge>{t.type}</Badge> },
    { key: "st", header: "Status", cell: (t) => <Badge status={t.status === "success" ? "CONFIRMED" : "FAILED"}>{t.status}</Badge> },
    { key: "sol", header: "SOL-Änderung", align: "right", cell: (t) => <Pnl value={t.sol_change_lamports / 1e9} digits={6} /> },
    { key: "fee", header: "Gebühr", align: "right", cell: (t) => <span className="num text-ink-2">{(t.fee_lamports / 1e9).toFixed(6)}</span> },
    { key: "tok", header: "Token", cell: (t) => <span className="num text-ink-2">{shortAddr(t.token_mint, 5)}</span> },
    { key: "tc", header: "Token-Änderung (raw)", align: "right", cell: (t) => <span className="num text-ink-2">{t.token_change ?? "—"}</span> },
    { key: "cp", header: "Gegenpartei", cell: (t) => <span className="num text-ink-2">{shortAddr(t.counterparty, 5)}</span> },
    { key: "sig", header: "Signatur", cell: (t) => <SigLink sig={t.signature} /> },
  ];
  return (
    <Card dense>
      <Table rows={q.data} columns={columns} rowKey={(t) => t.signature} maxHeight={760} empty="Keine Transaktionen (Wallet leer oder nicht konfiguriert)" />
    </Card>
  );
}

function LedgerTab() {
  const q = useApi<LedgerRow[]>("live", "/api/ledger?limit=500", 30_000);
  const [verify, setVerify] = useState<{ ok: boolean; entries: number; brokenAt: number | null } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const columns: Column<LedgerRow>[] = [
    { key: "id", header: "#", cell: (r) => <span className="num text-muted">{r.id}</span> },
    { key: "ts", header: "Zeit", cell: (r) => <span className="num text-ink-2">{dateTime(r.ts)}</span> },
    { key: "t", header: "Art", cell: (r) => <Badge>{r.entry_type}</Badge> },
    { key: "trade", header: "Trade", cell: (r) => <span className="num text-ink-2">{r.trade_id ? `${r.trade_id.slice(0, 8)}…` : "—"}</span> },
    { key: "sig", header: "Signatur", cell: (r) => <SigLink sig={r.signature} /> },
    { key: "d", header: "Daten", cell: (r) => <span className="num block max-w-[380px] truncate text-[11px] text-ink-2" title={JSON.stringify(r.data)}>{JSON.stringify(r.data)}</span> },
    { key: "h", header: "Hash", cell: (r) => <span className="num text-[11px] text-muted">{r.hash.slice(0, 12)}…</span> },
  ];
  return (
    <div className="space-y-4">
      <Card
        title="Hash-Kette"
        subtitle="Jeder Eintrag enthält den Hash des vorherigen; Änderungen oder Löschungen werden von der Datenbank verhindert und wären hier sichtbar"
        actions={
          <Button
            onClick={async () => {
              setErr(null);
              try {
                setVerify(await api.get("/api/ledger/verify"));
              } catch (e) {
                setErr(e);
              }
            }}
          >
            <ShieldCheck size={13} /> Integrität prüfen
          </Button>
        }
      >
        {verify ? (
          <div className={verify.ok ? "text-[12px] text-good-text" : "text-[12px] text-bad"}>
            {verify.ok ? `✓ Ledger intakt — ${verify.entries} Einträge geprüft` : `✗ Kette unterbrochen bei Eintrag #${verify.brokenAt}`}
          </div>
        ) : (
          <div className="text-[12px] text-muted">Noch nicht geprüft</div>
        )}
        {err !== null && <ErrorBox error={err} />}
      </Card>
      <Card dense>
        <Table rows={q.data} columns={columns} rowKey={(r) => String(r.id)} maxHeight={640} empty="Ledger ist leer" />
      </Card>
    </div>
  );
}

function TaxTab() {
  const qc = useQueryClient();
  const [year, setYear] = useState(new Date().getUTCFullYear());
  const summary = useApi<TaxSummary>("tax", `/api/tax/summary?year=${year}`);
  const lots = useApi<TaxLot[]>("tax", "/api/tax/lots");
  const [declare, setDeclare] = useState<Record<number, string>>({});
  const [err, setErr] = useState<unknown>(null);
  const s = summary.data;
  return (
    <div className="space-y-4">
      <Notice tone="warn">{s?.disclaimer ?? "Keine Steuerberatung."}</Notice>
      <div className="flex flex-wrap items-center gap-2">
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="h-7 rounded-lg border border-line-strong bg-surface-2 px-2 text-[12px]">
          {Array.from({ length: 5 }, (_, i) => new Date().getUTCFullYear() - i).map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        {(["csv", "xlsx", "json"] as const).map((f) => (
          <a key={f} href={`/api/tax/export?format=${f}&year=${year}`} className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-line-strong bg-surface-2 px-2.5 text-[12px] hover:bg-surface-3">
            <Download size={13} /> {f.toUpperCase()}
          </a>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Kpi label="Veräußerungen" value={s?.disposals ?? "—"} detail={`Jahr ${year}`} />
        <Kpi label="Gewinne" value={eur(s?.gains)} tone="good" />
        <Kpi label="Verluste" value={eur(s?.losses)} tone="bad" />
        <Kpi label="Ohne Anschaffungskosten" value={s?.unknown ?? "—"} detail="Kostenbasis unbekannt" tone={s?.unknown ? "warn" : "neutral"} />
      </div>
      {err !== null && <ErrorBox error={err} />}
      <Card dense title="Anschaffungen (FIFO-Lots)" subtitle="Einzahlungen ohne bekannte Kostenbasis können hier nachgetragen werden">
        <Table
          rows={lots.data}
          rowKey={(l) => String(l.id)}
          maxHeight={560}
          empty="Keine Lots"
          columns={[
            { key: "d", header: "Erworben", cell: (l) => <span className="num text-ink-2">{dateTime(l.acquired_at)}</span> },
            { key: "a", header: "Asset", cell: (l) => <span className="num">{l.asset === "SOL" ? "SOL" : shortAddr(l.asset, 5)}</span> },
            { key: "src", header: "Quelle", cell: (l) => <Badge>{l.source}</Badge> },
            { key: "q", header: "Menge", align: "right", cell: (l) => <span className="num">{Number(l.quantity).toLocaleString("de-DE", { maximumFractionDigits: 6 })}</span> },
            { key: "r", header: "Rest", align: "right", cell: (l) => <span className="num text-ink-2">{Number(l.remaining).toLocaleString("de-DE", { maximumFractionDigits: 6 })}</span> },
            {
              key: "c",
              header: "Kosten EUR",
              align: "right",
              cell: (l) =>
                l.cost_eur !== null ? (
                  <span className="num">{eur(l.cost_eur)}</span>
                ) : l.source === "deposit" ? (
                  <span className="inline-flex items-center gap-1">
                    <input
                      value={declare[l.id] ?? ""}
                      onChange={(e) => setDeclare({ ...declare, [l.id]: e.target.value })}
                      placeholder="EUR"
                      className="num h-6 w-20 rounded border border-line-strong bg-surface-2 px-1.5 text-right text-[11px]"
                    />
                    <Button
                      size="xs"
                      onClick={async () => {
                        setErr(null);
                        const v = Number((declare[l.id] ?? "").replace(",", "."));
                        if (!Number.isFinite(v) || v < 0) return setErr("Ungültiger Betrag");
                        try {
                          await api.post("/api/tax/declare-cost-basis", { lotId: l.id, costEur: v });
                          await qc.invalidateQueries({ queryKey: ["tax"] });
                        } catch (e) {
                          setErr(e);
                        }
                      }}
                    >
                      Speichern
                    </Button>
                  </span>
                ) : (
                  <span className="text-muted">unbekannt</span>
                ),
            },
            { key: "n", header: "Notiz", cell: (l) => <span className="text-muted">{l.notes ?? ""}</span> },
          ]}
        />
      </Card>
    </div>
  );
}
