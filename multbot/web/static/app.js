/* MULTBOT Terminal – Bloomberg-style front end for the paper-trading engine. */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const CH = window.Charts;

  const PAGES = [
    { key: "MON", f: "F1", name: "MONITOR" }, { key: "ASSET", f: "F2", name: "ASSET" },
    { key: "SIG", f: "F3", name: "SIGNALE" }, { key: "LRN", f: "F4", name: "LERNEN" },
    { key: "RISK", f: "F5", name: "RISIKO" }, { key: "RES", f: "F6", name: "FORSCHUNG" },
    { key: "BLTR", f: "F7", name: "BLOTTER" }, { key: "JRNL", f: "F8", name: "JOURNAL" },
    { key: "SYS", f: "F9", name: "SYSTEM" }, { key: "HELP", f: "F10", name: "HILFE" },
  ];
  const ALIASES = { MONITOR: "MON", OVERVIEW: "MON", LEARN: "LRN", LERNEN: "LRN", RISIKO: "RISK", RESEARCH: "RES",
    FORSCHUNG: "RES", BLOTTER: "BLTR", TRADES: "BLTR", LOG: "JRNL", JOURNAL: "JRNL", SYSTEM: "SYS", "?": "HELP", H: "HELP",
    SIGNALE: "SIG", SIGNAL: "SIG", HILFE: "HELP", CHART: "ASSET", DES: "ASSET" };

  const A = { S: null, page: "MON", coin: null, cache: {}, fetchedAt: {}, built: null, ws: null, history: [],
    hIdx: -1, jFilter: "ALL", jSearch: "", tradeSel: null, tapeAt: 0 };

  /* ── formatting ─────────────────────────────────────────────────────── */
  const isNum = (v) => typeof v === "number" && isFinite(v);
  const f = (v, d = 2) => (isNum(v) ? v.toFixed(d) : "-");
  const sgn = (v, d = 2) => (isNum(v) ? (v >= 0 ? "+" : "") + v.toFixed(d) : "-");
  const pct = (v, d = 2) => (isNum(v) ? (v * 100).toFixed(d) + "%" : "-");
  const spct = (v, d = 2) => (isNum(v) ? (v >= 0 ? "+" : "") + (v * 100).toFixed(d) + "%" : "-");
  const usd = (v, d = 2) => (isNum(v) ? (v < 0 ? "-" : "") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "-");
  const kusd = (v) => (isNum(v) ? (Math.abs(v) >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "M" : Math.abs(v) >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "K" : "$" + v.toFixed(0)) : "-");
  const px = (v) => {
    if (!isNum(v)) return "-";
    const a = Math.abs(v);
    if (a >= 1000) return v.toFixed(2);
    if (a >= 10) return v.toFixed(3);
    if (a >= 1) return v.toFixed(4);
    if (a >= 0.01) return v.toFixed(5);
    return v.toPrecision(4);
  };
  const cls = (v) => (isNum(v) ? (v > 0 ? "up" : v < 0 ? "down" : "") : "");
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ts = (ms, date = false) => {
    if (!ms) return "-";
    const d = new Date(ms).toISOString();
    return date ? d.slice(5, 16).replace("T", " ") : d.slice(11, 19);
  };
  const dur = (min) => (!isNum(min) ? "-" : min < 60 ? Math.round(min) + "m" : min < 1440 ? (min / 60).toFixed(1) + "h" : (min / 1440).toFixed(1) + "d");
  const sbar = (s, w = 90) => {
    if (!isNum(s)) return `<span class="sbar" style="width:${w}px"></span>`;
    const half = w / 2, len = Math.min(1, Math.abs(s)) * half;
    const col = s >= 0 ? "var(--up)" : "var(--down)";
    const left = s >= 0 ? half : half - len;
    return `<span class="sbar" style="width:${w}px"><i style="left:${left}px;width:${len}px;background:${col}"></i></span>`;
  };
  const heat = (v, scale = 1) => {
    if (!isNum(v) || v === 0) return "background:#0b1120;color:#566079";
    const a = Math.min(1, Math.abs(v) / scale) * 0.85 + 0.08;
    return v > 0 ? `background:rgba(35,209,139,${a});color:${a > 0.5 ? "#000" : "#e6e9ef"}`
      : `background:rgba(255,79,94,${a});color:${a > 0.5 ? "#000" : "#e6e9ef"}`;
  };
  const sideTag = (s) => (s > 0 ? '<span class="tag long">LONG</span>' : '<span class="tag short">SHORT</span>');
  const panel = (id, title, code, cls_, opts = {}) =>
    `<section class="panel ${cls_}" id="p-${id}"><div class="ph">${code ? `<span class="code">${code}</span>` : ""}${title}<span class="right" id="pr-${id}">${opts.right || ""}</span></div>` +
    `<div class="pb ${opts.flush ? "flush" : ""}" id="pb-${id}">${opts.body || ""}</div></section>`;
  const canvasPanel = (id, title, code, cls_, right = "") =>
    panel(id, title, code, cls_, { flush: true, right, body: `<div class="cwrap"><canvas class="chart" id="cv-${id}"></canvas></div>` });
  const set = (id, html) => { const el = document.getElementById("pb-" + id); if (el) el.innerHTML = html; };
  const setR = (id, html) => { const el = document.getElementById("pr-" + id); if (el) el.innerHTML = html; };
  const cv = (id) => document.getElementById("cv-" + id);
  const metric = (k, v, c = "", s = "") => `<div class="metric"><div class="k">${k}</div><div class="v ${c}">${v}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;
  const stratName = (k) => {
    const cat = (A.cache.brain && A.cache.brain.catalog) || [];
    const e = cat.find((x) => x.key === k);
    return e ? e.name : k === "final" ? "FINAL" : k === "ensemble" ? "Ensemble" : k;
  };

  /* ── data access ────────────────────────────────────────────────────── */
  async function getJSON(url, opts) {
    const r = await fetch(url, opts);
    return r.json();
  }
  async function fetchCached(key, url, maxAgeMs) {
    const now = Date.now();
    if (A.cache[key] && now - (A.fetchedAt[key] || 0) < maxAgeMs) return A.cache[key];
    if (A["_inflight_" + key]) return A.cache[key];
    A["_inflight_" + key] = true;
    try {
      A.cache[key] = await getJSON(url);
      A.fetchedAt[key] = Date.now();
    } catch (e) { /* keep stale */ }
    A["_inflight_" + key] = false;
    return A.cache[key];
  }
  async function control(action, coin) {
    const r = await getJSON("/api/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, coin }) });
    status(`Aktion ${action}${coin ? " " + coin : ""}: ${r.msg}`);
  }
  function status(msg) { $("#statusline").textContent = msg; }

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let ws;
    try { ws = new WebSocket(`${proto}://${location.host}/ws`); } catch (e) { poll(); return; }
    A.ws = ws;
    ws.onmessage = (ev) => { A.S = JSON.parse(ev.data); A.lastMsg = Date.now(); onState(); };
    ws.onopen = () => $("#conn").classList.add("ok");
    ws.onclose = () => { $("#conn").classList.remove("ok"); setTimeout(connect, 2000); };
    ws.onerror = () => ws.close();
  }
  async function poll() {
    try { A.S = await getJSON("/api/state"); onState(); } catch (e) { /* retry */ }
    setTimeout(poll, 2000);
  }

  /* ── chrome: top bar, f-keys, tape ──────────────────────────────────── */
  function buildFkeys() {
    $("#fkeys").innerHTML = PAGES.map((p) => `<div class="fk ${p.key === A.page ? "on" : ""}" data-p="${p.key}"><span class="n">${p.f}</span>${p.name}</div>`).join("") +
      [...new Set([...((A.S && A.S.positions) || []).map((p) => p.coin), ...((A.S && A.S.orders) || []).map((o) => o.coin)])]
        .map((c) => `<div class="fk asset" data-c="${esc(c)}" title="offene Position/Order">${esc(c.replace(/^[a-z]+:/, ""))}</div>`).join("");
    document.querySelectorAll(".fk[data-p]").forEach((el) => (el.onclick = () => go(el.dataset.p)));
    document.querySelectorAll(".fk[data-c]").forEach((el) => (el.onclick = () => { A.coin = el.dataset.c; go("ASSET"); }));
  }
  function updateTop() {
    const S = A.S;
    const now = new Date();
    $("#clk-utc").textContent = now.toISOString().slice(11, 19);
    $("#clk-et").textContent = now.toLocaleTimeString("de-DE", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" });
    if (!S) return;
    const info = S.info || {};
    const mode = $("#mode");
    mode.textContent = info.kind === "sim" ? "SIMULATION" : info.status && info.status.phase === "error" ? "FEHLER" : "LIVE · PAPER";
    mode.className = "badge" + (info.kind === "sim" ? " sim" : info.status && info.status.phase === "error" ? " err" : "");
    if (!S.ready) return;
    const ac = S.account;
    const pnl = ac.equity - ac.start;
    if (ac.mode === "fixed") {
      $("#lbl-eq").textContent = "PNL GESAMT";
      $("#top-eq").innerHTML = `<span class="${cls(pnl)}">${sgn(pnl)} $</span>`;
      $("#lbl-pnl").textContent = "REAL. / OFFEN";
      $("#top-pnl").innerHTML = `<span class="${cls(ac.realized)}">${sgn(ac.realized)}</span> / <span class="${cls(ac.upnl)}">${sgn(ac.upnl)}</span>`;
      $("#lbl-epoch").textContent = "MODUS";
      const mp = (A.cache.cfg && A.cache.cfg.config.account.position_margin_usd) || 100;
      const mx = (A.cache.cfg && A.cache.cfg.config.risk.max_open_positions) || 5;
      $("#top-epoch").textContent = `${mx}×${mp}$`;
    } else {
      $("#lbl-eq").textContent = "EQUITY";
      $("#top-eq").textContent = usd(ac.equity);
      $("#lbl-pnl").textContent = "PNL";
      $("#top-pnl").innerHTML = `<span class="${cls(pnl)}">${sgn(pnl)} (${spct(ac.return)})</span>`;
      $("#lbl-epoch").textContent = "EPOCHE";
      $("#top-epoch").textContent = `#${ac.epoch}`;
    }
    $("#top-pos").textContent = `${S.positions.length} / ${(S.orders || []).length} Ord`;
    const b = S.brain || {};
    $("#top-learn").innerHTML = `n=${(b.n_resolved || 0).toLocaleString()} · IC <span class="${cls(b.ic_final)}">${f(b.ic_final, 3)}</span>`;
    const st = info.status || {};
    const ws = info.ws ? ` · WS ${info.ws.connected ? "verbunden" : "getrennt"} (${info.ws.messages} Msg)` : "";
    const mk = info.markets ? ` · Märkte ${info.ready}/${info.markets}` : "";
    const subs = info.ws && info.ws.subscriptions ? ` · ${info.ws.subscriptions} Abos` : "";
    status(`${st.msg || ""}${ws}${subs}${mk} · Bars ${S.counters.bars} · Signale ${S.counters.signals} · Einstiege ${S.counters.entries} · Abgelehnt ${S.counters.rejected} · Stand ${ts(S.t)} UTC`);
    if (Date.now() - A.tapeAt > 15000) {
      A.tapeAt = Date.now();
      const held = new Set(S.positions.map((p) => p.coin));
      const tape = S.assets.filter((a) => held.has(a.coin)).concat(
        S.assets.filter((a) => !held.has(a.coin)).sort((x, y) => (y.vol || 0) - (x.vol || 0)).slice(0, 40));
      const items = tape.map((a) => `<span><b class="${held.has(a.coin) ? "yellow" : "amber"}">${esc(a.symbol)}</b> ${px(a.px)} <span class="${cls(a.chg)}">${spct(a.chg)}</span> <span class="dim">S ${sgn(a.final)}</span></span>`);
      const last = (S.journal || []).filter((j) => ["ENTRY", "EXIT", "LIQ", "RUIN"].includes(j.kind)).slice(-3)
        .map((j) => `<span class="yellow">■ ${esc(j.coin)} ${esc(j.text.slice(0, 120))}</span>`);
      $("#tape-inner").innerHTML = items.concat(last).join("");
    }
  }

  /* ── navigation & commands ──────────────────────────────────────────── */
  function go(page) {
    A.page = page;
    A.built = null;
    buildFkeys();
    render();
    $("#page").scrollTop = 0;
  }
  function findCoin(tok) {
    if (!A.S || !A.S.assets) return null;
    const t = tok.toUpperCase();
    const a = A.S.assets.find((x) => x.coin.toUpperCase() === t || x.symbol.toUpperCase() === t);
    return a ? a.coin : null;
  }
  function runCommand(raw) {
    const cmd = raw.trim().toUpperCase().replace(/<GO>/g, "").replace(/\s+GO$/, "").trim();
    if (!cmd) return;
    A.history.unshift(cmd); A.hIdx = -1;
    const [head, ...rest] = cmd.split(/\s+/);
    const page = ALIASES[head] || (PAGES.find((p) => p.key === head) || {}).key;
    if (head === "PAUSE") return control("pause");
    if (head === "RESUME" || head === "START") return control("resume");
    if (head === "FLAT" || head === "CLOSE") {
      const c = rest.length ? findCoin(rest[0]) : null;
      if (confirm(c ? `Position ${c} schließen?` : "ALLE Positionen schließen?")) control("flatten", c);
      return;
    }
    if (head === "RESET") { if (confirm("Konto auf Startkapital zurücksetzen (neue Epoche)? Lernstand bleibt.")) control("reset"); return; }
    if (head === "RUN" && rest[0] && rest[0].startsWith("RES")) { go("RES"); startResearch(); return; }
    if (page) {
      if (page === "ASSET" && rest[0]) { const c = findCoin(rest[0]); if (c) A.coin = c; }
      return go(page);
    }
    const coin = findCoin(head);
    if (coin) {
      A.coin = coin;
      const sub = rest[0];
      if (sub === "SIG") return go("SIG");
      return go("ASSET");
    }
    status(`Unbekanntes Kommando: ${cmd} – HELP <GO> für Hilfe`);
  }

  /* ── page dispatch ──────────────────────────────────────────────────── */
  function onState() {
    updateTop();
    const fkKey = A.S && A.S.positions ? A.S.positions.map((p) => p.coin).concat((A.S.orders || []).map((o) => o.coin)).join(",") : "";
    if (A.fkKey !== fkKey) { A.fkKey = fkKey; buildFkeys(); }
    render();
  }
  function render() {
    const S = A.S;
    const page = $("#page");
    if (!S) return;
    if (!S.ready) {
      const st = (S.info && S.info.status) || {};
      if (A.built !== "SPLASH") { page.innerHTML = '<div class="splash" id="splash"></div>'; A.built = "SPLASH"; }
      $("#splash").innerHTML = `<div class="big">MULTBOT</div><p class="dim">${esc(st.phase || "")}</p><p>${esc(st.msg || "")}</p>` +
        `<div class="progress" style="max-width:420px;margin:10px auto"><i style="width:${(st.progress || 0) * 100}%"></i></div>` +
        `<p class="note">Beim ersten Start wird die Historie geladen und der komplette Lern-Stack per Walk-Forward-Backtest vortrainiert.</p>`;
      return;
    }
    if (!A.coin && S.assets.length) A.coin = S.assets[0].coin;
    const P = RENDER[A.page] || RENDER.MON;
    if (A.built !== A.page) { page.innerHTML = P.build(); A.built = A.page; if (P.init) P.init(); }
    try { P.update(S); } catch (e) { console.error(e); status("Renderfehler: " + e.message); }
  }

  /* ════════════════════════════ PAGES ════════════════════════════════ */
  const RENDER = {};

  /* ── F1 MONITOR ─────────────────────────────────────────────────────── */
  RENDER.MON = {
    build: () => panel("watch", "Marktübersicht", "WATCH", "c8 h420", { flush: true, right: watchControls() }) +
      panel("acct", "Konto · PnL", "ACCT", "c4 h420") +
      canvasPanel("eq", "PnL-/Equity-Kurve", "EQ", "c8 h240") +
      panel("pos", "Positionen & Orders", "POS", "c4 h240", { flush: true }) +
      panel("hm", "Signal-Heatmap · stärkste Signale (Strategie × Markt)", "HEAT", "c6 h280", { flush: true }) +
      panel("jr", "Entscheidungs-Journal", "JRNL", "c6 h280"),
    init() { bindWatchControls(); },
    async update(S) {
      set("watch", watchTable(S));
      document.querySelectorAll("#pb-watch tr[data-c]").forEach((tr) => (tr.onclick = () => { A.coin = tr.dataset.c; go("ASSET"); }));
      document.querySelectorAll("#pb-watch th[data-sort]").forEach((th) => (th.onclick = () => {
        const k = th.dataset.sort;
        A.wsort = { key: k, dir: A.wsort.key === k ? -A.wsort.dir : -1 };
        set("watch", watchTable(A.S)); RENDER.MON.update(A.S);
      }));
      set("acct", acctMetrics(S));
      equityChart(cv("eq"), S.equity, S.account.start, S.account.mode === "fixed");
      setR("eq", S.account.mode === "fixed"
        ? `PnL ${sgn(S.account.pnl)} $ · Peak ${sgn(S.account.peak - S.account.start)} $ · Max-Drawdown ${usd(S.account.max_dd_usd)}`
        : `Start ${usd(S.account.start)} · Peak ${usd(S.account.peak)} · MaxDD ${pct(S.account.max_dd, 1)}`);
      set("pos", positionsTable(S, true));
      const sig = await fetchCached("sigtop", "/api/signals?limit=14", 4000);
      if (sig) { set("hm", heatmap(sig, S, true)); bindRowClicks("#pb-hm"); }
      set("jr", journalHtml((S.journal || []).slice(-60).reverse()));
    },
  };

  const CLS_NAMES = { ALL: "Alle", crypto: "Krypto", equity: "Aktien", etf: "ETF", index: "Indizes", commodity: "Rohstoffe", fx: "FX" };
  function watchControls() {
    return `<input class="inp" id="w-q" placeholder="Suche…" style="width:110px">` +
      `<select id="w-cls">${Object.entries(CLS_NAMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>` +
      `<select id="w-only"><option value="all">alle</option><option value="sig">nur Signale</option><option value="pos">Positionen</option><option value="open">handelbar</option></select>` +
      `<select id="w-lim"><option value="60">60</option><option value="120">120</option><option value="9999">alle</option></select>`;
  }
  function bindWatchControls() {
    const on = (id, fn) => { const el = document.getElementById(id); if (el) { el.oninput = el.onchange = fn; } };
    const q = $("#w-q"); if (q) q.value = A.wq || "";
    if ($("#w-cls")) $("#w-cls").value = A.wcls || "ALL";
    if ($("#w-only")) $("#w-only").value = A.wonly || "all";
    if ($("#w-lim")) $("#w-lim").value = String(A.wlim || 60);
    on("w-q", (e) => { A.wq = e.target.value.toUpperCase(); RENDER.MON.update(A.S); });
    on("w-cls", (e) => { A.wcls = e.target.value; RENDER.MON.update(A.S); });
    on("w-only", (e) => { A.wonly = e.target.value; RENDER.MON.update(A.S); });
    on("w-lim", (e) => { A.wlim = +e.target.value; RENDER.MON.update(A.S); });
  }
  A.wsort = { key: "score", dir: -1 };
  const SORTERS = {
    sym: (a) => a.symbol, lev: (a) => a.lev, px: (a) => a.px, chg: (a) => a.chg ?? -9, fund: (a) => a.fund ?? 0,
    vol: (a) => a.vol ?? 0, oi: (a) => a.oi ?? 0, spr: (a) => a.spread ?? 0, score: (a) => Math.abs(a.final || 0),
    pup: (a) => a.p_up ?? 0, pwin: (a) => a.pwin ?? -1, st: (a) => a.status, cls: (a) => a.cls,
  };
  function watchTable(S) {
    const held = new Set(S.positions.map((p) => p.coin).concat((S.orders || []).map((o) => o.coin)));
    const th = 0.5 * ((((A.cache.cfg || {}).config || {}).signal || {}).entry_threshold || 0.28);
    let list = S.assets.filter((a) => (!A.wq || a.coin.toUpperCase().includes(A.wq)) && (!A.wcls || A.wcls === "ALL" || a.cls === A.wcls));
    if (A.wonly === "sig") list = list.filter((a) => Math.abs(a.final || 0) >= th);
    if (A.wonly === "pos") list = list.filter((a) => held.has(a.coin));
    if (A.wonly === "open") list = list.filter((a) => a.tradable !== false && a.ready);
    const key = SORTERS[A.wsort.key] || SORTERS.score;
    list.sort((x, y) => { const a = key(x), b = key(y); return (a < b ? -1 : a > b ? 1 : 0) * A.wsort.dir; });
    list.sort((x, y) => (held.has(y.coin) ? 1 : 0) - (held.has(x.coin) ? 1 : 0));
    const total = list.length;
    list = list.slice(0, A.wlim || 60);
    const rows = list.map((a) => {
      const f8 = isNum(a.fund) ? a.fund * 8 : null;
      const st = a.status || "";
      const stc = st.startsWith("LONG") ? "up" : st.startsWith("SHORT") ? "down" : st.startsWith("GESPERRT") ? "mute" : st.startsWith("ORDER") || st.startsWith("WARTE") ? "cyan" : "dim";
      return `<tr class="click" data-c="${esc(a.coin)}"><td class="l"><b class="${held.has(a.coin) ? "yellow" : "amber"}">${esc(a.symbol)}</b></td><td class="l dim">${esc(CLS_NAMES[a.cls] || a.cls)}</td>` +
        `<td class="yellow">${a.lev}x</td><td>${px(a.px)}</td><td class="${cls(a.chg)}">${spct(a.chg)}</td>` +
        `<td class="${cls(-f8)}">${isNum(f8) ? (f8 * 100).toFixed(4) + "%" : "-"}</td><td class="${cls(-(a.fund || 0))}">${isNum(a.fund) ? pct(a.fund * 24 * 365, 1) : "-"}</td>` +
        `<td>${kusd(a.vol)}</td><td>${kusd(a.oi)}</td><td>${f(a.spread, 1)}</td>` +
        `<td class="l">${esc(a.regime || "-")}${a.tradable === false ? ' <span class="tag warn">ZU</span>' : ""}</td>` +
        `<td>${sbar(a.final)} <span class="${cls(a.final)}">${sgn(a.final)}</span></td><td>${pct(a.p_up, 0)}</td><td>${a.pwin === null || a.pwin === undefined ? "-" : pct(a.pwin, 0)}</td>` +
        `<td class="l ${stc}" title="${esc(st)}">${esc(st.slice(0, 34))}</td></tr>`;
    });
    const h = (k, label, l) => `<th class="${l ? "l" : ""}" data-sort="${k}" style="cursor:pointer">${label}${A.wsort.key === k ? (A.wsort.dir < 0 ? " ▼" : " ▲") : ""}</th>`;
    return `<table class="t"><thead><tr>${h("sym", "Markt", 1)}${h("cls", "Klasse", 1)}${h("lev", "Hebel")}${h("px", "Mark")}${h("chg", "24h")}${h("fund", "Fund 8h")}<th>Fund p.a.</th>` +
      `${h("vol", "Vol 24h")}${h("oi", "OI")}${h("spr", "Spr bps")}<th class="l">Regime</th>${h("score", "Ensemble-Score")}${h("pup", "P(↑)")}${h("pwin", "P(Gew)")}${h("st", "Status", 1)}</tr></thead>` +
      `<tbody>${rows.join("")}</tbody></table>` + (total > list.length ? `<p class="note" style="padding:4px 8px">${list.length} von ${total} Märkten – Filter oder „alle“ wählen.</p>` : "");
  }

  function acctMetrics(S) {
    const a = S.account;
    const pnl = a.equity - a.start;
    if (a.mode === "fixed") {
      const cf = (A.cache.cfg && A.cache.cfg.config) || { account: { position_margin_usd: 100 }, risk: { max_open_positions: 5 } };
      const mp = cf.account.position_margin_usd, mx = cf.risk.max_open_positions;
      return `<div class="metrics">` +
        metric("PnL gesamt", sgn(pnl) + " $", cls(pnl), "realisiert + offen") +
        metric("Realisiert", sgn(a.realized) + " $", cls(a.realized), `${a.trades} Trades`) +
        metric("Offen (uPnL)", sgn(a.upnl) + " $", cls(a.upnl), `${a.positions}/${mx} Positionen`) +
        metric("Ø pro Trade", sgn(a.avg_net) + " $", cls(a.avg_net), "netto nach Kosten") +
        metric("Ø ROE/Trade", a.avg_net === null || a.avg_net === undefined ? "-" : spct(a.avg_net / mp, 1), cls(a.avg_net), `auf ${mp} $ Margin`) +
        metric("Trefferquote", pct(a.win_rate, 1), (a.win_rate || 0) >= 0.5 ? "up" : "") +
        metric("Profit-Faktor", f(a.profit_factor, 2), (a.profit_factor || 0) > 1 ? "up" : "down") +
        metric("Max-Drawdown", usd(a.max_dd_usd), a.max_dd_usd > 0 ? "down" : "", "vom PnL-Hoch") +
        metric("Margin gebunden", usd(a.used_margin, 0), "", `Exposure ${usd(a.exposure, 0)}`) +
        metric("Gebühren", usd(a.fees, 2), "down") +
        metric("Funding", usd(-a.funding, 2), cls(-a.funding), a.funding > 0 ? "bezahlt" : "erhalten") +
        metric("Liquidationen", a.liquidations, a.liquidations ? "down" : "") +
        `</div><p class="note" style="margin-top:6px">Kapital <b>unbegrenzt</b> · jede Position <b>${mp} USD Margin × maximaler Hebel</b> · max. <b>${mx}</b> gleichzeitig. Prozentwerte beziehen sich auf ${mx} × ${mp} = ${usd(mp * mx, 0)} Referenzkapital.</p>` +
        (S.paused ? '<p><span class="tag warn">PAUSIERT</span> RESUME &lt;GO&gt; zum Fortsetzen</p>' : "");
    }
    return `<div class="metrics">` +
      metric("Equity", usd(a.equity), "amber", `Epoche #${a.epoch}`) +
      metric("PnL", sgn(pnl) + " $", cls(pnl), spct(a.return)) +
      metric("Frei", usd(a.balance)) +
      metric("uPnL", usd(a.upnl), cls(a.upnl)) +
      metric("Margin", usd(a.used_margin), "", pct(a.equity ? a.used_margin / a.equity : 0, 0) + " gebunden") +
      metric("Exposure", usd(a.exposure, 0), "", f(a.equity ? a.exposure / a.equity : 0, 2) + "x effektiv") +
      metric("Drawdown", pct(a.drawdown, 1), a.drawdown > 0.1 ? "down" : "", "max " + pct(a.max_dd, 1)) +
      metric("Trades", a.trades, "", "Treffer " + pct(a.win_rate, 0)) +
      metric("Realisiert", sgn(a.realized) + " $", cls(a.realized)) +
      metric("Gebühren", usd(a.fees, 3), "down") +
      metric("Funding", usd(-a.funding, 3), cls(-a.funding), a.funding > 0 ? "bezahlt" : "erhalten") +
      metric("Liquidationen", a.liquidations, a.liquidations ? "down" : "") +
      `</div>` + (a.epochs && a.epochs.length ? `<div class="note" style="margin-top:6px">Frühere Epochen: ${a.epochs.map((e) => `#${e.epoch} → ${usd(e.final_equity)}`).join(" · ")}</div>` : "") +
      (S.paused ? '<p><span class="tag warn">PAUSIERT</span> RESUME &lt;GO&gt; zum Fortsetzen</p>' : "");
  }

  function equityChart(canvas, eq, start, asPnl) {
    if (!canvas) return;
    if (asPnl) {
      const data = (eq || []).map((e) => [e[0], e[1] - start]);
      CH.line(canvas, { series: [{ data, color: CH.C.amber, fill: true, label: "PnL", fillBase: 0 }], zero: true,
        hlines: [{ y: 0, color: CH.C.cyan, label: "0 $", include: true }], yFmt: (v) => (v >= 0 ? "+" : "") + v.toFixed(2), empty: "PnL-Kurve startet mit dem ersten Takt" });
      return;
    }
    const data = (eq || []).map((e) => [e[0], e[1]]);
    const vlines = [];
    for (let i = 1; i < (eq || []).length; i++) if (eq[i][2] !== eq[i - 1][2]) vlines.push({ x: eq[i][0], label: "Epoche " + eq[i][2], color: CH.C.down });
    CH.line(canvas, { series: [{ data, color: CH.C.amber, fill: true, label: "Equity", fillBase: start }],
      hlines: [{ y: start, color: CH.C.cyan, label: "Start", include: true }], vlines, yFmt: (v) => v.toFixed(2), empty: "Equity-Kurve startet mit dem ersten Takt" });
  }

  function positionsTable(S, compact) {
    const P = S.positions || [];
    const O = S.orders || [];
    if (!P.length && !O.length) return '<p class="dim" style="padding:8px">Keine offenen Positionen. Der Bot wartet auf ein Signal mit ausreichender Kante.</p>';
    const rows = P.map((p) => {
      const liq = Math.max(0, p.liq_dist);
      const stopD = Math.abs(p.mark - p.stop_px) / p.mark;
      return `<tr class="click" data-c="${esc(p.coin)}"><td class="l amber">${esc(p.coin.replace("xyz:", ""))}</td><td class="l">${sideTag(p.side)} ${p.leverage}x</td>` +
        `<td>${px(p.entry_px)}</td><td>${px(p.mark)}</td><td class="${cls(p.upnl)}">${sgn(p.upnl)}</td><td class="${cls(p.roe)}">${spct(p.roe, 1)}</td>` +
        (compact ? "" : `<td>${usd(p.notional)}</td><td>${usd(p.margin)}</td><td>${px(p.stop_px)}${p.trail_active ? ' <span class="tag info">T</span>' : ""}</td><td>${px(p.tp_px)}</td>`) +
        `<td class="down">${px(p.liq_px)}</td><td class="${liq < 0.02 ? "down b" : ""}">${pct(liq, 2)}</td>` +
        (compact ? "" : `<td>${pct(stopD, 2)}</td><td class="${cls(p.r)}">${sgn(p.r)}R</td><td>${pct(p.mae, 2)} / ${pct(p.mfe, 2)}</td><td class="${cls(-p.funding)}">${f(-p.funding, 4)}</td><td>${dur(p.age_min)}</td>`) + `</tr>`;
    });
    const orows = O.map((o) => `<tr><td class="l cyan">${esc(o.coin.replace("xyz:", ""))}</td><td class="l"><span class="tag info">LIMIT ${o.side > 0 ? "BUY" : "SELL"}</span> ${o.leverage}x</td>` +
      `<td>${px(o.limit)}</td><td colspan="${compact ? 5 : 13}" class="l dim">Größe ${o.size} · Margin ${usd(o.margin)} · ${o.bars} Bar(s) alt · ${esc(o.regime)}</td></tr>`);
    return `<table class="t"><thead><tr><th class="l">Markt</th><th class="l">Seite</th><th>Einstieg</th><th>Mark</th><th>uPnL</th><th>ROE</th>` +
      (compact ? "" : "<th>Notional</th><th>Margin</th><th>Stop</th><th>TP</th>") + `<th>Liq-Preis</th><th>Abst. Liq</th>` +
      (compact ? "" : "<th>Abst. Stop</th><th>R</th><th>MAE / MFE</th><th>Funding</th><th>Alter</th>") + `</tr></thead><tbody>${rows.join("")}${orows.join("")}</tbody></table>`;
  }

  function heatmap(sig, S, compact) {
    const keys = (sig && sig.keys) || [];
    if (!keys.length || !sig.rows.length) return '<p class="dim" style="padding:8px">Warmup – noch keine Signale.</p>';
    const w = (S.brain && S.brain.weights) || {};
    const muted = new Set((S.brain && S.brain.muted) || []);
    const head = keys.map((k) => `<th class="rot" title="${esc(stratName(k))} · Gewicht ${pct(w[k], 1)}"><div class="${muted.has(k) ? "mute" : ""}">${esc(compact ? k : stratName(k))}</div></th>`).join("");
    const rows = sig.rows.map((r) => {
      const cells = keys.map((k, i) => {
        const s = r.s[i];
        const why = r.why ? r.why[i] : "";
        return `<td style="${heat(s)}" title="${esc(stratName(k))}: ${sgn(s)}\n${esc(why)}\nGewicht ${pct(w[k], 1)}${muted.has(k) ? " (stumm)" : ""}">${isNum(s) && s !== 0 ? Math.round(s * 100) : "·"}</td>`;
      }).join("");
      return `<tr class="click" data-c="${esc(r.coin)}"><td class="l amber">${esc(r.symbol)}</td>${cells}<td style="${heat(r.final)}"><b>${Math.round((r.final || 0) * 100)}</b></td>` +
        (compact ? "" : `<td>${pct(r.agreement, 0)}</td><td>${pct(r.coverage, 0)}</td><td>${pct(r.p_up, 1)}</td><td>${r.pwin === null || r.pwin === undefined ? "-" : pct(r.pwin, 1)}</td>`) + `</tr>`;
    }).join("");
    return `<table class="hm"><thead><tr><th class="l">Markt</th>${head}<th class="rot"><div>FINAL</div></th>` +
      (compact ? "" : '<th class="rot"><div>Einigkeit</div></th><th class="rot"><div>Abdeckung</div></th><th class="rot"><div>P(↑) ML</div></th><th class="rot"><div>P(Gewinn)</div></th>') +
      `</tr></thead><tbody>${rows}</tbody></table>`;
  }
  function bindRowClicks(sel) {
    document.querySelectorAll(sel + " tr[data-c]").forEach((tr) => (tr.onclick = () => { A.coin = tr.dataset.c; go("ASSET"); }));
  }

  function journalHtml(items) {
    if (!items.length) return '<p class="dim">Noch keine Einträge.</p>';
    return items.map((j) => `<div class="jr"><span class="ts">${ts(j.ts)}</span><span class="co">${esc((j.coin || "").replace("xyz:", ""))}</span>` +
      `<span class="kd ${esc(j.kind)}">${esc(j.kind)}</span><span>${esc(j.text)}</span></div>`).join("");
  }

  /* ── F2 ASSET ───────────────────────────────────────────────────────── */
  RENDER.ASSET = {
    build: () => canvasPanel("chart", "Chart", "GP", "c9 h480") +
      panel("book", "Orderbuch", "BOOK", "c3 h480", { flush: true }) +
      canvasPanel("score", "Ensemble-Score & RSI", "SCORE", "c9 h160") +
      panel("apos", "Position", "POS", "c3 h160") +
      panel("votes", "Strategie-Stimmen · Gewichte für dieses Regime", "VOTE", "c6 h360", { flush: true }) +
      panel("feat", "Features", "FEAT", "c3 h360", { flush: true }) +
      panel("spec", "Markt & Mechanik", "DES", "c3 h360") +
      panel("atr", "Trades in diesem Markt", "TRD", "c6 h240", { flush: true }) +
      panel("ajr", "Journal (Markt)", "JRNL", "c6 h240"),
    init() {
      const S = A.S;
      setR("chart", `<button class="btn" id="a-prev" title="vorheriger Markt">◀</button>` +
        `<input class="inp" id="a-pick" list="a-list" placeholder="Markt suchen…" style="width:150px">` +
        `<datalist id="a-list">${S.assets.map((a) => `<option value="${esc(a.coin)}">${esc(a.symbol)} · ${esc(CLS_NAMES[a.cls] || a.cls)}</option>`).join("")}</datalist>` +
        `<button class="btn" id="a-next" title="nächster Markt">▶</button>`);
      const pick = (c) => { if (c) { A.coin = c; A.fetchedAt.asset = 0; render(); } };
      $("#a-pick").onchange = (e) => pick(findCoin(e.target.value));
      const step = (d) => {
        const order = A.S.assets.slice().sort((x, y) => (y.vol || 0) - (x.vol || 0)).map((a) => a.coin);
        const i = order.indexOf(A.coin);
        pick(order[(i + d + order.length) % order.length]);
      };
      $("#a-prev").onclick = () => step(-1);
      $("#a-next").onclick = () => step(1);
    },
    async update(S) {
      const coin = A.coin;
      const pk = $("#a-pick");
      if (pk && document.activeElement !== pk) pk.value = coin;
      const key = "asset";
      if (A.cache.assetCoin !== coin) { A.fetchedAt[key] = 0; A.cache.assetCoin = coin; }
      const d = await fetchCached(key, "/api/asset/" + encodeURIComponent(coin), 2000);
      if (!d || d.coin !== coin) return;
      assetChart(d);
      assetScore(d);
      set("book", bookHtml(d));
      set("apos", assetPos(d));
      set("votes", votesHtml(d));
      set("feat", featHtml(d));
      set("spec", specHtml(d));
      set("atr", tradesTable(d.trades.slice().reverse(), false));
      set("ajr", journalHtml(d.journal.slice().reverse()));
    },
  };

  function assetChart(d) {
    const v = d.view || {};
    const markers = [];
    for (const t of d.trades || []) {
      markers.push({ x: t.entry_ms, y: t.entry_px, shape: t.side > 0 ? "up" : "down", color: t.side > 0 ? CH.C.up : CH.C.down });
      markers.push({ x: t.exit_ms, y: t.exit_px, shape: "x", color: t.net >= 0 ? CH.C.yellow : CH.C.violet });
    }
    const hl = [];
    const p = d.position;
    if (p) {
      markers.push({ x: p.opened_ms, y: p.entry_px, shape: p.side > 0 ? "up" : "down", color: CH.C.white });
      hl.push({ y: p.entry_px, color: CH.C.white, label: "ENTRY" }, { y: p.stop_px, color: CH.C.down, label: p.trail_active ? "TRAIL" : "STOP", include: true },
        { y: p.tp_px, color: CH.C.up, label: "TP", include: true }, { y: p.liq_px, color: "#ff2050", label: "LIQ", dash: [2, 2] });
    }
    if (d.order) hl.push({ y: d.order.limit, color: CH.C.cyan, label: "LIMIT", include: true });
    const t = d.t.slice(), o = d.o.slice(), h = d.h.slice(), l = d.l.slice(), c = d.c.slice(), vv = d.v.slice();
    if (d.forming && (!t.length || d.forming.t > t[t.length - 1])) { t.push(d.forming.t); o.push(d.forming.o); h.push(d.forming.h); l.push(d.forming.l); c.push(d.forming.c); vv.push(d.forming.v); }
    const pad = (arr) => arr.concat(new Array(Math.max(0, t.length - arr.length)).fill(null));
    CH.candles(cv("chart"), {
      t, o, h, l, c, v: vv, volume: true, markers, hlines: hl, yFmt: px,
      overlays: [{ data: pad(d.ema21), color: CH.C.amber, label: "EMA21" }, { data: pad(d.ema55), color: CH.C.violet, label: "EMA55" },
        { data: pad(d.bb_up), color: "#2f81f7", dash: [3, 3], label: "BB+" }, { data: pad(d.bb_lo), color: "#2f81f7", dash: [3, 3], label: "BB−" },
        { data: pad(d.kalman), color: CH.C.cyan, label: "Kalman" }, { data: pad(d.vwap), color: "#ff7ac6", dash: [1, 2], label: "VWAP48" }],
    });
    const sp = d.spec || {};
    $("#p-chart .ph").firstChild.nextSibling.textContent = ` ${d.coin} · ${sp.leverage}x · ${v.regime ? v.regime.label : ""} · ${A.S.info.interval} `;
  }

  function assetScore(d) {
    const hist = (d.view.history || []).map((x) => [x[0], x[1]]);
    const rsi = d.t.map((t, i) => [t, isNum(d.rsi[i]) ? (d.rsi[i] - 50) / 50 : null]);
    const th = (A.cache.cfg && A.cache.cfg.config.signal.entry_threshold) || 0.28;
    CH.line(cv("score"), { series: [{ data: hist, color: CH.C.amber, width: 1.6, label: "Score" }, { data: rsi.slice(-Math.max(hist.length, 60)), color: "#566079", label: "RSI (norm.)" }],
      fixedY: [-1, 1], zero: true, hlines: [{ y: th, color: CH.C.up, dash: [2, 3] }, { y: -th, color: CH.C.down, dash: [2, 3] }], yFmt: (v) => v.toFixed(2) });
  }

  function bookHtml(d) {
    const b = d.book || { bids: [], asks: [] };
    if (!b.bids.length && !b.asks.length) return `<p class="dim" style="padding:8px">Orderbuch wird abonniert … (Live-Bücher gibt es für die ${((A.S.info || {}).focus || []).length || "aktuellen"} Fokus-Märkte: Positionen, Orders, stärkste Signale und den hier geöffneten Markt).</p>`;
    const asks = b.asks.slice(0, 14).reverse(), bids = b.bids.slice(0, 14);
    const mx = Math.max(...asks.concat(bids).map((x) => x[0] * x[1]), 1);
    let cumA = 0, cumB = 0;
    const cumAs = b.asks.slice(0, 14).map((x) => (cumA += x[0] * x[1])).reverse();
    const rowA = asks.map((x, i) => `<div class="down">${px(x[0])}</div><div>${f(x[1], 3)}<span class="bk" style="right:0;width:${(x[0] * x[1] / mx) * 100}%;background:var(--down)"></span></div><div class="dim">${kusd(cumAs[i])}</div>`).join("");
    const rowB = bids.map((x) => { cumB += x[0] * x[1]; return `<div class="up">${px(x[0])}</div><div>${f(x[1], 3)}<span class="bk" style="right:0;width:${(x[0] * x[1] / mx) * 100}%;background:var(--up)"></span></div><div class="dim">${kusd(cumB)}</div>`; }).join("");
    const fe = d.view.features || {};
    const mid = b.bids.length && b.asks.length ? (b.bids[0][0] + b.asks[0][0]) / 2 : null;
    return `<div class="ladder"><div class="amber">Preis</div><div class="amber">Größe</div><div class="amber">Σ USD</div>${rowA}` +
      `<div class="yellow b">${px(mid)}</div><div class="dim">Spread ${f(fe.spread_bps, 1)} bps</div><div class="dim">${d.book_ok ? "live" : "alt"}</div>${rowB}</div>` +
      `<div class="note" style="padding:4px 6px">Imbalance Top5 <b class="${cls(fe.book_imb5)}">${sgn(fe.book_imb5)}</b> · Top20 <b class="${cls(fe.book_imb20)}">${sgn(fe.book_imb20)}</b> · Tiefe ±2 % <b>${kusd(fe.depth_usd)}</b> · Fluss 5m <b class="${cls(fe.flow_imb)}">${sgn(fe.flow_imb)}</b> (${f(fe.trade_rate, 1)}/min)</div>`;
  }

  function assetPos(d) {
    const p = d.position;
    if (d.order) return `<p><span class="tag info">LIMIT ${d.order.side > 0 ? "BUY" : "SELL"}</span> ${d.order.size} @ ${px(d.order.limit)}</p><p class="dim">Margin ${usd(d.order.margin)} · ${d.order.leverage}x · ${d.order.bars} Bar(s)</p>`;
    if (!p) return `<p class="dim">Flat.</p><p class="note">Status: ${esc(d.view.status)}</p>`;
    return `<div class="metrics">${metric("Seite", (p.side > 0 ? "LONG " : "SHORT ") + p.leverage + "x", p.side > 0 ? "up" : "down")}${metric("uPnL", sgn(p.upnl), cls(p.upnl), spct(p.roe, 1) + " ROE")}` +
      `${metric("Liq-Abstand", pct(p.liq_dist, 2), p.liq_dist < 0.02 ? "down" : "", "Liq " + px(p.liq_px))}${metric("R", sgn(p.r) + "R", cls(p.r), "Stop " + px(p.stop_px))}</div>`;
  }

  function votesHtml(d) {
    const v = d.view;
    const sig = v.signals || {};
    const w = d.weights || {};
    const rows = Object.keys(sig).map((k) => ({ k, s: sig[k][0], why: sig[k][1], w: w[k] || 0 }))
      .sort((a, b) => Math.abs(b.s * b.w) - Math.abs(a.s * a.w));
    const cat = (A.cache.brain && A.cache.brain.catalog) || [];
    const fam = (k) => (cat.find((x) => x.key === k) || {}).family || "";
    return `<table class="t"><thead><tr><th class="l">Strategie</th><th class="l">Familie</th><th>Score</th><th></th><th>Gewicht</th><th>Beitrag</th><th class="l">Begründung</th></tr></thead><tbody>` +
      rows.map((r) => `<tr><td class="l amber">${esc(stratName(r.k))}</td><td class="l dim">${esc(fam(r.k))}</td><td class="${cls(r.s)}">${sgn(r.s)}</td><td>${sbar(r.s, 70)}</td>` +
        `<td><span class="mbar" style="width:${Math.min(60, r.w * 300)}px"></span> ${pct(r.w, 1)}</td><td class="${cls(r.s * r.w)}">${sgn(r.s * r.w, 3)}</td><td class="l dim">${esc(r.why)}</td></tr>`).join("") +
      `</tbody></table><div class="note" style="padding:4px 8px">Ensemble ${sgn(v.ens)} · ML P(↑) ${pct(v.p_up, 1)} · FINAL <b class="${cls(v.final)}">${sgn(v.final)}</b> · Einigkeit ${pct(v.agreement, 0)} · Abdeckung ${pct(v.coverage, 0)} · P(Gewinn) ${v.pwin === null || v.pwin === undefined ? "Meta-Modell lernt noch" : pct(v.pwin, 1)}</div>`;
  }

  function featHtml(d) {
    const fe = d.view.features || {};
    const desc = (A.cache.brain && A.cache.brain.feature_desc) || {};
    return `<table class="t"><tbody>` + Object.keys(fe).map((k) => `<tr title="${esc(desc[k] || k)}"><td class="l dim">${esc(k)}</td><td class="${["ret_12", "tsmom", "bb_z", "macd_hist_z", "kf_slope_z", "book_imb5", "flow_imb", "oi_chg", "vwap_dev", "funding_z", "premium_bps"].includes(k) ? cls(fe[k]) : ""}">${CH.fmtNum(fe[k])}</td></tr>`).join("") + `</tbody></table>`;
  }

  function specHtml(d) {
    const s = d.spec || {};
    const v = d.view || {};
    const c = v.ctx || {};
    const lev = s.leverage, mm = s.maint_rate;
    const liqL = (1 - 1 / lev) / (1 - mm), liqS = (1 + 1 / lev) / (1 + mm);
    return `<table class="t"><tbody>` +
      [["Dex", s.dex || "main (validator)"], ["Hebel (immer max)", `<b class="yellow">${lev}x</b> / Börse ${s.exchange_max_leverage}x`],
        ["Initial-Margin", pct(1 / lev, 2)], ["Maintenance", pct(mm, 2) + " = ½ IM@max"], ["Liq-Abstand Long", pct(1 - liqL, 2)],
        ["Liq-Abstand Short", pct(liqS - 1, 2)], ["Taker / Maker", `${pct(s.taker_fee, 4)} / ${pct(s.maker_fee, 4)}`],
        ["Growth-Mode", s.growth_mode ? '<span class="tag ok">an (−90 %)</span>' : "aus"], ["Nur Isolated", s.only_isolated ? "ja" : "nein"],
        ["Größen-Dezimalen", s.sz_decimals], ["Klasse", esc(s.asset_class)], ["Mark / Oracle", `${px(c.mark)} / ${px(c.oracle)}`],
        ["Prämie", f((c.premium || 0) * 1e4, 1) + " bps"], ["Funding/h", isNum(c.funding_h) ? (c.funding_h * 100).toFixed(5) + "%" : "-"],
        ["Open Interest", kusd(c.oi_usd)], ["Regime", esc((v.regime || {}).label || "-") + ((v.regime || {}).why ? " · " + esc(v.regime.why) : "")]]
        .map(([k, val]) => `<tr><td class="l dim">${k}</td><td class="wrap" style="text-align:right">${val}</td></tr>`).join("") + `</tbody></table>` +
      (s.note ? `<p class="note">${esc(s.note)}</p>` : "");
  }

  function tradesTable(trades, full) {
    if (!trades.length) return '<p class="dim" style="padding:8px">Noch keine abgeschlossenen Trades.</p>';
    return `<table class="t"><thead><tr><th class="l">Ende</th><th class="l">Markt</th><th class="l">Seite</th><th>Einstieg</th><th>Ausstieg</th><th>Netto</th><th>ROE</th><th>R</th>` +
      `<th>Gebühr</th><th>Funding</th><th>Bars</th><th class="l">Grund</th>${full ? '<th class="l">Regime</th><th>Score</th><th>P(Gew)</th><th>Ep</th>' : ""}</tr></thead><tbody>` +
      trades.map((t, i) => `<tr class="click" data-i="${i}"><td class="l dim">${ts(t.exit_ms, true)}</td><td class="l amber">${esc(t.coin.replace("xyz:", ""))}</td><td class="l">${sideTag(t.side)} ${t.leverage}x</td>` +
        `<td>${px(t.entry_px)}</td><td>${px(t.exit_px)}</td><td class="${cls(t.net)} b">${sgn(t.net)}</td><td class="${cls(t.roe)}">${spct(t.roe, 1)}</td><td class="${cls(t.r_multiple)}">${sgn(t.r_multiple)}</td>` +
        `<td>${f(t.fees, 4)}</td><td class="${cls(-t.funding)}">${f(-t.funding, 4)}</td><td>${t.bars ?? "-"}</td><td class="l ${t.liquidation ? "down b" : ""}">${esc(t.reason)}</td>` +
        (full ? `<td class="l dim">${esc(t.regime)}</td><td class="${cls(t.score)}">${sgn(t.score)}</td><td>${t.pwin === null || t.pwin === undefined ? "-" : pct(t.pwin, 0)}</td><td>${t.epoch}</td>` : "") + `</tr>`).join("") + `</tbody></table>`;
  }

  /* ── F3 SIGNALE ─────────────────────────────────────────────────────── */
  RENDER.SIG = {
    build: () => panel("hm2", "Signal-Matrix · stärkste Signale zuerst (Hover = Begründung, Klick = Asset)", "SIGM", "c12 h420", {
      flush: true, right: `<input class="inp" id="s-q" placeholder="Markt filtern…" style="width:130px"><select id="s-lim"><option value="40">Top 40</option><option value="80">Top 80</option><option value="300">alle</option></select>` }) +
      canvasPanel("rej", "Warum nicht gehandelt? Ablehnungsgründe (kumuliert)", "GATE", "c6 h280") +
      canvasPanel("wgt", "Globale Strategie-Gewichte (Hedge)", "WGT", "c6 h280") +
      panel("why", "Entscheidungslage · stärkste Signale", "WHY", "c12 h360", { flush: true }),
    init() {
      if ($("#s-q")) { $("#s-q").value = A.sq || ""; $("#s-q").oninput = (e) => { A.sq = e.target.value; A.fetchedAt.sig = 0; RENDER.SIG.update(A.S); }; }
      if ($("#s-lim")) { $("#s-lim").value = String(A.slim || 40); $("#s-lim").onchange = (e) => { A.slim = +e.target.value; A.fetchedAt.sig = 0; RENDER.SIG.update(A.S); }; }
    },
    async update(S) {
      fetchCached("brain", "/api/brain", 10000);
      const sig = await fetchCached("sig", `/api/signals?limit=${A.slim || 40}&q=${encodeURIComponent(A.sq || "")}`, 3000);
      if (sig) {
        set("hm2", heatmap(sig, S, false));
        bindRowClicks("#pb-hm2");
        setR("why", `${sig.rows.length} von ${sig.total} Märkten mit Signal-Auswertung`);
        set("why", `<table class="t"><thead><tr><th class="l">Markt</th><th>FINAL</th><th></th><th class="l">Status / Begründung</th><th class="l">Top-Beiträge (Gewicht × Score)</th></tr></thead><tbody>` +
          sig.rows.map((r) => `<tr class="click" data-c="${esc(r.coin)}"><td class="l amber">${esc(r.symbol)}</td><td class="${cls(r.final)} b">${sgn(r.final)}</td><td>${sbar(r.final)}</td><td class="l">${esc(r.status)}</td>` +
            `<td class="l">${(r.contrib || []).map(([k, c]) => `<span class="${cls(c)}">${esc(stratName(k))} ${sgn(c, 3)}</span>`).join(" · ")}</td></tr>`).join("") + `</tbody></table>`);
        bindRowClicks("#pb-why");
      }
      const rej = Object.entries(S.rejects || {}).map(([k, v]) => ({ label: k, value: v, color: CH.C.amber }));
      CH.bars(cv("rej"), { items: rej, labelW: 230, fmt: (v) => Math.round(v) + "", empty: "noch keine abgelehnten Signale" });
      const w = (S.brain && S.brain.weights) || {};
      const muted = new Set((S.brain && S.brain.muted) || []);
      CH.bars(cv("wgt"), { items: Object.entries(w).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: stratName(k), value: v * 100, color: muted.has(k) ? "#566079" : CH.C.cyan })), labelW: 140, fmt: (v) => v.toFixed(1) + "%" });
    },
  };

  /* ── F4 LERNEN ──────────────────────────────────────────────────────── */
  RENDER.LRN = {
    build: () => canvasPanel("curve", "Lernkurve · Trefferquote & Information Coefficient", "CURVE", "c8 h280") +
      panel("lm", "Lernstand", "BRAIN", "c4 h280") +
      canvasPanel("wevo", "Gewichts-Evolution der Strategien (Hedge)", "EVO", "c8 h300") +
      canvasPanel("mlimp", "ML-Modell · Feature-Gewichte", "ML", "c4 h300") +
      panel("stab", "Strategie-Labor · Bayes-Posterior, IC, Schatten-PnL", "LAB", "c12 h360", { flush: true }) +
      canvasPanel("decay", "Signal-Zerfall · IC nach Horizont (Bars)", "DECAY", "c6 h320") +
      canvasPanel("fic", "Feature-Forschung · IC jedes Features", "FIC", "c6 h320") +
      panel("icr", "IC je Regime", "REGM", "c6 h300", { flush: true }) +
      panel("ica", "IC je Markt", "ASSET", "c6 h300", { flush: true }) +
      canvasPanel("calml", "Kalibrierung ML P(↑)", "CAL", "c4 h260") +
      canvasPanel("calmeta", "Kalibrierung Meta P(Gewinn)", "CAL", "c4 h260") +
      canvasPanel("metaimp", "Meta-Modell · was macht Trades profitabel?", "META", "c4 h260"),
    async update() {
      const b = await fetchCached("brain", "/api/brain", 5000);
      if (!b || !b.ready) return;
      const cur = b.curve || [];
      CH.line(cv("curve"), { xType: "num", xFmt: (v) => Math.round(v).toLocaleString(), zero: true, series: [
        { data: cur.map((p) => [p.n, p.hit - 0.5]), color: CH.C.amber, label: "Trefferquote − 50 %" },
        { data: cur.map((p) => [p.n, p.ic]), color: CH.C.cyan, label: "IC final" },
        { data: cur.map((p) => [p.n, p.ic_ens]), color: CH.C.violet, label: "IC Ensemble", dash: [3, 2] },
        { data: cur.map((p) => [p.n, p.ml_acc - 0.5]), color: CH.C.up, label: "ML-Genauigkeit − 50 %" }], yFmt: (v) => v.toFixed(3), empty: "Lernkurve erscheint nach den ersten 25 Auswertungen" });
      setR("curve", '<span class="amber">■ Treffer−50%</span> <span class="cyan">■ IC</span> <span class="violet">■ IC Ens.</span> <span class="up">■ ML−50%</span>');
      set("lm", `<div class="metrics">${metric("Ausgewertet", (b.n_resolved || 0).toLocaleString(), "amber", "Beobachtungen " + (b.n_observed || 0).toLocaleString())}` +
        metric("Horizont", b.horizon + " Bars", "", "Meta " + b.meta_h + " Bars") + metric("IC final", f(b.ic_final, 4), cls(b.ic_final)) +
        metric("Treffer (300)", pct(b.hit_recent, 1), cls((b.hit_recent || 0.5) - 0.5)) + metric("ML n", b.ml.n.toLocaleString(), "", b.ml.ready ? "aktiv" : "lernt") +
        metric("ML Brier", f(b.ml.brier, 4), b.ml.brier < 0.25 ? "up" : "down", "Acc " + pct(b.ml.acc, 1)) + metric("Meta n", b.meta.n.toLocaleString(), "", b.meta.ready ? "filtert Trades" : "lernt") +
        metric("Meta Brier", f(b.meta.brier, 4), "", "Acc " + pct(b.meta.acc, 1)) + metric("Stumm", (b.muted || []).length, (b.muted || []).length ? "down" : "", (b.muted || []).map(stratName).join(", ") || "keine") + `</div>` +
        `<p class="note">Jede Strategie wird auf <b>jedem Markt in jedem Takt</b> bewertet – auch ohne Trade. Nach ${b.horizon} Bars wird gelernt: Hedge-Gewichte (global × Regime × Markt), Beta-Posterior der Trefferquote, Online-Logit (ML) und Meta-Label-Modell.</p>`);
      const keys = Object.keys(b.weights || {});
      CH.line(cv("wevo"), { xType: "num", xFmt: (v) => Math.round(v).toLocaleString(), lastLabel: false, yFmt: (v) => (v * 100).toFixed(1) + "%",
        series: keys.map((k, i) => ({ data: cur.filter((p) => p.w).map((p) => [p.n, p.w[k]]), color: CH.PALETTE[i % CH.PALETTE.length], label: stratName(k), width: 1.2 })) });
      setR("wevo", keys.slice(0, 20).map((k, i) => `<span style="color:${CH.PALETTE[i % CH.PALETTE.length]}">■${esc(k)}</span>`).join(" "));
      CH.bars(cv("mlimp"), { items: (b.ml_importance || []).slice(0, 16).map((r) => ({ label: r.feature, value: r.weight })), labelW: 110, fmt: (v) => v.toFixed(3) });
      set("stab", strategyTable(b));
      const top = (b.strategies || []).filter((s) => !["ensemble"].includes(s.key)).sort((x, y) => Math.abs(y.ic) - Math.abs(x.ic)).slice(0, 9);
      CH.line(cv("decay"), { xType: "num", zero: true, xFmt: (v) => Math.round(v) + "", yFmt: (v) => v.toFixed(3), lastLabel: false,
        series: top.map((s, i) => ({ data: (b.horizons || []).map((h) => [h, s.decay[h]]), color: s.key === "final" ? "#ffffff" : CH.PALETTE[i % CH.PALETTE.length], label: stratName(s.key), width: s.key === "final" ? 2.2 : 1.2 })) });
      setR("decay", top.map((s, i) => `<span style="color:${s.key === "final" ? "#fff" : CH.PALETTE[i % CH.PALETTE.length]}">■${esc(s.key)}</span>`).join(" "));
      CH.bars(cv("fic"), { items: (b.feature_ic || []).slice(0, 18).map((r) => ({ label: r.feature, value: r.ic, tip: (b.feature_desc || {})[r.feature] })), labelW: 110, fmt: (v) => v.toFixed(3) });
      set("icr", icMatrix(b.ic_regime, "Regime"));
      set("ica", icMatrix(b.ic_asset, "Markt"));
      calChart(cv("calml"), b.cal_ml);
      calChart(cv("calmeta"), b.cal_meta);
      CH.bars(cv("metaimp"), { items: (b.meta_importance || []).slice(0, 14).map((r) => ({ label: r.feature, value: r.weight })), labelW: 110, fmt: (v) => v.toFixed(3) });
    },
  };

  function strategyTable(b) {
    const rows = (b.strategies || []).slice().sort((x, y) => (y.ic || 0) - (x.ic || 0));
    const cat = b.catalog || [];
    return `<table class="t"><thead><tr><th class="l">Strategie</th><th class="l">Familie</th><th>Gewicht</th><th>n</th><th>Treffer</th><th>Posterior</th><th>95 %-KI</th><th>P(Kante)</th>` +
      `<th>IC</th><th>t-Wert</th><th>Schatten-PnL</th>${(b.horizons || []).map((h) => `<th>IC@${h}</th>`).join("")}<th class="l">Status</th></tr></thead><tbody>` +
      rows.map((s) => {
        const c = cat.find((x) => x.key === s.key) || {};
        return `<tr><td class="l amber" title="${esc(c.description || "")}">${esc(stratName(s.key))}</td><td class="l dim">${esc(c.family || "Meta")}</td><td>${s.weight === null ? "-" : pct(s.weight, 1)}</td>` +
          `<td>${s.n.toLocaleString()}</td><td class="${cls((s.hit || 0.5) - 0.5)}">${pct(s.hit, 1)}</td><td>${pct(s.post_mean, 1)}</td><td class="dim">${s.ci ? pct(s.ci[0], 0) + "–" + pct(s.ci[1], 0) : "-"}</td>` +
          `<td class="${cls((s.p_edge || 0.5) - 0.5)}">${pct(s.p_edge, 0)}</td><td class="${cls(s.ic)} b">${f(s.ic, 3)}</td><td class="${Math.abs(s.t) > 2 ? cls(s.t) + " b" : "dim"}">${f(s.t, 1)}</td>` +
          `<td class="${cls(s.shadow)}">${f(s.shadow, 1)}</td>${(b.horizons || []).map((h) => `<td style="${heat(s.decay[h], 0.3)}">${f(s.decay[h], 3)}</td>`).join("")}` +
          `<td class="l">${s.muted ? '<span class="tag bad">STUMM</span>' : c.live_only ? '<span class="tag info">nur live</span>' : ""}</td></tr>`;
      }).join("") + `</tbody></table>`;
  }

  function icMatrix(m, label) {
    m = m || {};
    const keys = Object.keys(m).filter((k) => Object.keys(m[k] || {}).length);
    if (!keys.length) return '<p class="dim" style="padding:8px">Noch zu wenige Beobachtungen.</p>';
    const cols = [...new Set(keys.flatMap((k) => Object.keys(m[k])))].sort();
    return `<table class="hm"><thead><tr><th class="l">Strategie \\ ${label}</th>${cols.map((c) => `<th>${esc(c.replace("xyz:", ""))}</th>`).join("")}</tr></thead><tbody>` +
      keys.map((k) => `<tr><td class="l amber">${esc(stratName(k))}</td>${cols.map((c) => `<td style="${heat(m[k][c], 0.3)}" title="${esc(stratName(k))} @ ${esc(c)}: IC ${f(m[k][c], 3)}">${isNum(m[k][c]) ? Math.round(m[k][c] * 100) : "·"}</td>`).join("")}</tr>`).join("") + `</tbody></table>`;
  }

  function calChart(canvas, tab) {
    const pts = (tab || []).filter((r) => r.n > 0).map((r) => [r.pred, r.obs]);
    CH.line(canvas, { xType: "num", fixedY: [0, 1], xFmt: (v) => v.toFixed(1), yFmt: (v) => v.toFixed(2), lastLabel: false,
      series: [{ data: [[0, 0], [1, 1]], color: "#3a4560", dash: [3, 3], label: "perfekt" }, { data: pts, color: CH.C.amber, label: "beobachtet", width: 2 }],
      markers: pts.map((p) => ({ x: p[0], y: p[1], color: CH.C.amber })), empty: "noch keine Prognosen" });
  }

  /* ── F5 RISIKO ──────────────────────────────────────────────────────── */
  RENDER.RISK = {
    build: () => panel("rpos", "Positionsrisiko · Liquidations-Mathematik", "RISK", "c12 h240", { flush: true }) +
      panel("stress", "Stresstest · sofortiger Kursschock auf alle Positionen", "STRS", "c6 h280", { flush: true }) +
      canvasPanel("expo", "Exposure je Markt (Notional, ± = Long/Short)", "EXPO", "c6 h280") +
      panel("gauge", "Risiko-Kennzahlen", "VAR", "c4 h300") +
      canvasPanel("dd", "Drawdown", "DD", "c4 h300") +
      panel("rules", "Risiko-Regeln (aktiv)", "RULE", "c4 h300") +
      panel("corr", "Korrelationsmatrix (Bar-Renditen)", "CORR", "c12 h320", { flush: true }),
    async update(S) {
      set("rpos", positionsTable(S, false));
      set("stress", stressTable(S));
      const ex = S.positions.map((p) => ({ label: p.coin.replace("xyz:", ""), value: p.side * p.notional }));
      CH.bars(cv("expo"), { items: ex, labelW: 80, fmt: (v) => "$" + v.toFixed(0), empty: "keine Positionen" });
      const eq = S.equity || [];
      const rets = [];
      for (let i = 1; i < eq.length; i++) if (eq[i][2] === eq[i - 1][2] && eq[i - 1][1] > 0) rets.push(eq[i][1] / eq[i - 1][1] - 1);
      const sorted = rets.slice().sort((a, b) => a - b);
      const var95 = sorted.length > 20 ? sorted[Math.floor(sorted.length * 0.05)] : null;
      const a = S.account;
      set("gauge", `<div class="metrics">${metric("Margin-Auslastung", pct(a.equity ? a.used_margin / a.equity : 0, 1), "", "Limit " + pct((A.cache.cfg || { config: { risk: {} } }).config.risk.max_total_margin_pct, 0))}` +
        metric("Effektiver Hebel", f(a.equity ? a.exposure / a.equity : 0, 2) + "x") + metric("Netto-Exposure", usd(S.positions.reduce((s, p) => s + p.side * p.notional, 0), 0)) +
        metric("Drawdown", pct(a.drawdown, 2), a.drawdown > 0.1 ? "down" : "") + metric("Max DD", pct(a.max_dd, 2)) + metric("VaR 95 % / Takt", pct(var95, 3), "down", "historisch") +
        metric("Nächste Liq", S.positions.length ? pct(Math.min(...S.positions.map((p) => p.liq_dist)), 2) : "-", "down") +
        metric("Pause", S.paused ? "MANUELL" : S.paused_until > S.t ? "bis " + ts(S.paused_until) : "nein", S.paused || S.paused_until > S.t ? "down" : "up") + `</div>`);
      let peak = -Infinity;
      const dd = eq.map((e) => { peak = Math.max(peak, e[1]); return [e[0], -(1 - e[1] / peak)]; });
      CH.line(cv("dd"), { series: [{ data: dd, color: CH.C.down, fill: true, fillBase: 0, label: "DD" }], yFmt: (v) => (v * 100).toFixed(1) + "%" });
      const cfg = await fetchCached("cfg", "/api/config", 60000);
      if (cfg) {
        const r = cfg.config.risk;
        set("rules", `<table class="t"><tbody>` + Object.entries(r).map(([k, v]) => `<tr><td class="l dim">${esc(k)}</td><td>${esc(String(v))}</td></tr>`).join("") + `</tbody></table>`);
      }
      const corr = await fetchCached("corr", "/api/corr", 30000);
      if (corr && corr.coins) {
        set("corr", `<table class="hm"><thead><tr><th></th>${corr.coins.map((c) => `<th>${esc(c.replace("xyz:", ""))}</th>`).join("")}</tr></thead><tbody>` +
          corr.coins.map((c, i) => `<tr><td class="l amber">${esc(c.replace("xyz:", ""))}</td>${corr.m[i].map((v, j) => `<td style="${i === j ? "background:#1b2436" : heat(v, 1)}">${f(v, 2)}</td>`).join("")}</tr>`).join("") + `</tbody></table>`);
      }
    },
  };

  function stressTable(S) {
    const P = S.positions;
    if (!P.length) return '<p class="dim" style="padding:8px">Keine Positionen – kein Stressrisiko.</p>';
    const shocks = [-0.2, -0.1, -0.05, -0.02, 0.02, 0.05, 0.1, 0.2];
    const eq = S.account.equity;
    const rows = shocks.map((sh) => {
      let pnl = 0;
      const liq = [];
      for (const p of P) {
        const np = p.mark * (1 + sh);
        const hit = p.side > 0 ? np <= p.liq_px : np >= p.liq_px;
        if (hit) { pnl += -p.equity; liq.push(p.coin.replace("xyz:", "")); }
        else pnl += p.side * p.size * (np - p.mark);
      }
      return `<tr><td class="${cls(sh)} b">${spct(sh, 0)}</td><td class="${cls(pnl)}">${sgn(pnl)}</td><td>${usd(eq + pnl)}</td><td class="${cls(pnl)}">${spct(eq ? pnl / eq : 0, 1)}</td><td class="l down">${liq.join(", ") || '<span class="dim">–</span>'}</td></tr>`;
    });
    return `<table class="t"><thead><tr><th>Schock</th><th>PnL</th><th>Equity danach</th><th>Δ</th><th class="l">Liquidiert</th></tr></thead><tbody>${rows.join("")}</tbody></table>` +
      '<p class="note" style="padding:4px 8px">Vereinfachung: alle Märkte bewegen sich gleichzeitig um den Schock (Korrelation 1, keine Stops). Isolated Margin begrenzt den Verlust je Position auf deren Margin.</p>';
  }

  /* ── F6 FORSCHUNG ───────────────────────────────────────────────────── */
  RENDER.RES = {
    build: () => panel("rhead", "Forschungslabor · Walk-Forward-Backtest auf Hyperliquid-Historie", "RES", "c12") +
      panel("rmet", "Out-of-Sample-Kennzahlen", "PERF", "c12") +
      canvasPanel("req", "Backtest-Equity (violett = Ende der Lernphase)", "BT", "c8 h300") +
      canvasPanel("mc", "Monte Carlo · 5/25/50/75/95 %-Pfade", "MC", "c4 h300") +
      panel("mcs", "Monte-Carlo-Statistik", "RUIN", "c4 h260") +
      canvasPanel("rhist", "Verteilung R-Multiple", "DIST", "c4 h260") +
      canvasPanel("rhour", "PnL nach Stunde (UTC)", "HOUR", "c4 h260") +
      panel("rasset", "Ergebnis je Markt", "ASSET", "c6 h280", { flush: true }) +
      panel("rmkt", "Marktstruktur · Volatilität, eingefrorene Bars, Funding, Kosten", "MKT", "c6 h280", { flush: true }) +
      panel("rreg", "Ergebnis je Regime & Exit-Gründe", "REGM", "c6 h260", { flush: true }) +
      panel("rcorr", "Korrelation (Historie)", "CORR", "c6 h260", { flush: true }) +
      panel("rstrat", "Strategie-Forschung (IC je Horizont, nach Walk-Forward)", "ALPHA", "c12 h360", { flush: true }),
    init() { A.fetchedAt.research = 0; },
    async update() {
      const r = await fetchCached("research", "/api/research", A.cache.research && A.cache.research.running ? 2000 : 20000);
      if (!r) return;
      const rep = r.report;
      set("rhead", `<div class="row"><button class="btn" id="btn-res">▶ Research starten</button><select id="res-mode"><option value="maker">Maker-Einstieg</option><option value="taker">Taker-Einstieg</option></select>` +
        `<span class="dim">${r.running ? "läuft … " + pct(r.progress, 0) : rep ? `${esc(rep.label)} · erzeugt ${ts(rep.generated, true)} · ${ts(rep.period.start, true)} → ${ts(rep.period.end, true)} · ${rep.period.bars} Bars ${rep.interval} · Lernphase bis ${ts(rep.period.train_end, true)}` : "noch kein Report"}</span>` +
        (r.error ? `<span class="down">Fehler: ${esc(r.error)}</span>` : "") + `</div>` + (r.running ? `<div class="progress" style="margin-top:6px"><i style="width:${r.progress * 100}%"></i></div>` : "") +
        `<p class="note">Der Backtest nutzt exakt dieselbe Engine wie der Live-Bot (Margin, Liquidation, Funding, Gebühren, Slippage aus den aktuellen Orderbüchern kalibriert). Die erste Phase wird nur gelernt, danach wird out-of-sample gehandelt und weitergelernt. <b>Hinweis:</b> Historische Kerzen sind Trade-Preise (Bid/Ask-Bounce in dünnen Märkten) – live baut der Bot Kerzen aus dem Mark-Preis.</p>`);
      const btn = $("#btn-res");
      if (btn) btn.onclick = startResearch;
      if (!rep) return;
      const m = rep.metrics_oos || {}, t = rep.trades_oos || {};
      const fixed = rep.config.mode === "fixed";
      set("rmet", `<div class="metrics">${fixed ? metric("PnL OOS", sgn(t.net) + " $", cls(t.net), `Ø ${sgn(t.expectancy)} $/Trade`) : ""}${metric("Rendite OOS", spct(m.chained_return), cls(m.chained_return), fixed ? `auf ${usd(rep.config.starting_balance, 0)} Referenz` : "")}${metric("Sharpe", f(m.sharpe, 2), cls(m.sharpe))}${metric("Sortino", f(m.sortino, 2), cls(m.sortino))}` +
        metric("Max DD", pct(m.max_dd, 1), "down") + metric("Epochen", m.epochs ?? "-", m.epochs > 1 ? "down" : "", "Ruin-Neustarts") + metric("Trades", t.n ?? 0) + metric("Treffer", pct(t.win_rate, 1)) +
        metric("Profit-Faktor", f(t.profit_factor, 2), (t.profit_factor || 0) > 1 ? "up" : "down") + metric("Ø R", sgn(t.avg_r), cls(t.avg_r)) + metric("Netto", sgn(t.net) + " $", cls(t.net)) +
        metric("Gebühren", usd(t.fees, 2), "down") + metric("Funding", usd(-(t.funding || 0), 2), cls(-(t.funding || 0))) + metric("Liquidationen", t.liquidations ?? 0, t.liquidations ? "down" : "") +
        metric("Max Verlustserie", t.max_consec_losses ?? "-") + metric("Ø Haltedauer", f(t.avg_bars, 1) + " Bars") + `</div>`);
      const eq = rep.equity || [];
      if (fixed) equityChart(cv("req"), eq, rep.config.starting_balance, true);
      else CH.line(cv("req"), { series: [{ data: eq.map((e) => [e[0], e[1]]), color: CH.C.amber, fill: true, label: "Equity", fillBase: rep.config.starting_balance }],
        vlines: [{ x: rep.period.train_end, label: "Start OOS", color: CH.C.violet }], hlines: [{ y: rep.config.starting_balance, color: CH.C.cyan, label: "Start", include: true }], yFmt: (v) => v.toFixed(2) });
      const mc = rep.monte_carlo || {};
      if (mc.ok && mc.mode === "fixed") {
        CH.fan(cv("mc"), { steps: mc.fan_steps, fan: mc.fan, start: 0 });
        set("mcs", `<div class="metrics">${metric("P(Gewinn)", pct(mc.p_profit, 1), cls(mc.p_profit - 0.5), `nach ${mc.n_trades} Trades`)}` +
          metric("Median-PnL", sgn(mc.final_pct["50"]) + " $", cls(mc.final_pct["50"])) + metric("5 % / 95 %", `${sgn(mc.final_pct["5"], 0)} / ${sgn(mc.final_pct["95"], 0)} $`) +
          metric("Ø Trade", sgn(mc.mean_trade) + " $", cls(mc.mean_trade), "± " + f(mc.std_trade, 2)) + metric("Median-MaxDD", usd(mc.median_max_dd), "down") +
          metric("95 %-MaxDD", usd(mc.p95_max_dd), "down") + metric("P(−Referenz)", pct(mc.p_ruin, 1), mc.p_ruin > 0.05 ? "down" : "up", `Verlust ≥ ${usd(mc.reference, 0)}`) + `</div>` +
          `<p class="note">${mc.n_paths} Pfade × ${mc.n_trades} Trades à ${usd(rep.config.position_margin_usd || 100, 0)} Margin, Bootstrap aus ${mc.n_source_trades} OOS-Trades – PnL addiert sich (feste Positionsgröße).</p>`);
      } else if (mc.ok) {
        CH.fan(cv("mc"), { steps: mc.fan_steps, fan: mc.fan, start: rep.config.starting_balance });
        set("mcs", `<div class="metrics">${metric("P(Ruin)", pct(mc.p_ruin, 1), mc.p_ruin > 0.1 ? "down" : "up", "Equity < 5 %")}${metric("P(Gewinn)", pct(mc.p_profit, 1), cls(mc.p_profit - 0.5))}` +
          metric("P(Verdopplung)", pct(mc.p_double, 1)) + metric("P(Halbierung)", pct(mc.p_halve, 1), "down") + metric("Median Ende", usd(mc.final_pct["50"]), cls(mc.final_pct["50"] - rep.config.starting_balance)) +
          metric("5 % / 95 %", usd(mc.final_pct["5"], 0) + " / " + usd(mc.final_pct["95"], 0)) + metric("Median MaxDD", pct(mc.median_max_dd, 0), "down") + metric("Kelly-Faktor", f(mc.kelly, 2), "", "× aktuelle Größe") + `</div>` +
          `<p class="note">${mc.n_paths} Pfade × ${mc.n_trades} Trades, Bootstrap aus ${mc.n_source_trades} OOS-Trades (Rendite relativ zum Equity bei Einstieg).</p>`);
      } else { CH.fan(cv("mc"), { steps: [] }); set("mcs", `<p class="dim">${esc(mc.reason || "keine Daten")}</p>`); }
      CH.hist(cv("rhist"), { values: (rep.trades || []).filter((x) => x.entry_ms >= rep.period.train_end).map((x) => x.r_multiple), bins: 18, empty: "keine OOS-Trades" });
      CH.bars(cv("rhour"), { vertical: true, items: (rep.hourly || []).map((h) => ({ label: h.hour, value: h.net, tip: h.n + " Trades" })), fmt: (v) => v.toFixed(2) });
      set("rasset", `<table class="t"><thead><tr><th class="l">Markt</th><th>n</th><th>Netto</th><th>Treffer</th><th>Ø R</th><th>Gebühr</th><th>Funding</th><th>Liq</th></tr></thead><tbody>` +
        Object.entries(rep.per_asset || {}).sort((a, b) => b[1].net - a[1].net).map(([c, s]) => `<tr><td class="l amber">${esc(c)}</td><td>${s.n}</td><td class="${cls(s.net)} b">${sgn(s.net)}</td><td>${pct(s.win_rate, 0)}</td><td class="${cls(s.avg_r)}">${sgn(s.avg_r)}</td><td>${f(s.fees, 3)}</td><td>${f(-s.funding, 3)}</td><td class="${s.liquidations ? "down" : ""}">${s.liquidations}</td></tr>`).join("") + `</tbody></table>`);
      set("rmkt", `<table class="t"><thead><tr><th class="l">Markt</th><th>Vola p.a.</th><th>Eingefroren</th><th>Ø Range</th><th>Kurtosis</th><th>Funding p.a.</th><th>Fund&gt;0</th><th>Spread</th><th>Tiefe ±2%</th></tr></thead><tbody>` +
        Object.entries(rep.market || {}).map(([c, s]) => { const k = (rep.costs || {})[c] || {}; return `<tr><td class="l amber">${esc(c)}</td><td>${pct(s.vol_ann, 0)}</td><td class="${s.stale_frac > 0.6 ? "down" : ""}">${pct(s.stale_frac, 0)}</td><td>${f(s.avg_range_bps, 1)} bps</td><td>${f(s.kurtosis, 1)}</td><td class="${cls(-s.funding_ann)}">${spct(s.funding_ann, 1)}</td><td>${pct(s.funding_pos_frac, 0)}</td><td>${f(k.spread_bps, 1)} bps</td><td>${kusd(k.depth_usd)}</td></tr>`; }).join("") + `</tbody></table>`);
      const reasons = (rep.trades_oos || {}).reasons || {};
      set("rreg", `<table class="t"><thead><tr><th class="l">Regime</th><th>n</th><th>Netto</th><th>Treffer</th></tr></thead><tbody>` +
        Object.entries(rep.per_regime || {}).map(([k, s]) => `<tr><td class="l">${esc(k)}</td><td>${s.n}</td><td class="${cls(s.net)}">${sgn(s.net)}</td><td>${pct(s.win_rate, 0)}</td></tr>`).join("") +
        `</tbody></table><table class="t"><thead><tr><th class="l">Exit-Grund</th><th>Anzahl</th></tr></thead><tbody>` + Object.entries(reasons).map(([k, v]) => `<tr><td class="l">${esc(k)}</td><td>${v}</td></tr>`).join("") + `</tbody></table>`);
      const co = rep.correlation || {};
      if (co.coins) set("rcorr", `<table class="hm"><thead><tr><th></th>${co.coins.map((c) => `<th>${esc(c.replace("xyz:", ""))}</th>`).join("")}</tr></thead><tbody>` +
        co.coins.map((c, i) => `<tr><td class="l amber">${esc(c.replace("xyz:", ""))}</td>${co.m[i].map((v, j) => `<td style="${i === j ? "background:#1b2436" : heat(v, 0.6)}">${f(v, 2)}</td>`).join("")}</tr>`).join("") + `</tbody></table>`);
      if (rep.brain) { A.cache.brain = A.cache.brain || { catalog: rep.strategies }; set("rstrat", strategyTable({ ...rep.brain, catalog: rep.strategies })); }
    },
  };

  async function startResearch() {
    const mode = ($("#res-mode") || {}).value || "maker";
    await getJSON("/api/research/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entry_mode: mode }) });
    A.fetchedAt.research = 0;
    status("Research gestartet (" + mode + ") – lädt Historie, kalibriert Kosten, Walk-Forward …");
  }

  /* ── F7 BLOTTER ─────────────────────────────────────────────────────── */
  RENDER.BLTR = {
    build: () => panel("bsum", "Trade-Statistik (gesamte Historie aus der Datenbank)", "STAT", "c12") +
      panel("btab", "Blotter · alle simulierten Trades", "BLTR", "c8 h480", { flush: true }) +
      panel("bdet", "Trade-Detail · warum wurde gehandelt?", "DET", "c4 h480") +
      canvasPanel("bcoin", "Netto je Markt", "PNL", "c6 h240") + canvasPanel("bhist", "Verteilung Netto-PnL", "DIST", "c6 h240"),
    async update() {
      const trades = await fetchCached("trades", "/api/history/trades", 8000);
      if (!trades) return;
      const T = trades.slice().reverse();
      const net = T.map((t) => t.net);
      const wins = net.filter((x) => x > 0), losses = net.filter((x) => x <= 0);
      const gw = wins.reduce((a, b) => a + b, 0), gl = -losses.reduce((a, b) => a + b, 0);
      set("bsum", `<div class="metrics">${metric("Trades", T.length)}${metric("Netto", sgn(gw - gl) + " $", cls(gw - gl))}${metric("Treffer", pct(T.length ? wins.length / T.length : null, 1))}` +
        metric("Profit-Faktor", gl ? f(gw / gl, 2) : "-") + metric("Ø Gewinn", sgn(wins.length ? gw / wins.length : null), "up") + metric("Ø Verlust", sgn(losses.length ? -gl / losses.length : null), "down") +
        metric("Liquidationen", T.filter((t) => t.reason && t.reason.startsWith("LIQ")).length, "down") + metric("Gebühren", usd(T.reduce((a, t) => a + t.fees, 0), 3)) +
        metric("Funding", usd(-T.reduce((a, t) => a + t.funding, 0), 3)) + metric("Long / Short", T.filter((t) => t.side > 0).length + " / " + T.filter((t) => t.side < 0).length) + `</div>`);
      set("btab", tradesTable(T, true));
      document.querySelectorAll("#pb-btab tr[data-i]").forEach((tr) => (tr.onclick = () => { A.tradeSel = T[+tr.dataset.i]; showTrade(); }));
      showTrade();
      const byCoin = {};
      T.forEach((t) => (byCoin[t.coin] = (byCoin[t.coin] || 0) + t.net));
      CH.bars(cv("bcoin"), { items: Object.entries(byCoin).map(([k, v]) => ({ label: k.replace("xyz:", ""), value: v })), labelW: 80, fmt: (v) => v.toFixed(2), empty: "noch keine Trades" });
      CH.hist(cv("bhist"), { values: net, bins: 20, empty: "noch keine Trades" });
    },
  };

  function showTrade() {
    const t = A.tradeSel;
    if (!t) { set("bdet", '<p class="dim">Trade in der Tabelle anklicken.</p>'); return; }
    const d = t.detail || {};
    const dec = d.decision || {};
    set("bdet", `<p><b class="amber">${esc(t.coin)}</b> ${sideTag(t.side)} ${t.leverage}x · Epoche ${t.epoch}</p>` +
      `<table class="t"><tbody>${[["Einstieg", `${px(t.entry_px)} · ${ts(t.entry_ms, true)}`], ["Ausstieg", `${px(t.exit_px)} · ${ts(t.exit_ms, true)}`], ["Grund", esc(t.reason)],
        ["Größe", t.size], ["Margin", usd(t.margin)], ["PnL brutto", sgn(t.pnl)], ["Gebühren", f(t.fees, 4)], ["Funding", f(-t.funding, 4)], ["Netto", `<b class="${cls(t.net)}">${sgn(t.net)}</b> (${spct(t.roe, 1)} ROE)`],
        ["R-Multiple", sgn(t.r_multiple)], ["MAE / MFE", `${pct(t.mae, 2)} / ${pct(t.mfe, 2)}`], ["Regime", esc(t.regime)], ["Score", sgn(t.score)], ["P(Gewinn)", t.pwin === null ? "-" : pct(t.pwin, 1)],
        ["Init-Stop / TP", `${px(d.init_stop)} / ${px(d.tp)}`], ["ATR", px(d.atr)], ["Ensemble / P(↑)", `${sgn(dec.ens)} / ${pct(dec.p_up, 1)}`], ["Einigkeit", pct(dec.agreement, 0)],
        ["Margin-Anteil", pct(dec.margin_pct, 1)], ["Ausführung", esc(dec.fill || "-")]].map(([k, v]) => `<tr><td class="l dim">${k}</td><td>${v}</td></tr>`).join("")}</tbody></table>` +
      `<p class="amber" style="margin:8px 0 2px">Beiträge zur Entscheidung</p>` + ((dec.contrib || []).map(([k, c]) => `<div>${sbar(c * 4, 70)} <span class="${cls(c)}">${sgn(c, 3)}</span> ${esc(stratName(k))}</div>`).join("") || '<span class="dim">-</span>') +
      ((dec.notes || []).length ? `<p class="note">${dec.notes.map(esc).join(" · ")}</p>` : ""));
  }

  /* ── F8 JOURNAL ─────────────────────────────────────────────────────── */
  RENDER.JRNL = {
    build: () => panel("jfilt", "Filter", "FLT", "c12") + panel("jall", "Entscheidungs-Journal · jede Entscheidung mit Begründung", "JRNL", "c12 h560"),
    async update() {
      const kinds = ["ALL", "ENTRY", "EXIT", "LIQ", "ORDER", "CANCEL", "SKIP", "FUND", "RUIN", "INFO"];
      if (!$("#jsearch")) {
        set("jfilt", `<div class="row">${kinds.map((k) => `<span class="tag ${A.jFilter === k ? "warn" : ""}" style="cursor:pointer" data-k="${k}">${k}</span>`).join("")}<input class="inp" id="jsearch" placeholder="Suche (Markt, Text)…" style="width:260px"></div>`);
        document.querySelectorAll("#pb-jfilt [data-k]").forEach((el) => (el.onclick = () => { A.jFilter = el.dataset.k; document.querySelectorAll("#pb-jfilt [data-k]").forEach((x) => x.classList.toggle("warn", x.dataset.k === A.jFilter)); RENDER.JRNL.update(); }));
        $("#jsearch").oninput = (e) => { A.jSearch = e.target.value.toLowerCase(); RENDER.JRNL.update(); };
      }
      const all = await fetchCached("journal", "/api/history/journal?n=3000", 6000);
      if (!all) return;
      const items = all.filter((j) => (A.jFilter === "ALL" || j.kind === A.jFilter) && (!A.jSearch || (j.coin + " " + j.text).toLowerCase().includes(A.jSearch))).slice(-800).reverse();
      set("jall", journalHtml(items));
    },
  };

  /* ── F9 SYSTEM ──────────────────────────────────────────────────────── */
  RENDER.SYS = {
    build: () => panel("feed", "Datenfeed", "FEED", "c4 h280") + panel("ctl", "Steuerung", "CTRL", "c4 h280") + panel("cnt", "Zähler", "CNT", "c4 h280") +
      panel("specs", "Markt-Spezifikationen (live aus Hyperliquid-Meta)", "SPEC", "c12", { flush: true }) +
      panel("cal", "Kosten-Kalibrierung (Orderbücher beim Start)", "COST", "c12", { flush: true }) +
      panel("cfgd", "Konfiguration (config.yaml)", "CFG", "c12 h420"),
    async update(S) {
      const i = S.info || {};
      set("feed", `<table class="t"><tbody>${[["Modus", i.kind], ["Phase", esc((i.status || {}).phase)], ["Meldung", esc((i.status || {}).msg)], ["Takt", i.interval],
        ["WebSocket", i.ws ? (i.ws.connected ? '<span class="up">verbunden</span>' : '<span class="down">getrennt</span>') : "-"], ["WS-Nachrichten", i.ws ? i.ws.messages.toLocaleString() : "-"],
        ["Reconnects", i.ws ? i.ws.reconnects : "-"], ["REST-Requests", i.rest ? i.rest.requests + " (" + i.rest.errors + " Fehler)" : "-"],
        ["Kontext-Updates", (i.feed || {}).ctx], ["Buch-Updates", (i.feed || {}).book], ["Trades", (i.feed || {}).trades], ["Bars geschlossen", (i.feed || {}).bars],
        ["Gestartet", ts(i.started, true)], ["Uhr (Bot)", ts(i.now, true)]].map(([k, v]) => `<tr><td class="l dim">${k}</td><td class="l">${v ?? "-"}</td></tr>`).join("")}</tbody></table>`);
      if (!$("#ctl-pause")) {
        set("ctl", `<div class="row" style="margin-bottom:8px"><button class="btn" id="ctl-pause">⏸ Pause</button><button class="btn green" id="ctl-resume">▶ Fortsetzen</button></div>` +
          `<div class="row" style="margin-bottom:8px"><button class="btn red" id="ctl-flat">Alle Positionen schließen</button><button class="btn red" id="ctl-reset">Konto-Reset (neue Epoche)</button></div>` +
          `<p class="note">Alles ist <b>Simulation</b>. Reset setzt das Papierkonto auf das Startkapital zurück – der gesamte Lernstand (Gewichte, Modelle, Statistiken) bleibt erhalten.</p>`);
        $("#ctl-pause").onclick = () => control("pause");
        $("#ctl-resume").onclick = () => control("resume");
        $("#ctl-flat").onclick = () => confirm("Alle Positionen schließen?") && control("flatten");
        $("#ctl-reset").onclick = () => confirm("Konto zurücksetzen?") && control("reset");
      }
      set("cnt", `<table class="t"><tbody>${Object.entries(S.counters || {}).map(([k, v]) => `<tr><td class="l dim">${esc(k)}</td><td>${v.toLocaleString()}</td></tr>`).join("")}</tbody></table>`);
      const cfg = await fetchCached("cfg", "/api/config", 60000);
      if (!cfg) return;
      const sp = cfg.specs || {};
      set("specs", `<table class="t"><thead><tr><th class="l">Markt</th><th class="l">Dex</th><th>Hebel</th><th>Börse max</th><th>Maint.</th><th>Taker</th><th>Maker</th><th>Fee-Scale</th><th>Growth</th><th>Isolated</th><th>szDec</th><th class="l">Klasse</th><th class="l">Hinweis</th></tr></thead><tbody>` +
        Object.values(sp).map((s) => `<tr><td class="l amber">${esc(s.coin)}</td><td class="l">${esc(s.dex || "main")}</td><td class="yellow b">${s.leverage}x</td><td>${s.exchange_max_leverage}x</td><td>${pct(s.maint_rate, 2)}</td><td>${pct(s.taker_fee, 4)}</td><td>${pct(s.maker_fee, 4)}</td><td>${s.deployer_fee_scale}</td><td>${s.growth_mode ? "an" : "-"}</td><td>${s.only_isolated ? "nur" : "-"}</td><td>${s.sz_decimals}</td><td class="l">${esc(s.asset_class)}</td><td class="l dim">${esc(s.note)}</td></tr>`).join("") + `</tbody></table>`);
      set("cal", `<table class="t"><thead><tr><th class="l">Markt</th><th>Spread bps</th><th>Tiefe ±2 %</th><th>Bid-Tiefe</th><th>Ask-Tiefe</th><th>Imbalance</th><th>Level</th></tr></thead><tbody>` +
        Object.entries(cfg.calib || {}).map(([c, k]) => `<tr><td class="l amber">${esc(c)}</td><td>${f(k.spread_bps, 2)}</td><td>${kusd(k.depth_usd)}</td><td>${kusd(k.bid_depth)}</td><td>${kusd(k.ask_depth)}</td><td class="${cls(k.imbalance)}">${sgn(k.imbalance)}</td><td>${k.levels ?? "-"}</td></tr>`).join("") + `</tbody></table>`);
      set("cfgd", `<pre style="margin:0;color:var(--text)">${esc(JSON.stringify(cfg.config, null, 2))}</pre>`);
    },
  };

  /* ── F10 HILFE ──────────────────────────────────────────────────────── */
  RENDER.HELP = {
    build: () => panel("help", "Kommandos", "HELP", "c6") + panel("how", "Wie der Bot denkt", "DOC", "c6"),
    update() {
      const cmds = [["GEV &lt;GO&gt;", "Asset-Seite (Chart, Buch, Stimmen) eines Marktes"], ["MON / SIG / LRN / RISK / RES / BLTR / JRNL / SYS", "Seiten (oder F1–F10)"],
        ["GEV SIG", "Signal-Matrix"], ["PAUSE / RESUME", "Neue Einstiege pausieren / fortsetzen"], ["FLAT [GEV]", "Position(en) simuliert schließen"],
        ["RESET", "Papierkonto zurücksetzen (Lernstand bleibt)"], ["RUN RES", "Forschungslauf (Walk-Forward + Monte Carlo) starten"], ["Esc oder /", "Kommandozeile fokussieren"], ["↑ / ↓", "Kommando-Historie"]];
      set("help", `<table class="t help"><tbody>${cmds.map(([k, v]) => `<tr><td class="l"><span class="kbd">${k}</span></td><td class="l">${v}</td></tr>`).join("")}</tbody></table>`);
      set("how", `<div class="note">
<p><b>1. Daten.</b> Hyperliquid-WebSocket (Orderbuch, Trades, Mark/Oracle/Funding/OI) für deine 10 Märkte inkl. HIP-3-Dex <b>xyz</b>. Kerzen werden live aus dem <b>Mark-Preis</b> gebaut.</p>
<p><b>2. Features.</b> ~60 Kennzahlen je Takt: Trend (EMA, MACD, ADX, Kalman-Filter), Mean-Reversion (Bollinger, RSI, VWAP), Volatilität (ATR, Parkinson, Garman-Klass, Perzentile), Statistik (Hurst, Varianz-Ratio, Autokorrelation, Schiefe), Carry (Funding, Prämie), Mikrostruktur (Imbalance, Microprice, Order-Flow, OI).</p>
<p><b>3. 19 Strategien + ML</b> geben je Markt eine Stimme −1…+1. Ein <b>Hedge-Algorithmus</b> gewichtet sie getrennt nach global, Regime (Trend/Range × Vola) und Markt. Strategien, deren Bayes-Posterior klar unter 50 % liegt, werden <b>stummgeschaltet</b>.</p>
<p><b>4. Meta-Modell.</b> Ein zweites Modell lernt, ob ein Signal nach Kosten (Gebühr, Spread, Slippage) Gewinn bringt, und filtert/skaliert Trades.</p>
<p><b>5. Ausführung.</b> Immer der maximale Hebel. Isolated Margin, HL-Liquidationsformel, Maintenance = ½ Initial-Margin bei max. Hebel, stündliches Funding, Taker-Fills durch das echte Orderbuch bzw. Maker-Limit am Best-Bid/-Ask. Stops liegen immer vor dem Liquidationspreis.</p>
<p><b>6. Lernen.</b> Jede Meinung jeder Strategie auf jedem Markt wird nach dem Horizont bewertet – unabhängig davon, ob gehandelt wurde. So entsteht eine Lernkurve, die viel schneller wächst als die Zahl der Trades.</p>
<p><b>7. Ruin.</b> Fällt das Konto unter die Ruin-Schwelle, startet eine neue Epoche mit 100 USD – das Gelernte bleibt.</p>
<p class="down"><b>Keine Anlageberatung.</b> Reine Simulation. Hebel-Perps auf dünnen Märkten können in Minuten liquidiert werden.</p></div>`);
    },
  };

  /* ── input handling ─────────────────────────────────────────────────── */
  function initInput() {
    const inp = $("#cmd");
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { runCommand(inp.value); inp.value = ""; }
      else if (e.key === "ArrowUp") { A.hIdx = Math.min(A.history.length - 1, A.hIdx + 1); inp.value = A.history[A.hIdx] || ""; e.preventDefault(); }
      else if (e.key === "ArrowDown") { A.hIdx = Math.max(-1, A.hIdx - 1); inp.value = A.hIdx >= 0 ? A.history[A.hIdx] : ""; e.preventDefault(); }
    });
    $("#go").onclick = () => { runCommand(inp.value); inp.value = ""; };
    document.addEventListener("keydown", (e) => {
      const m = /^F(\d+)$/.exec(e.key);
      if (m) { const p = PAGES[+m[1] - 1]; if (p) { e.preventDefault(); go(p.key); } return; }
      if ((e.key === "Escape" || e.key === "/") && document.activeElement !== inp && !(document.activeElement && document.activeElement.tagName === "INPUT")) { e.preventDefault(); inp.focus(); }
    });
    window.addEventListener("resize", () => { A.built = null; render(); });
  }

  let installEvt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installEvt = e;
    $("#install").hidden = false;
  });
  $("#install").onclick = async () => {
    if (!installEvt) return;
    installEvt.prompt();
    await installEvt.userChoice;
    installEvt = null;
    $("#install").hidden = true;
  };
  window.addEventListener("appinstalled", () => { $("#install").hidden = true; status("MULTBOT als App installiert"); });
  if ("serviceWorker" in navigator && (location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname))) {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* app install optional */ });
  }
  initInput();
  buildFkeys();
  setInterval(updateTop, 1000);
  fetchCached("cfg", "/api/config", 60000);
  fetchCached("brain", "/api/brain", 10000);
  connect();
})();
