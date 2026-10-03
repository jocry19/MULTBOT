import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import { useApi } from "../api/hooks";
import type { PositionRow } from "../api/types";
import { PositionsTable } from "../components/trades";
import { Card, ConfirmPhrase, Kpi, PageHeader, Pnl, Tabs, toneOf } from "../components/ui";
import { sol } from "../lib/format";

export function PositionsPage() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"live" | "paper">("live");
  const q = useApi<PositionRow[]>(mode, `/api/${mode}/positions`, 5_000);
  const [closing, setClosing] = useState<PositionRow | null>(null);
  const rows = q.data ?? [];
  const value = rows.reduce((s, p) => s + p.valueSol, 0);
  const cost = rows.reduce((s, p) => s + p.position_size_sol, 0);
  const unrealized = rows.reduce((s, p) => s + p.unrealizedSol, 0);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Positions"
        subtitle="Offene Positionen — Paper und Live strikt getrennt"
        actions={
          <Tabs
            value={mode}
            onChange={setMode}
            tabs={[
              { key: "live", label: "Live (Echtgeld)" },
              { key: "paper", label: "Paper" },
            ]}
          />
        }
      />
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Kpi label="Offene Positionen" value={rows.length} />
        <Kpi label="Eingesetzt" value={sol(cost, 4)} />
        <Kpi label="Liquidationswert" value={sol(value, 4)} />
        <Kpi label="Unrealisiert netto" value={<Pnl value={unrealized} />} tone={toneOf(unrealized)} />
      </div>
      <Card dense title={mode === "live" ? "Live-Positionen" : "Paper-Positionen"}>
        <PositionsTable rows={q.data} mode={mode} onClose={mode === "live" ? setClosing : undefined} />
      </Card>
      <ConfirmPhrase
        open={closing !== null}
        onClose={() => setClosing(null)}
        title="Position schließen"
        phrase="CLOSE"
        danger
        description={closing ? <p>Verkauft {closing.symbol ?? closing.mint} sofort (Wert ca. {sol(closing.valueSol, 5)}).</p> : null}
        onConfirm={async () => {
          if (closing) await api.post(`/api/live/positions/${closing.id}/close`);
          await qc.invalidateQueries({ queryKey: ["live"] });
        }}
      />
    </div>
  );
}
