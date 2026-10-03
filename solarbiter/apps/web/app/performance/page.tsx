"use client";
import { useMemo, useState } from "react";
import { HBars, Scatter, TimeChart, VBars } from "@/components/charts";
import { Card, PageTitle, inputNarrow } from "@/components/ui";
import { useApi } from "@/lib/api";
import type { ChartsResponse } from "@/lib/types";

const euro = (v: number) => `${v.toFixed(4)} €`;

export default function Performance() {
  const [hours, setHours] = useState(168);
  const { data: c } = useApi<ChartsResponse>(`/api/charts?hours=${hours}`, 30_000);
  const equity = useMemo(() => [
    { name: "Paper", data: (c?.equityPaper ?? []).map((x) => ({ t: x.ts, v: x.equity })) },
    { name: "Live", data: (c?.equityLive ?? []).map((x) => ({ t: x.ts, v: x.equity })) },
  ], [c]);
  const daily = useMemo(() => [{ name: "Paper", kind: "histogram" as const, signColored: true, data: (c?.dailyPnl ?? []).map((x) => ({ t: x.day, v: x.paper })) }], [c]);
  const dailyLive = useMemo(() => [{ name: "Live", kind: "histogram" as const, signColored: true, data: (c?.dailyPnl ?? []).filter((x) => x.live !== 0).map((x) => ({ t: x.day, v: x.live })) }], [c]);
  const opps = useMemo(() => {
    const total = new Map<string, number>();
    const exec = new Map<string, number>();
    for (const r of c?.oppsOverTime ?? []) {
      total.set(r.t, (total.get(r.t) ?? 0) + r.n);
      if (r.status !== "REJECTED") exec.set(r.t, (exec.get(r.t) ?? 0) + r.n);
    }
    return [
      { name: "verifiziert", data: [...total.entries()].map(([t, v]) => ({ t, v })) },
      { name: "ausführbar / ausgeführt", data: [...total.keys()].map((t) => ({ t, v: exec.get(t) ?? 0 })) },
    ];
  }, [c]);
  const slip = useMemo(() => [
    { name: "erwartet", data: (c?.slippage ?? []).map((x) => ({ t: x.ts, v: x.predicted })) },
    { name: "realisiert", data: (c?.slippage ?? []).map((x) => ({ t: x.ts, v: x.realized })) },
  ], [c]);
  const score = useMemo(() => [{ name: "Learning-Score", data: (c?.learningScore ?? []).map((x) => ({ t: x.ts, v: x.score })) }], [c]);
  // all buckets (incl. under-/overflow) so the axis stays uniform
  const spread = Array.from({ length: 42 }, (_, b) => ({
    label: b === 0 ? "< −100 bps" : b === 41 ? "> +100 bps" : `${-100 + (b - 1) * 5} … ${-95 + (b - 1) * 5} bps`,
    value: (c?.spreadHist ?? []).find((x) => x.b === b)?.n ?? 0,
    color: b > 20 ? "#3987e5" : "#d95926",
  }));
  const latency = Array.from({ length: 27 }, (_, b) => ({
    label: b === 0 ? "< 0 ms" : b === 26 ? "> 5 s" : `${(b - 1) * 200}–${b * 200} ms`,
    value: (c?.latency ?? []).find((x) => x.b === b)?.n ?? 0,
  }));
  const calib = (c?.calibration ?? []).map((b) => ({ label: `P ${(b.predicted * 100).toFixed(0)} % → real ${(b.realized * 100).toFixed(0)} % (n=${b.n})`, value: b.realized * 100 }));
  const fees = (c?.fees ?? []).map((f) => ({ label: `${f.mode} · ${f.kind}`, value: f.eur }));
  const reasons = (c?.rejections ?? []).map((r) => ({ label: r.reason, value: r.n }));
  return (
    <div className="space-y-4">
      <PageTitle
        title="Performance"
        sub="Alle Kurven aus aufgezeichneten Daten — nichts ist geschätzt oder geglättet."
        right={<select className={`${inputNarrow} w-28`} value={hours} onChange={(e) => setHours(Number(e.target.value))}>{[6, 24, 168, 720, 2160].map((h) => <option key={h} value={h}>{h < 48 ? `${h} h` : `${h / 24} Tage`}</option>)}</select>}
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="1 · Equity-Kurven (realisiert, EUR)"><TimeChart series={equity} format={euro} /></Card>
        <Card title="2 · Tages-P&L Paper (▲ grün / ▼ rot)"><TimeChart series={daily} format={euro} /></Card>
        <Card title="3 · Tages-P&L Live"><TimeChart series={dailyLive} format={euro} /></Card>
        <Card title="4 · Opportunities im Zeitverlauf"><TimeChart series={opps} /></Card>
        <Card title="5 · Ablehnungsgründe (WHY NO TRADE)"><HBars items={reasons} format={(v) => v.toLocaleString("de-DE")} /></Card>
        <Card title="6 · Verteilung Brutto-Spread nach Firm-Quote (−100 … +100 bps)"><VBars bars={spread} xLabel="orange ≤ 0 bps · blau > 0 bps" /></Card>
        <Card title="7 · Erwarteter vs. realisierter Nettogewinn (Paper)"><Scatter points={(c?.predVsReal ?? []).map((p) => ({ x: p.predicted_eur, y: p.realized_eur ?? 0, ok: p.success }))} format={euro} /></Card>
        <Card title="8 · Slippage: erwartet vs. realisiert (bps)"><TimeChart series={slip} format={(v) => `${v.toFixed(1)} bps`} /></Card>
        <Card title="9 · Latenz Entscheidung → Ausführung"><VBars bars={latency} slot={2} xLabel="Bucket 200 ms" /></Card>
        <Card title="10 · Kalibrierung Ausführungswahrscheinlichkeit (realisierte Quote je Bucket)"><HBars items={calib} format={(v) => `${v.toFixed(0)} %`} slot={2} /></Card>
        <Card title="11 · Kosten nach Art (EUR)"><HBars items={fees} format={euro} slot={1} /></Card>
        <Card title="12 · Learning-Score"><TimeChart series={score} /></Card>
      </div>
    </div>
  );
}
