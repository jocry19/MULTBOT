/**
 * "Warum will der Bot diesen Trade machen?" — a plain-language explanation built only from the
 * recorded numbers of the opportunity (nothing is estimated here).
 */
export interface OpportunityRow {
  strategy_type: string;
  route: string[];
  route_dexes: string[];
  size_eur: number;
  sol_eur: number;
  input_amount: string;
  output_amount: string;
  gross_profit: string;
  dex_fees: string;
  network_fee: string;
  priority_fee: string;
  jito_tip: string;
  price_impact: number;
  expected_slippage: string;
  execution_probability: number;
  expected_failure_cost: string;
  safety_buffer: string;
  expected_net_profit: string;
  expected_net_profit_eur: number;
  quote_age_ms: number;
  status: string;
  rejection_reason: string | null;
  rejection_detail: string | null;
  costs: { midSpreadBps?: number; grossProfitBps?: number; usableEdgeBps?: number; rentLockedLamports?: string } | null;
}

const eur = (lamports: string | number, solEur: number): string => `${((Number(lamports) / 1e9) * solEur).toFixed(4)} €`;

export function explainOpportunity(o: OpportunityRow, symbol: (mint: string) => string): string[] {
  const path = o.route.map(symbol).join(" → ");
  const venues = o.route_dexes.join(" → ");
  const lines: string[] = [];
  lines.push(
    o.strategy_type === "direct"
      ? `Direkte Arbitrage ${path}: ${symbol(o.route[1] ?? "")} wird auf ${o.route_dexes[0]} gekauft und auf ${o.route_dexes[1]} verkauft — beides atomar in einer Transaktion.`
      : `Dreiecks-Arbitrage ${path} über ${venues} — alle Swaps atomar in einer Transaktion.`,
  );
  if (o.costs?.midSpreadBps !== undefined) lines.push(`Die Marginalpreise der Pools zeigten einen Spread von ${o.costs.midSpreadBps.toFixed(1)} bps.`);
  if (Number(o.input_amount) > 0) {
    lines.push(
      `Ausführbare Quotes (Größe ${o.size_eur.toFixed(2)} €): ${eur(o.input_amount, o.sol_eur)} rein, ${eur(o.output_amount, o.sol_eur)} zurück — brutto ${eur(o.gross_profit, o.sol_eur)}` +
        ` (DEX-Gebühren ${eur(o.dex_fees, o.sol_eur)} und Price Impact ${(o.price_impact * 1e4).toFixed(1)} bps sind darin bereits enthalten).`,
    );
    lines.push(
      `Davon gehen ab: erwartete Slippage ${eur(o.expected_slippage, o.sol_eur)}, Netzwerkgebühr ${eur(o.network_fee, o.sol_eur)}, Priority Fee ${eur(o.priority_fee, o.sol_eur)}, Jito-Tip ${eur(o.jito_tip, o.sol_eur)}.`,
    );
    lines.push(
      `Ausführungswahrscheinlichkeit ${(o.execution_probability * 100).toFixed(0)} % → erwartete Fehlschlagkosten ${eur(o.expected_failure_cost, o.sol_eur)}; Sicherheitspuffer ${eur(o.safety_buffer, o.sol_eur)}.`,
    );
    lines.push(`Übrig bleibt eine nutzbare Kante von ${o.expected_net_profit_eur.toFixed(4)} € (${(o.costs?.usableEdgeBps ?? 0).toFixed(1)} bps). Quote-Alter bei der Entscheidung: ${o.quote_age_ms} ms.`);
  }
  if (o.status === "REJECTED" || o.status === "FAILED") {
    lines.push(`Entscheidung: KEIN TRADE — ${o.rejection_reason ?? "abgelehnt"}${o.rejection_detail ? ` (${o.rejection_detail})` : ""}. NO NET EDGE = NO TRADE.`);
  } else {
    lines.push(
      `Entscheidung: TRADE (${o.status}). Die Schluss-Leg-Mindestausgabe deckt Einsatz, alle Gebühren, den Tip und den Mindestgewinn — bewegt sich der Markt vorher dagegen, wird die Transaktion rückgängig gemacht statt Geld zu verlieren.`,
    );
  }
  return lines;
}
