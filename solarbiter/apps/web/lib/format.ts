export const eur = (v: number | null | undefined, digits = 2): string => (v === null || v === undefined || !Number.isFinite(v) ? "–" : `${v.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits })} €`);
export const eur4 = (v: number | null | undefined): string => eur(v, 4);
export const signed = (v: number | null | undefined, digits = 4): string => (v === null || v === undefined ? "–" : `${v > 0 ? "+" : ""}${eur(v, digits)}`);
export const bps = (v: number | null | undefined, digits = 1): string => (v === null || v === undefined || !Number.isFinite(v) ? "–" : `${v.toFixed(digits)} bps`);
export const pct = (v: number | null | undefined, digits = 1): string => (v === null || v === undefined || !Number.isFinite(v) ? "–" : `${(v * 100).toFixed(digits)} %`);
export const sol = (lamports: string | number | bigint | null | undefined, digits = 4): string => (lamports === null || lamports === undefined ? "–" : `${(Number(lamports) / 1e9).toFixed(digits)} SOL`);
export const lamportsEur = (lamports: string | number | null | undefined, solEur: number | null | undefined): number | null => (lamports === null || lamports === undefined || !solEur ? null : (Number(lamports) / 1e9) * solEur);
export const ms = (v: number | null | undefined): string => (v === null || v === undefined ? "–" : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`);
export const short = (s: string | null | undefined, n = 4): string => (!s ? "–" : s.length <= 2 * n + 1 ? s : `${s.slice(0, n)}…${s.slice(-n)}`);
export function ago(ts: number | string | null | undefined): string {
  if (ts === null || ts === undefined) return "–";
  const t = typeof ts === "string" ? Date.parse(ts) : ts;
  const d = Date.now() - t;
  if (d < 60_000) return `${Math.max(0, Math.round(d / 1000))} s`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)} min`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} h`;
  return `${Math.round(d / 86_400_000)} d`;
}
export const time = (ts: number | string | null | undefined): string => (ts === null || ts === undefined ? "–" : new Date(ts).toLocaleString("de-DE", { hour12: false }));
