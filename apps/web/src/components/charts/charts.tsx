import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Charts follow the dataviz rules: 2px lines, ~10% area wash, hairline solid grid, crosshair +
 * tooltip listing every series, single axis, legend for ≥2 series, values never gated behind
 * hover (callers provide a table view next to the chart).
 */

const CHART_COLORS = {
  surface: "#101216",
  text: "#7d848f",
  grid: "#1c1f25",
  axis: "#33373f",
  series: ["#3987e5", "#d95926", "#199e70"],
  good: "#0ca30c",
  bad: "#e66767",
};

export interface SeriesSpec {
  name: string;
  data: { t: number; v: number }[];
  kind?: "line" | "area";
}

function toTime(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

/** Make timestamps strictly increasing (lightweight-charts requirement). */
function uniq(points: { t: number; v: number }[]): { time: UTCTimestamp; value: number }[] {
  const out: { time: UTCTimestamp; value: number }[] = [];
  let last = -Infinity;
  for (const p of [...points].sort((a, b) => a.t - b.t)) {
    let t = toTime(p.t) as number;
    if (t <= last) t = last + 1;
    last = t;
    out.push({ time: t as UTCTimestamp, value: p.v });
  }
  return out;
}

function baseOptions(height: number) {
  return {
    height,
    layout: { background: { type: ColorType.Solid, color: CHART_COLORS.surface }, textColor: CHART_COLORS.text, fontSize: 11, attributionLogo: false },
    // explicit locale: the browser default can be an invalid BCP-47 tag (e.g. "en-US@posix")
    localization: { locale: "de-DE" },
    grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
    rightPriceScale: { borderColor: CHART_COLORS.axis },
    timeScale: { borderColor: CHART_COLORS.axis, timeVisible: true, secondsVisible: false },
    crosshair: { mode: CrosshairMode.Magnet, vertLine: { color: "#4b5160", labelBackgroundColor: "#262a32" }, horzLine: { color: "#4b5160", labelBackgroundColor: "#262a32" } },
    autoSize: true,
  };
}

function Tooltip({ lines, x, y }: { lines: { name: string; value: string; color: string }[]; x: number; y: number }) {
  return (
    <div className="pointer-events-none absolute z-20 rounded-lg border border-line-strong bg-surface-2/95 px-2.5 py-1.5 text-[11px] shadow-lg" style={{ left: Math.max(4, x + 12), top: Math.max(4, y - 10) }}>
      {lines.map((l) => (
        <div key={l.name} className="flex items-center gap-2">
          <span className="inline-block h-0.5 w-3 rounded" style={{ background: l.color }} />
          <span className="num font-semibold text-ink">{l.value}</span>
          <span className="text-muted">{l.name}</span>
        </div>
      ))}
    </div>
  );
}

/** Line / area time series (≤3 series). */
export function TimeSeriesChart({ series, height = 220, format = (v: number) => v.toFixed(4), zeroLine }: { series: SeriesSpec[]; height?: number; format?: (v: number) => string; zeroLine?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; lines: { name: string; value: string; color: string }[] } | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart: IChartApi = createChart(ref.current, baseOptions(height));
    const apis: { api: ISeriesApi<SeriesType>; name: string; color: string }[] = [];
    series.slice(0, 3).forEach((s, i) => {
      const color = CHART_COLORS.series[i] ?? CHART_COLORS.series[0]!;
      const api =
        s.kind === "line"
          ? chart.addSeries(LineSeries, { color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true })
          : chart.addSeries(AreaSeries, { lineColor: color, topColor: `${color}26`, bottomColor: `${color}05`, lineWidth: 2, priceLineVisible: false });
      api.setData(uniq(s.data));
      if (zeroLine && i === 0) api.createPriceLine({ price: 0, color: CHART_COLORS.axis, lineWidth: 1, lineStyle: 0, axisLabelVisible: false });
      apis.push({ api: api as ISeriesApi<SeriesType>, name: s.name, color });
    });
    chart.applyOptions({ localization: { locale: "de-DE", priceFormatter: format } });
    chart.timeScale().fitContent();
    chart.subscribeCrosshairMove((param) => {
      if (!param.point || !param.time) {
        setTip(null);
        return;
      }
      const lines = apis
        .map((a) => {
          const d = param.seriesData.get(a.api) as { value?: number } | undefined;
          return d?.value !== undefined ? { name: a.name, value: format(d.value), color: a.color } : null;
        })
        .filter((l): l is { name: string; value: string; color: string } => l !== null);
      setTip(lines.length ? { x: param.point.x, y: param.point.y, lines } : null);
    });
    return () => chart.remove();
  }, [series, height, format, zeroLine]);

  return (
    <div className="relative">
      {series.length >= 2 && (
        <div className="mb-2 flex flex-wrap gap-3 text-[11px] text-ink-2">
          {series.slice(0, 3).map((s, i) => (
            <span key={s.name} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4 rounded" style={{ background: CHART_COLORS.series[i] }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div ref={ref} style={{ height }} />
      {tip && <Tooltip {...tip} />}
    </div>
  );
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  bv: number;
  sv: number;
}

/** Price candles (up = hollow, down = filled → not colour-only) + volume in a second pane. */
export function CandleChart({ candles, height = 320 }: { candles: Candle[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; lines: { name: string; value: string; color: string }[] } | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, { ...baseOptions(height), rightPriceScale: { borderColor: CHART_COLORS.axis, scaleMargins: { top: 0.08, bottom: 0.05 } } });
    const cs = chart.addSeries(CandlestickSeries, {
      upColor: CHART_COLORS.surface,
      borderUpColor: CHART_COLORS.good,
      wickUpColor: CHART_COLORS.good,
      downColor: CHART_COLORS.bad,
      borderDownColor: CHART_COLORS.bad,
      wickDownColor: CHART_COLORS.bad,
      priceFormat: { type: "custom", formatter: (p: number) => (p >= 0.01 ? p.toFixed(4) : p.toExponential(2)), minMove: 1e-12 },
    });
    const seen = new Set<number>();
    const rows = [...candles].sort((a, b) => a.t - b.t).filter((c) => {
      const k = toTime(c.t);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    cs.setData(rows.map((c) => ({ time: toTime(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));
    const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false }, 1);
    vol.setData(rows.map((c) => ({ time: toTime(c.t), value: c.bv + c.sv, color: c.c >= c.o ? `${CHART_COLORS.good}99` : `${CHART_COLORS.bad}99` })));
    const panes = chart.panes();
    panes[1]?.setHeight(Math.round(height * 0.22));
    chart.timeScale().fitContent();
    chart.subscribeCrosshairMove((param) => {
      if (!param.point || !param.time) return setTip(null);
      const d = param.seriesData.get(cs) as { open: number; high: number; low: number; close: number } | undefined;
      const v = param.seriesData.get(vol) as { value: number } | undefined;
      if (!d) return setTip(null);
      const f = (p: number) => (p >= 0.01 ? p.toFixed(4) : p.toExponential(3));
      setTip({
        x: param.point.x,
        y: param.point.y,
        lines: [
          { name: "Close", value: f(d.close), color: d.close >= d.open ? CHART_COLORS.good : CHART_COLORS.bad },
          { name: "High / Low", value: `${f(d.high)} / ${f(d.low)}`, color: "#7d848f" },
          { name: "Volumen SOL", value: (v?.value ?? 0).toFixed(3), color: "#7d848f" },
        ],
      });
    });
    return () => chart.remove();
  }, [candles, height]);
  return (
    <div className="relative">
      <div ref={ref} style={{ height }} />
      {tip && <Tooltip {...tip} />}
    </div>
  );
}

/** Per-trade net result bars over time (good/bad + sign in tooltip). */
export function PnlBars({ points, height = 160 }: { points: { t: number; v: number }[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; lines: { name: string; value: string; color: string }[] } | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, baseOptions(height));
    const s = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: { type: "custom", formatter: (v: number) => v.toFixed(4), minMove: 1e-6 } });
    s.setData(uniq(points).map((p) => ({ ...p, color: p.value >= 0 ? CHART_COLORS.good : CHART_COLORS.bad })));
    chart.timeScale().fitContent();
    chart.subscribeCrosshairMove((param) => {
      if (!param.point || !param.time) return setTip(null);
      const d = param.seriesData.get(s) as { value: number } | undefined;
      if (!d) return setTip(null);
      setTip({ x: param.point.x, y: param.point.y, lines: [{ name: "Netto SOL", value: `${d.value >= 0 ? "+" : "−"}${Math.abs(d.value).toFixed(5)}`, color: d.value >= 0 ? CHART_COLORS.good : CHART_COLORS.bad }] });
    });
    return () => chart.remove();
  }, [points, height]);
  return (
    <div className="relative">
      <div ref={ref} style={{ height }} />
      {tip && <Tooltip {...tip} />}
    </div>
  );
}

/**
 * Horizontal bars (HTML): ≤ 20px thick, 4px rounded data end, value label at the tip,
 * single colour for one series; signed values grow from a centre baseline in good/bad.
 */
export function BarList({ rows, format = (v: number) => v.toFixed(2), signed = false, maxRows = 20 }: { rows: { label: ReactNode; value: number; hint?: string }[]; format?: (v: number) => string; signed?: boolean; maxRows?: number }) {
  const data = rows.slice(0, maxRows);
  const max = Math.max(1e-12, ...data.map((r) => Math.abs(r.value)));
  return (
    <div className="space-y-1.5">
      {data.map((r, i) => {
        // leave room at the tip for the value label
        const w = (Math.abs(r.value) / max) * (signed ? 36 : 78);
        const color = signed ? (r.value >= 0 ? "var(--color-good)" : "var(--color-bad)") : "var(--color-series-1)";
        return (
          <div key={i} className="group grid grid-cols-[minmax(90px,38%)_1fr] items-center gap-2" title={r.hint ?? `${format(r.value)}`}>
            <div className="truncate text-[11.5px] text-ink-2">{r.label}</div>
            <div className="relative h-4">
              {signed && <div className="absolute inset-y-0 left-1/2 w-px bg-axis" />}
              <div
                className="absolute top-0.5 h-3 transition-opacity group-hover:opacity-80"
                style={{
                  background: color,
                  width: `${Math.max(0.5, w)}%`,
                  left: signed ? (r.value >= 0 ? "50%" : `${50 - w}%`) : 0,
                  borderRadius: signed ? (r.value >= 0 ? "0 4px 4px 0" : "4px 0 0 4px") : "0 4px 4px 0",
                }}
              />
              <span
                className="num absolute top-0 text-[10.5px] text-ink-2"
                style={signed ? (r.value >= 0 ? { left: `calc(${50 + w}% + 4px)` } : { right: `calc(${50 + w}% + 4px)` }) : { left: `calc(${w}% + 4px)` }}
              >
                {signed && r.value > 0 ? "+" : ""}
                {format(r.value)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Tiny inline sparkline (de-emphasis hue). */
export function Sparkline({ values, width = 90, height = 24 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return <span className="text-muted">—</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * width},${height - ((v - min) / span) * (height - 2) - 1}`).join(" ");
  const up = (values[values.length - 1] as number) >= (values[0] as number);
  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden>
      <polyline points={pts} fill="none" stroke={up ? CHART_COLORS.good : CHART_COLORS.bad} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
