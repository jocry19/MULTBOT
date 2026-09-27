import { useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, RefreshCw, Send } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { api } from "../api/client";
import { useApi } from "../api/hooks";
import type { PortfolioSummary } from "../api/types";
import { Button, Card, ConfirmPhrase, ErrorBox, KV, Kpi, Notice, PageHeader, Table } from "../components/ui";
import { dateTime, shortAddr, sol } from "../lib/format";
import { SigLink } from "./Orders";

interface WalletInfo {
  configured: boolean;
  error: string | null;
  address: string | null;
  explorer: { solscan: string; solanaFm: string } | null;
  balanceSol: number | null;
  reserveSol: number;
  tradingCapitalSol: number | null;
  holdings: { mint: string; account: string; amount: string; ui: number; decimals: number }[];
  portfolio: PortfolioSummary;
  updatedAt: number | null;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function WalletPage() {
  const qc = useQueryClient();
  const w = useApi<WalletInfo>("wallet", "/api/wallet", 15_000);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<{ signature: string | null; status: string; error: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const d = w.data;
  const amt = Number(amount.replace(",", "."));
  const validTo = BASE58.test(to.trim());
  const validAmt = Number.isFinite(amt) && amt > 0;
  const maxSend = d?.balanceSol !== null && d?.balanceSol !== undefined ? Math.max(0, d.balanceSol - 0.000_01) : null;

  if (w.error) return <ErrorBox error={w.error} />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Wallet"
        subtitle="Bot-Wallet (Solana Mainnet). Der private Schlüssel bleibt verschlüsselt auf dem Server und wird nie angezeigt oder übertragen."
        actions={
          <Button
            onClick={async () => {
              setRefreshing(true);
              try {
                await api.post("/api/wallet/refresh");
                await qc.invalidateQueries({ queryKey: ["wallet"] });
              } finally {
                setRefreshing(false);
              }
            }}
            loading={refreshing}
          >
            <RefreshCw size={13} /> Aktualisieren
          </Button>
        }
      />
      {d && !d.configured && (
        <Notice tone="warn">
          <div className="space-y-1">
            <div>Keine Bot-Wallet konfiguriert{d.error ? ` (${d.error})` : ""}.</div>
            <div>
              Auf dem Server anlegen: <code className="num text-ink">pnpm wallet:create</code> (neue Wallet) oder <code className="num text-ink">pnpm wallet:import</code>. Die Passphrase
              wird über die Umgebungsvariable <code className="num text-ink">WALLET_KEYSTORE_PASSPHRASE</code> (oder <code className="num text-ink">WALLET_KEYSTORE_PASSPHRASE_FILE</code>) gesetzt. Danach Server neu starten.
            </div>
          </div>
        </Notice>
      )}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Kpi label="Kontostand" value={sol(d?.balanceSol ?? null, 5)} detail={d?.updatedAt ? `Stand ${dateTime(d.updatedAt)}` : undefined} />
        <Kpi label="Handelskapital" value={sol(d?.tradingCapitalSol ?? null, 5)} detail="Kontostand − Reserve" />
        <Kpi label="Reserve" value={sol(d?.reserveSol ?? null, 4)} detail="für Gebühren & Notfall-Exits" />
        <Kpi label="In Positionen" value={sol(d?.portfolio.lockedSol ?? null, 4)} detail={`${d?.portfolio.openPositions ?? 0} offen`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <Card title="Einzahlen" subtitle="SOL an diese Adresse senden (nur Solana Mainnet)">
          {d?.address ? (
            <div className="space-y-3">
              <div className="mx-auto w-fit rounded-lg bg-white p-3">
                <QRCodeSVG value={`solana:${d.address}`} size={176} />
              </div>
              <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
                <span className="num min-w-0 flex-1 break-all text-[11.5px] text-ink">{d.address}</span>
                <button
                  className="shrink-0 text-muted hover:text-ink"
                  title="Adresse kopieren"
                  onClick={async () => {
                    await navigator.clipboard.writeText(d.address as string);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  <Copy size={14} />
                </button>
              </div>
              {copied && <div className="text-[11px] text-good-text">Kopiert</div>}
              <div className="flex gap-3 text-[11.5px]">
                <a href={d.explorer?.solscan} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                  Solscan <ExternalLink size={11} />
                </a>
                <a href={d.explorer?.solanaFm} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                  SolanaFM <ExternalLink size={11} />
                </a>
              </div>
            </div>
          ) : (
            <div className="text-[12px] text-muted">Keine Wallet</div>
          )}
        </Card>

        <Card title="Senden / Auszahlen" subtitle="Zieladresse und Betrag werden serverseitig geprüft; die Transaktion wird vor dem Signieren simuliert">
          <div className="max-w-lg space-y-3">
            <div>
              <label className="mb-1 block text-[11px] text-muted">Zieladresse (Solana)</label>
              <input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="z. B. 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
                className="num w-full rounded-lg border border-line-strong bg-surface-2 px-3 py-2 text-[12px] outline-none focus:border-accent"
              />
              {to && !validTo && <div className="mt-1 text-[11px] text-bad">Keine gültige Solana-Adresse</div>}
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-muted">Betrag (SOL)</label>
              <div className="flex gap-2">
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.1" className="num w-40 rounded-lg border border-line-strong bg-surface-2 px-3 py-2 text-[12px] outline-none focus:border-accent" />
                {maxSend !== null && (
                  <Button size="sm" variant="ghost" onClick={() => setAmount(maxSend.toFixed(6))}>
                    Max ({maxSend.toFixed(4)})
                  </Button>
                )}
              </div>
              <div className="mt-1 text-[11px] text-muted">Netzwerkgebühr ca. 0,000005 SOL. Solange Positionen offen sind, bleibt die Reserve gesperrt.</div>
            </div>
            <Button variant="primary" disabled={!d?.configured || !validTo || !validAmt} onClick={() => setConfirm(true)}>
              <Send size={13} /> Senden…
            </Button>
            {result && (
              <div className="rounded-lg bg-surface-2 p-3 text-[12px]">
                <KV cols={1} items={[["Status", result.status], ["Signatur", <SigLink key="s" sig={result.signature} />], ...(result.error ? ([["Fehler", result.error]] as [string, string][]) : [])]} />
              </div>
            )}
          </div>
        </Card>
      </div>

      <Card dense title="Token-Bestände" subtitle="Direkt von der Blockchain">
        <Table
          rows={d?.holdings}
          rowKey={(h) => h.account}
          empty="Keine Token-Bestände"
          columns={[
            { key: "m", header: "Mint", cell: (h) => <span className="num text-ink">{shortAddr(h.mint, 6)}</span> },
            { key: "a", header: "Token-Konto", cell: (h) => <span className="num text-ink-2">{shortAddr(h.account, 6)}</span> },
            { key: "u", header: "Menge", align: "right", cell: (h) => <span className="num">{h.ui.toLocaleString("de-DE")}</span> },
            {
              key: "l",
              header: "",
              align: "right",
              cell: (h) => (
                <a href={`https://solscan.io/token/${h.mint}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline">
                  Explorer <ExternalLink size={11} />
                </a>
              ),
            },
          ]}
        />
      </Card>

      <ConfirmPhrase
        open={confirm}
        onClose={() => setConfirm(false)}
        title="SOL senden"
        phrase="SEND"
        danger
        description={
          <div className="space-y-2">
            <p>
              <b className="text-ink">{validAmt ? amt : "—"} SOL</b> an <span className="num break-all text-ink">{to.trim()}</span>
            </p>
            <Notice tone="warn">Blockchain-Transaktionen sind unumkehrbar. Prüfe die Zieladresse Zeichen für Zeichen.</Notice>
          </div>
        }
        onConfirm={async () => {
          const r = await api.post<{ signature: string | null; status: string; error: string | null }>("/api/wallet/send", { to: to.trim(), amountSol: amt, confirm: "SEND" });
          setResult(r);
          await qc.invalidateQueries({ queryKey: ["wallet"] });
        }}
      />
    </div>
  );
}
