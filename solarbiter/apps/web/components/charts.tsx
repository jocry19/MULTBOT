"use client";
import { AreaSeries, ColorType, HistogramSeries, LineSeries, createChart, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";
import { Empty } from "./ui";

/** Categorical series colours (validated on the chart surface) — assigned in fixed order. */
export const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500"] as const;
const SURFACE = "#1a1a19";
const GRID = "#262624";
const INK2 = "#c3c2b7";
const MUTE = "#8a897f";

export interface TimePoint {
  t: number | string;
  v: number;
}
export interface TimeSeriesDef {
  name: string;
  data: TimePoint[];
  kind?: "line" | "area" | "histogram";
  /** Index into SERIES (identity colour). Histograms of P&L use status colours per bar instead. */
  slot?: number;
  signColored?: boolean;
}

function toSeconds(p: TimePoint[]): { time: UTCTimestamp; value: number }[] {
  const byT = new Map<number, number>();
  for (const x of p) {
    const t = Math.floor((typeof x.t === "string" ? Date.parse(x.t) : x.t) / 1000);
    if (Number.isFinite(t) && Number.isFinite(x.v)) byT.set(t, x.v);
  }
  return [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time: time as UTCTimestamp, value }));
}

/** Time-axis chart (lightweight-charts): crosshair + hover values built in. One value axis. */
export function TimeChart({ series, height = 220, format }: { series: TimeSeriesDef[]; height?: number; format?: (v: number) => string }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const hasData = series.some((s) => s.data.length > 0);
  useEffect(() => {
    if (!ref.current || !hasData) return;
    const chart = createChart(ref.current, {
      autoSize: true,
      height,
      layout: { background: { type: ColorType.Solid, color: SURFACE }, textColor: INK2, fontSize: 11 },
      grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
      rightPriceScale: { borderColor: GRID },
      timeScale: { borderColor: GRID, timeVisible: true, secondsVisible: false },
      crosshair: { horzLine: { color: MUTE, labelBackgroundColor: "#2e2e2b" }, vertLine: { color: MUTE, labelBackgroundColor: "#2e2e2b" } },
      localization: format ? { priceFormatter: format } : undefined,
    });
    chartRef.current = chart;
    series.forEach((s, i) => {
      const color = SERIES[(s.slot ?? i) % SERIES.length] as string;
      const data = toSeconds(s.data);
      if (s.kind === "histogram") {
        const h = chart.addSeries(HistogramSeries, { color, priceLineVisible: false, title: series.length > 1 ? s.name : "" });
        h.setData(s.signColored ? data.map((d) => ({ ...d, color: d.value >= 0 ? "#0ca30c" : "#d03b3b" })) : data);
      } else if (s.kind === "area") {
        const a = chart.addSeries(AreaSeries, { lineColor: color, topColor: `${color}55`, bottomColor: `${color}05`, lineWidth: 2, priceLineVisible: false, title: series.length > 1 ? s.name : "" });
        a.setData(data);
      } else {
        const l = chart.addSeries(LineSeries, { color, lineWidth: 2, priceLineVisible: false, title: series.length > 1 ? s.name : "", pointMarkersVisible: data.length < 40, pointMarkersRadius: 3 });
        l.setData(data);
      }
    });
    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [series, height, format, hasData]);
  if (!hasData) return <Empty>Noch keine Daten</Empty>;
  return (
    <div>
      {series.length > 1 && <Legend items={series.map((s, i) => ({ name: s.name, color: SERIES[(s.slot ?? i) % SERIES.length] as string }))} />}
      <div ref={ref} style={{ height }} />
    </div>
  );
}

export function Legend({ items }: { items: { name: string; color: string }[] }) {
  return (
    <div className="mb-2 flex flex-wrap gap-3 text-[11px] text-ink2">
      {items.map((i) => (
        <span key={i.name} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ background: i.color }} />
          {i.name}
        </span>
      ))}
    </div>
  );
}

/** Horizontal bars for categories (reasons, fees …): value labels are always visible. */
export function HBars({ items, format = (v) => String(v), slot = 0 }: { items: { label: string; value: number; sub?: string }[]; format?: (v: number) => string; slot?: number }) {
  if (!items.length) return <Empty>Noch keine Daten</Empty>;
  const max = Math.max(...items.map((i) => Math.abs(i.value)), 1e-12);
  return (
    <div className="space-y-1.5">
      {items.map((i) => (
        <div key={i.label} className="group grid grid-cols-[minmax(120px,38%)_1fr_auto] items-center gap-2" title={`${i.label}: ${format(i.value)}${i.sub ? ` — ${i.sub}` : ""}`}>
          <span className="truncate text-[11px] text-ink2">{i.label}</span>
          <span className="h-3 rounded-r bg-bg">
            <span className="block h-3 rounded-r opacity-90 group-hover:opacity-100" style={{ width: `${Math.max(1, (Math.abs(i.value) / max) * 100)}%`, background: SERIES[slot] }} />
          </span>
          <span className="num text-[11px] text-ink">{format(i.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** Vertical bars over ordered buckets (distributions). Hover shows the exact bucket and count. */
export function VBars({ bars, height = 160, slot = 0, xLabel }: { bars: { label: string; value: number; color?: string }[]; height?: number; slot?: number; xLabel?: string }) {
  if (!bars.length || bars.every((b) => b.value === 0)) return <Empty>Noch keine Daten</Empty>;
  const max = Math.max(...bars.map((b) => b.value), 1e-12);
  return (
    <div>
      <div className="flex items-end gap-[2px]" style={{ height }}>
        {bars.map((b) => (
          <div key={b.label} className="group relative flex-1" style={{ height: "100%" }} title={`${b.label}: ${b.value}`}>
            <div className="absolute bottom-0 w-full rounded-t-[3px] opacity-85 group-hover:opacity-100" style={{ height: `${(b.value / max) * 100}%`, background: b.color ?? SERIES[slot] }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-mute">
        <span>{bars[0]?.label}</span>
        {xLabel && <span>{xLabel}</span>}
        <span>{bars[bars.length - 1]?.label}</span>
      </div>
    </div>
  );
}

/** Predicted vs realised scatter with the y = x reference (on target = on the line). */
export function Scatter({ points, height = 220, format = (v: number) => v.toFixed(4) }: { points: { x: number; y: number; ok?: boolean | null }[]; height?: number; format?: (v: number) => string }) {
  if (!points.length) return <Empty>Noch keine Daten</Empty>;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const lo = Math.min(...xs, ...ys);
  const hi = Math.max(...xs, ...ys);
  const pad = (hi - lo) * 0.08 || 1e-4;
  const a = lo - pad;
  const b = hi + pad;
  const W = 400;
  const H = 240;
  const sx = (v: number) => ((v - a) / (b - a)) * W;
  const sy = (v: number) => H - ((v - a) / (b - a)) * H;
  return (
    <div>
      <Legend items={[{ name: "gelandet", color: SERIES[0] }, { name: "fehlgeschlagen / revert", color: SERIES[1] }]} />
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height }} className="rounded bg-s1">
        <line x1={sx(a)} y1={sy(a)} x2={sx(b)} y2={sy(b)} stroke={MUTE} strokeDasharray="4 4" strokeWidth={1} />
        {a < 0 && b > 0 && <line x1={0} y1={sy(0)} x2={W} y2={sy(0)} stroke={GRID} strokeWidth={1} />}
        {points.map((p, i) => (
          <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={4} fill={p.ok === false ? SERIES[1] : SERIES[0]} stroke={SURFACE} strokeWidth={2}>
            <title>{`erwartet ${format(p.x)} · realisiert ${format(p.y)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-mute">
        <span>x: erwartet</span>
        <span>y: realisiert · gestrichelt: y = x</span>
      </div>
    </div>
  );
}
