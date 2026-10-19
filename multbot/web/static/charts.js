/* MULT Q2 – minimal canvas charting (no external dependencies). */
(function () {
  "use strict";
  const C = {
    grid: "#141c2b", axis: "#566079", text: "#8b93a7", up: "#23d18b", down: "#ff4f5e",
    amber: "#ffa028", cyan: "#3ad1ff", violet: "#b48cff", yellow: "#ffe066", white: "#e6e9ef", blue: "#2f81f7",
  };
  const PALETTE = ["#ffa028", "#3ad1ff", "#23d18b", "#b48cff", "#ff4f5e", "#ffe066", "#2f81f7", "#ff7ac6",
    "#7bdff2", "#c3e88d", "#f78c6c", "#89ddff", "#ffcb6b", "#a3be8c", "#d08770", "#bf616a", "#88c0d0",
    "#ebcb8b", "#b48ead", "#5e81ac"];

  function setup(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
    const h = canvas.clientHeight || canvas.parentElement.clientHeight || 150;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = "10px JetBrains Mono, Menlo, Consolas, monospace";
    return { ctx, w, h };
  }

  function niceNum(range, round) {
    const exp = Math.floor(Math.log10(range || 1));
    const f = range / Math.pow(10, exp);
    let nf;
    if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
    else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return nf * Math.pow(10, exp);
  }
  function ticks(min, max, n) {
    if (!isFinite(min) || !isFinite(max)) return [];
    if (min === max) { max = min + 1; }
    const step = niceNum(niceNum(max - min, false) / (n - 1), true);
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(+v.toPrecision(12));
    return out;
  }
  function fmtNum(v) {
    if (v === null || v === undefined || !isFinite(v)) return "-";
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (a >= 1e4) return (v / 1e3).toFixed(1) + "k";
    if (a >= 100) return v.toFixed(1);
    if (a >= 1) return v.toFixed(3);
    if (a >= 0.01) return v.toFixed(4);
    if (a === 0) return "0";
    return v.toPrecision(3);
  }
  function fmtTime(ms, span) {
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, "0");
    if (span > 2 * 86400000) return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}h`;
    return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }

  function frame(ctx, w, h, x0, x1, y0, y1, opts) {
    const L = opts.padL ?? 6, R = opts.padR ?? 58, T = opts.padT ?? 8, B = opts.padB ?? 16;
    const pw = w - L - R, ph = h - T - B;
    const sx = (x) => L + ((x - x0) / ((x1 - x0) || 1)) * pw;
    const sy = (y) => T + (1 - (y - y0) / ((y1 - y0) || 1)) * ph;
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = C.text;
    const yt = ticks(y0, y1, Math.max(3, Math.floor(ph / 32)));
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const v of yt) {
      const y = Math.round(sy(v)) + 0.5;
      if (y < T - 1 || y > T + ph + 1) continue;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
      ctx.fillText((opts.yFmt || fmtNum)(v), L + pw + 4, y);
    }
    if (opts.xType !== "none") {
      const span = x1 - x0;
      const n = Math.max(2, Math.floor(pw / 90));
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (let i = 0; i <= n; i++) {
        const x = x0 + (span * i) / n;
        const px = Math.round(sx(x)) + 0.5;
        ctx.beginPath(); ctx.moveTo(px, T); ctx.lineTo(px, T + ph); ctx.stroke();
        const lbl = opts.xType === "num" ? (opts.xFmt || fmtNum)(x) : fmtTime(x, span);
        ctx.fillText(lbl, Math.min(Math.max(px, L + 20), L + pw - 20), T + ph + 3);
      }
    }
    return { L, R, T, B, pw, ph, sx, sy, x0, x1, y0, y1 };
  }

  function extent(series, key) {
    let lo = Infinity, hi = -Infinity;
    for (const s of series) for (const p of s.data || []) {
      const v = p[key];
      if (v === null || v === undefined || !isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return [lo, hi];
  }

  function drawHV(ctx, f, opts) {
    for (const hl of opts.hlines || []) {
      if (hl.y === null || hl.y === undefined || !isFinite(hl.y)) continue;
      const y = Math.round(f.sy(hl.y)) + 0.5;
      if (y < f.T || y > f.T + f.ph) continue;
      ctx.setLineDash(hl.dash || [4, 3]);
      ctx.strokeStyle = hl.color || C.amber;
      ctx.beginPath(); ctx.moveTo(f.L, y); ctx.lineTo(f.L + f.pw, y); ctx.stroke();
      ctx.setLineDash([]);
      if (hl.label) {
        ctx.fillStyle = hl.color || C.amber;
        ctx.fillRect(f.L + f.pw + 1, y - 7, f.R - 2, 14);
        ctx.fillStyle = "#000";
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(hl.label, f.L + f.pw + 3, y);
      }
    }
    for (const vl of opts.vlines || []) {
      const x = Math.round(f.sx(vl.x)) + 0.5;
      if (x < f.L || x > f.L + f.pw) continue;
      ctx.setLineDash(vl.dash || [3, 3]);
      ctx.strokeStyle = vl.color || C.violet;
      ctx.beginPath(); ctx.moveTo(x, f.T); ctx.lineTo(x, f.T + f.ph); ctx.stroke();
      ctx.setLineDash([]);
      if (vl.label) { ctx.fillStyle = vl.color || C.violet; ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText(vl.label, x + 3, f.T + 2); }
    }
  }

  function drawMarkers(ctx, f, markers) {
    for (const m of markers || []) {
      const x = f.sx(m.x), y = f.sy(m.y);
      if (x < f.L || x > f.L + f.pw) continue;
      ctx.fillStyle = m.color || C.yellow;
      ctx.beginPath();
      if (m.shape === "up") { ctx.moveTo(x, y + 2); ctx.lineTo(x - 5, y + 11); ctx.lineTo(x + 5, y + 11); }
      else if (m.shape === "down") { ctx.moveTo(x, y - 2); ctx.lineTo(x - 5, y - 11); ctx.lineTo(x + 5, y - 11); }
      else if (m.shape === "x") { ctx.rect(x - 3, y - 3, 6, 6); }
      else ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function attachHover(canvas, f, getText) {
    canvas._hover = { f, getText };
    if (canvas._hoverBound) return;
    canvas._hoverBound = true;
    const tip = document.getElementById("tooltip");
    canvas.addEventListener("mousemove", (ev) => {
      const h = canvas._hover;
      if (!h) return;
      const r = canvas.getBoundingClientRect();
      const px = ev.clientX - r.left;
      const x = h.f.x0 + ((px - h.f.L) / h.f.pw) * (h.f.x1 - h.f.x0);
      const txt = h.getText(x, px);
      if (!txt) { tip.style.display = "none"; return; }
      tip.textContent = txt;
      tip.style.display = "block";
      tip.style.left = Math.min(ev.clientX + 14, window.innerWidth - 300) + "px";
      tip.style.top = ev.clientY + 12 + "px";
    });
    canvas.addEventListener("mouseleave", () => { tip.style.display = "none"; });
  }

  function nearest(data, x) {
    let lo = 0, hi = data.length - 1;
    if (hi < 0) return -1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (data[mid][0] < x) lo = mid; else hi = mid; }
    return Math.abs(data[lo][0] - x) < Math.abs(data[hi][0] - x) ? lo : hi;
  }

  /* line / area chart. series: [{data:[[x,y]], color, width, fill, dash, label, step}] */
  function line(canvas, opts) {
    const { ctx, w, h } = setup(canvas);
    const series = (opts.series || []).filter((s) => s.data && s.data.length);
    if (!series.length) { empty(ctx, w, h, opts.empty); return; }
    let [x0, x1] = extent(series, 0);
    let [y0, y1] = extent(series, 1);
    for (const hl of opts.hlines || []) if (hl.include && isFinite(hl.y)) { y0 = Math.min(y0, hl.y); y1 = Math.max(y1, hl.y); }
    if (opts.yMin !== undefined) y0 = Math.min(y0, opts.yMin);
    if (opts.yMax !== undefined) y1 = Math.max(y1, opts.yMax);
    if (opts.fixedY) { y0 = opts.fixedY[0]; y1 = opts.fixedY[1]; }
    const pad = (y1 - y0) * 0.06 || Math.abs(y1) * 0.01 || 1;
    if (!opts.fixedY) { y0 -= pad; y1 += pad; }
    const f = frame(ctx, w, h, x0, x1, y0, y1, opts);
    if (opts.zero && y0 < 0 && y1 > 0) {
      ctx.strokeStyle = "#3a4560"; const y = Math.round(f.sy(0)) + 0.5;
      ctx.beginPath(); ctx.moveTo(f.L, y); ctx.lineTo(f.L + f.pw, y); ctx.stroke();
    }
    for (const s of series) {
      ctx.strokeStyle = s.color || C.amber;
      ctx.lineWidth = s.width || 1.4;
      ctx.setLineDash(s.dash || []);
      ctx.beginPath();
      let started = false, lastY = null;
      for (const p of s.data) {
        if (p[1] === null || p[1] === undefined || !isFinite(p[1])) { started = false; continue; }
        const X = f.sx(p[0]), Y = f.sy(p[1]);
        if (!started) { ctx.moveTo(X, Y); started = true; }
        else if (s.step) { ctx.lineTo(X, lastY); ctx.lineTo(X, Y); }
        else ctx.lineTo(X, Y);
        lastY = Y;
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (s.fill) {
        const base = f.sy(Math.max(y0, Math.min(y1, s.fillBase ?? y0)));
        ctx.lineTo(f.sx(s.data[s.data.length - 1][0]), base);
        ctx.lineTo(f.sx(s.data[0][0]), base);
        ctx.closePath();
        ctx.globalAlpha = 0.12; ctx.fillStyle = s.color || C.amber; ctx.fill(); ctx.globalAlpha = 1;
      }
    }
    drawHV(ctx, f, opts);
    drawMarkers(ctx, f, opts.markers);
    if (opts.lastLabel !== false) {
      const s = series[0];
      const lp = s.data[s.data.length - 1];
      if (lp && isFinite(lp[1])) {
        const y = f.sy(lp[1]);
        ctx.fillStyle = s.color || C.amber;
        ctx.fillRect(f.L + f.pw + 1, y - 7, f.R - 2, 14);
        ctx.fillStyle = "#000"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText((opts.yFmt || fmtNum)(lp[1]), f.L + f.pw + 3, y);
      }
    }
    attachHover(canvas, f, (x) => {
      const lines = [];
      for (const s of series) {
        const i = nearest(s.data, x);
        if (i < 0) continue;
        if (!lines.length) lines.push(opts.xType === "num" ? `x = ${fmtNum(s.data[i][0])}` : new Date(s.data[i][0]).toISOString().replace("T", " ").slice(0, 19) + " UTC");
        lines.push(`${s.label || "y"}: ${(opts.yFmt || fmtNum)(s.data[i][1])}`);
      }
      return lines.join("\n");
    });
  }

  /* candlestick chart with overlays and an optional volume strip */
  function candles(canvas, d) {
    const { ctx, w, h } = setup(canvas);
    const n = (d.t || []).length;
    if (!n) { empty(ctx, w, h); return; }
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { lo = Math.min(lo, d.l[i]); hi = Math.max(hi, d.h[i]); }
    for (const hl of d.hlines || []) if (hl.include && isFinite(hl.y)) { lo = Math.min(lo, hl.y); hi = Math.max(hi, hl.y); }
    const pad = (hi - lo) * 0.06 || hi * 0.002;
    lo -= pad; hi += pad;
    const volH = d.volume ? Math.floor(h * 0.16) : 0;
    const step = n > 1 ? (d.t[n - 1] - d.t[0]) / (n - 1) : 60000;
    const f = frame(ctx, w, h - volH, d.t[0] - step / 2, d.t[n - 1] + step / 2, lo, hi, { yFmt: d.yFmt });
    const bw = Math.max(1, (f.pw / n) * 0.7);
    for (const ov of d.overlays || []) {
      ctx.strokeStyle = ov.color; ctx.lineWidth = ov.width || 1; ctx.setLineDash(ov.dash || []);
      ctx.beginPath(); let st = false;
      for (let i = 0; i < n; i++) {
        const v = ov.data[i];
        if (v === null || v === undefined || !isFinite(v)) { st = false; continue; }
        const X = f.sx(d.t[i]), Y = f.sy(v);
        if (!st) { ctx.moveTo(X, Y); st = true; } else ctx.lineTo(X, Y);
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
    for (let i = 0; i < n; i++) {
      const X = f.sx(d.t[i]);
      const upc = d.c[i] >= d.o[i];
      ctx.strokeStyle = ctx.fillStyle = upc ? C.up : C.down;
      ctx.beginPath(); ctx.moveTo(Math.round(X) + 0.5, f.sy(d.h[i])); ctx.lineTo(Math.round(X) + 0.5, f.sy(d.l[i])); ctx.stroke();
      const y1 = f.sy(Math.max(d.o[i], d.c[i])), y2 = f.sy(Math.min(d.o[i], d.c[i]));
      ctx.fillRect(X - bw / 2, y1, bw, Math.max(1, y2 - y1));
    }
    drawHV(ctx, f, d);
    drawMarkers(ctx, f, d.markers);
    const lastC = d.c[n - 1];
    const ly = f.sy(lastC);
    ctx.fillStyle = C.amber; ctx.fillRect(f.L + f.pw + 1, ly - 7, f.R - 2, 14);
    ctx.fillStyle = "#000"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText((d.yFmt || fmtNum)(lastC), f.L + f.pw + 3, ly);
    if (volH) {
      let vmax = 0; for (let i = 0; i < n; i++) vmax = Math.max(vmax, d.v[i] || 0);
      const top = h - volH + 2;
      for (let i = 0; i < n; i++) {
        const vh = vmax ? ((d.v[i] || 0) / vmax) * (volH - 18) : 0;
        ctx.fillStyle = d.c[i] >= d.o[i] ? "rgba(35,209,139,.45)" : "rgba(255,79,94,.45)";
        ctx.fillRect(f.sx(d.t[i]) - bw / 2, top + (volH - 18) - vh, bw, vh);
      }
      ctx.fillStyle = C.text; ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText("Vol " + fmtNum(vmax), f.L + 2, top);
    }
    attachHover(canvas, f, (x) => {
      let i = 0, best = Infinity;
      for (let k = 0; k < n; k++) { const dd = Math.abs(d.t[k] - x); if (dd < best) { best = dd; i = k; } }
      const t = new Date(d.t[i]).toISOString().replace("T", " ").slice(0, 16);
      const lines = [`${t} UTC`, `O ${fmtNum(d.o[i])}  H ${fmtNum(d.h[i])}`, `L ${fmtNum(d.l[i])}  C ${fmtNum(d.c[i])}`, `Vol ${fmtNum(d.v[i])}`];
      for (const ov of d.overlays || []) if (ov.label && isFinite(ov.data[i])) lines.push(`${ov.label} ${fmtNum(ov.data[i])}`);
      return lines.join("\n");
    });
  }

  /* horizontal / vertical bars: items [{label, value, color}] */
  function bars(canvas, opts) {
    const { ctx, w, h } = setup(canvas);
    const items = opts.items || [];
    if (!items.length) { empty(ctx, w, h, opts.empty); return; }
    if (opts.vertical) {
      let mx = 0, mn = 0;
      for (const it of items) { mx = Math.max(mx, it.value); mn = Math.min(mn, it.value); }
      const f = frame(ctx, w, h, 0, items.length, mn, mx || 1, { xType: "none", yFmt: opts.fmt, padB: 14 });
      const bw = f.pw / items.length;
      items.forEach((it, i) => {
        const y0 = f.sy(0), y1 = f.sy(it.value);
        ctx.fillStyle = it.color || (it.value >= 0 ? C.up : C.down);
        ctx.fillRect(f.L + i * bw + 1, Math.min(y0, y1), Math.max(1, bw - 2), Math.abs(y1 - y0));
        if (opts.labels !== false && bw > 14) {
          ctx.fillStyle = C.text; ctx.textAlign = "center"; ctx.textBaseline = "top";
          ctx.fillText(String(it.label), f.L + i * bw + bw / 2, f.T + f.ph + 2);
        }
      });
      attachHover(canvas, f, (x) => { const i = Math.floor(x); const it = items[i]; return it ? `${it.label}: ${(opts.fmt || fmtNum)(it.value)}${it.tip ? "\n" + it.tip : ""}` : ""; });
      return;
    }
    const labelW = opts.labelW || 110;
    const rowH = Math.min(18, (h - 4) / items.length);
    let mx = 0;
    for (const it of items) mx = Math.max(mx, Math.abs(it.value));
    const hasNeg = items.some((it) => it.value < 0);
    const x0 = labelW, pw = w - labelW - 60;
    const zero = hasNeg ? x0 + pw / 2 : x0;
    const scale = mx ? (hasNeg ? pw / 2 : pw) / mx : 0;
    items.forEach((it, i) => {
      const y = 2 + i * rowH;
      ctx.fillStyle = C.text; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(String(it.label).slice(0, 18), labelW - 6, y + rowH / 2);
      ctx.fillStyle = it.color || (it.value >= 0 ? C.up : C.down);
      const bwid = Math.abs(it.value) * scale;
      ctx.fillRect(it.value >= 0 ? zero : zero - bwid, y + 2, Math.max(1, bwid), rowH - 4);
      ctx.fillStyle = C.white; ctx.textAlign = "left";
      ctx.fillText((opts.fmt || fmtNum)(it.value), x0 + pw + 4, y + rowH / 2);
    });
    if (hasNeg) { ctx.strokeStyle = "#3a4560"; ctx.beginPath(); ctx.moveTo(zero + 0.5, 0); ctx.lineTo(zero + 0.5, h); ctx.stroke(); }
  }

  function fan(canvas, opts) {
    const { ctx, w, h } = setup(canvas);
    const fanD = opts.fan || {};
    const steps = opts.steps || [];
    if (!steps.length) { empty(ctx, w, h, opts.empty); return; }
    const all = [].concat(...Object.values(fanD));
    const f = frame(ctx, w, h, steps[0], steps[steps.length - 1], Math.min(...all, opts.start || 0) * 0.98,
      Math.max(...all) * 1.02, { xType: "num", xFmt: (v) => Math.round(v) + "" });
    const band = (a, b, alpha) => {
      ctx.beginPath();
      steps.forEach((s, i) => { const X = f.sx(s), Y = f.sy(fanD[a][i]); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
      for (let i = steps.length - 1; i >= 0; i--) ctx.lineTo(f.sx(steps[i]), f.sy(fanD[b][i]));
      ctx.closePath(); ctx.globalAlpha = alpha; ctx.fillStyle = C.amber; ctx.fill(); ctx.globalAlpha = 1;
    };
    band("5", "95", 0.12); band("25", "75", 0.25);
    ctx.strokeStyle = C.amber; ctx.lineWidth = 1.6; ctx.beginPath();
    steps.forEach((s, i) => { const X = f.sx(s), Y = f.sy(fanD["50"][i]); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
    ctx.stroke();
    drawHV(ctx, f, { hlines: [{ y: opts.start, color: C.cyan, label: "Start" }] });
    attachHover(canvas, f, (x) => {
      let i = 0, best = Infinity; steps.forEach((s, k) => { if (Math.abs(s - x) < best) { best = Math.abs(s - x); i = k; } });
      return `Trade ${steps[i]}\n95%: ${fmtNum(fanD["95"][i])}\n75%: ${fmtNum(fanD["75"][i])}\nMedian: ${fmtNum(fanD["50"][i])}\n25%: ${fmtNum(fanD["25"][i])}\n5%: ${fmtNum(fanD["5"][i])}`;
    });
  }

  function hist(canvas, opts) {
    const vals = (opts.values || []).filter((v) => isFinite(v));
    if (!vals.length) { const { ctx, w, h } = setup(canvas); empty(ctx, w, h, opts.empty); return; }
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const nb = opts.bins || 20;
    const width = (hi - lo) / nb || 1;
    const counts = new Array(nb).fill(0);
    for (const v of vals) counts[Math.min(nb - 1, Math.floor((v - lo) / width))]++;
    bars(canvas, {
      vertical: true, labels: false, fmt: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)),
      items: counts.map((c, i) => {
        const mid = lo + (i + 0.5) * width;
        return { label: fmtNum(mid), value: c, color: mid >= 0 ? C.up : C.down, tip: `${fmtNum(lo + i * width)} … ${fmtNum(lo + (i + 1) * width)}` };
      }),
    });
  }

  function spark(canvas, data, color) {
    const { ctx, w, h } = setup(canvas);
    const vals = data.filter((v) => isFinite(v));
    if (vals.length < 2) return;
    const lo = Math.min(...vals), hi = Math.max(...vals);
    ctx.strokeStyle = color || C.amber; ctx.lineWidth = 1; ctx.beginPath();
    data.forEach((v, i) => {
      const X = (i / (data.length - 1)) * (w - 2) + 1;
      const Y = h - 2 - ((v - lo) / ((hi - lo) || 1)) * (h - 4);
      i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
    });
    ctx.stroke();
  }

  function empty(ctx, w, h, msg) {
    ctx.fillStyle = C.axis; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(msg || "keine Daten", w / 2, h / 2);
  }

  window.Charts = { line, candles, bars, fan, hist, spark, fmtNum, C, PALETTE };
})();
