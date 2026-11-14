/* Mohaimen's Fitness Stats: renders site/data/*.json with ECharts for the selected date range. */
(() => {
  "use strict";

  // Chart palette (canvas can't read oklch CSS tokens, so these mirror styles.css in hex).
  const C = {
    text: "#e6edf3", muted: "#8b98a5", faint: "#7a8693", line: "#5c6773", border: "#1f2833", card: "#11171f", tip: "#161b22",
    green: "#3fb950", blue: "#58a6ff", orange: "#f0883e", red: "#f85149", yellow: "#d29922",
    purple: "#bc8cff", teal: "#39c5cf", pink: "#f778ba", sky: "#79c0ff",
  };
  const CAT_COLORS = {
    Football: C.green, Running: C.orange, Walking: C.blue, Strength: C.purple, Hiking: C.teal,
    Cycling: C.yellow, Swimming: C.sky, "Cardio machines": C.pink, "Other sports": "#a5d6ff", Other: C.line,
  };
  const PHASE_FILL = { period1: "rgba(88,166,255,0.05)", period2: "rgba(188,140,255,0.06)", period3: "rgba(57,197,207,0.06)" };
  const PHASE_DOT = { period1: C.blue, period2: C.purple, period3: C.teal };
  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  // Mirrors healthstats/analysis.py (monthly_table, correlations) so ranges aggregate the same way.
  const MEANS = ["steps", "active_kcal", "exercise_min", "rhr", "hrv", "walking_hr", "vo2max", "walking_speed_kmh",
    "step_length_cm", "sleep_h", "bedtime_h", "wake_h", "weight_lb", "bmr_est", "tdee_est"];
  const SPARSE_MIN = { sleep_h: 10, bedtime_h: 10, wake_h: 10, hrv: 3, rhr: 7 };
  const CORR_TARGETS = [
    ["rhr", "Resting heart rate"], ["hrv", "HRV (SDNN)"], ["vo2max", "VO₂ max"], ["walking_speed_kmh", "Walking speed"],
    ["step_length_cm", "Step length"], ["walking_hr", "Walking heart rate"], ["steps", "Daily steps"],
    ["active_kcal", "Active calories"], ["football_games", "Football games"], ["sleep_h", "Sleep"],
  ];
  const KCAL_PER_LB = 3500;
  const PRESET_MONTHS = { "1m": 1, "3m": 3, "6m": 6, "1y": 12, "2y": 24, "5y": 60 };

  // ---------------------------------------------------------------- helpers
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const nf = (v, d = 0) => (isNum(v) ? v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—");
  const signed = (v, d = 0) => (isNum(v) ? (v > 0 ? "+" : v < 0 ? "−" : "") + nf(Math.abs(v), d) : "—");
  const sum = (a) => a.reduce((s, v) => s + (isNum(v) ? v : 0), 0);
  const mean = (a) => { const v = a.filter(isNum); return v.length ? sum(v) / v.length : null; };
  const median = (a) => { const v = a.filter(isNum).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  const pairs = (xs, ys) => xs.map((x, i) => [x, ys[i]]).filter((p) => isNum(p[1]));
  const rolling = (vals, n) => vals.map((_, i) => mean(vals.slice(Math.max(0, i - n + 1), i + 1)));
  const firstIdx = (a) => a.findIndex(isNum);
  const lbToBmi = (lb, cm) => (lb * 0.45359237) / (cm / 100) ** 2;

  const DAY = 86400000;
  const utc = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const addDays = (s, n) => iso(utc(s) + n * DAY);
  const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / DAY);
  const weekday = (s) => (new Date(utc(s)).getUTCDay() + 6) % 7;
  const addMonths = (s, n) => {
    let y = +s.slice(0, 4), m = +s.slice(5, 7) - 1 + n;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return iso(Date.UTC(y, m, Math.min(+s.slice(8, 10), last)));
  };
  const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "") && iso(utc(s)) === s;
  const maxStr = (a, b) => (a > b ? a : b);
  const minStr = (a, b) => (a < b ? a : b);

  const asDate = (s) => new Date(s.length === 7 ? `${s}-15T12:00:00` : `${s}T12:00:00`);
  const fmtDate = (s) => (s ? asDate(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
  const fmtMonth = (s) => (s ? asDate(s.slice(0, 7)).toLocaleDateString("en-US", { month: "short", year: "numeric" }) : "—");
  const clock = (h) => {
    if (!isNum(h)) return "—";
    const m = Math.round((((h % 24) + 24) % 24) * 60);
    return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };

  const UNITS = {
    day: { name: "day", len: 1, key: (s) => s, label: fmtDate },
    week: { name: "week", len: 7, key: (s) => addDays(s, -weekday(s)), label: fmtDate },
    month: { name: "month", len: 30.44, key: (s) => s.slice(0, 7), label: fmtMonth },
    year: { name: "year", len: 365.25, key: (s) => s.slice(0, 4), label: (k) => k },
  };
  const bucketDate = (k) => (k.length === 7 ? `${k}-15` : k.length === 4 ? `${k}-07-01` : k);

  // ---------------------------------------------------------------- chart helpers
  const AX = {
    axisLine: { lineStyle: { color: C.border } },
    axisTick: { show: false },
    axisLabel: { color: C.muted, hideOverlap: true },
    splitLine: { lineStyle: { color: C.border, type: "dashed" } },
    nameTextStyle: { color: C.faint, fontSize: 11 },
  };
  const timeAxis = (o = {}) => ({ type: "time", ...AX, splitLine: { show: false }, ...o });
  const catAxis = (data, o = {}) => ({ type: "category", data, ...AX, splitLine: { show: false }, ...o });
  const valAxis = (o = {}) => ({ type: "value", scale: true, ...AX, ...o });
  // Bucket axis: tooltips show the full date, tick labels drop the year for day/week buckets.
  const bucketAxis = (A, labels, o = {}) => catAxis(labels, {
    axisLabel: { ...AX.axisLabel, ...(A.unit === "day" || A.unit === "week" ? { formatter: (v) => v.replace(/, \d{4}$/, "") } : {}) }, ...o,
  });
  const tip = (o = {}) => ({
    trigger: "axis", confine: true, transitionDuration: 0, backgroundColor: C.tip, borderColor: C.border,
    textStyle: { color: C.text, fontSize: 12 }, axisPointer: { lineStyle: { color: C.line } }, ...o,
  });
  const legend = (o = {}) => ({ top: 0, textStyle: { color: C.muted }, itemWidth: 14, itemHeight: 8, icon: "roundRect", ...o });
  const grid = (o = {}) => ({ left: 6, right: 10, top: 34, bottom: 6, containLabel: true, ...o });

  const instances = new Map();
  function chart(id, option, height) {
    const el = $(id);
    if (!el) return;
    if (height) el.style.height = `${height}px`; else el.style.removeProperty("height");
    let c = instances.get(id);
    if (!c) { c = echarts.init(el, null, { renderer: "canvas" }); instances.set(id, c); }
    const title = el.closest(".card")?.querySelector("h3")?.textContent || el.closest("section")?.querySelector("h2")?.textContent || "";
    c.setOption({
      backgroundColor: "transparent", textStyle: { color: C.muted, fontFamily: FONT }, animation: false,
      aria: { enabled: true, label: { description: `${title} chart` } }, ...option,
    }, { notMerge: true });
    c.resize();
  }
  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => instances.forEach((c) => c.resize()), 120); });

  function table(id, headers, rows) {
    $(id).innerHTML = `<table><thead><tr>${headers.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }
  function kpi(label, value, unit = "", sub = "") {
    if (value === "—") return "";
    return `<div class="card kpi"><div class="label">${esc(label)}</div><div class="value">${value}${unit ? `<small>${esc(unit)}</small>` : ""}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
  }
  const hideSection = (id) => { $(id).hidden = true; };
  const hideCard = (id) => { const c = $(id)?.closest(".card"); if (c) c.hidden = true; };
  const safe = (name, fn) => { try { fn(); } catch (e) { console.error(`[${name}]`, e); } };

  // ---------------------------------------------------------------- data
  let D;
  async function load() {
    const names = ["summary", "daily", "workouts", "weight", "dexa"];
    const out = {};
    await Promise.all(names.map(async (n) => {
      const r = await fetch(`data/${n}.json`, { cache: "no-cache" });
      if (!r.ok) throw new Error(`data/${n}.json: HTTP ${r.status}`);
      out[n] = await r.json();
    }));
    const wk = out.workouts;
    out.W = wk.rows.map((r) => Object.fromEntries(wk.columns.map((c, i) => [c, r[i]])));
    out.start = out.daily.date[0];
    out.end = out.daily.date[out.daily.date.length - 1];
    return out;
  }

  function makeRange(from, to) {
    const d = D.daily, n = d.date.length;
    const clamp = (i) => Math.min(n - 1, Math.max(0, i));
    const i0 = clamp(daysBetween(D.start, from)), i1 = clamp(daysBetween(D.start, to));
    const span = i1 - i0 + 1;
    const inR = (s) => s >= from && s <= to;
    const W = D.W.filter((w) => inR(w.date));
    return {
      from, to, i0, i1, span, inR, W, FB: W.filter((w) => w.category === "Football"),
      unit: span <= 62 ? "day" : span <= 270 ? "week" : "month",
      col: (k) => (d[k] || []).slice(i0, i1 + 1),
      dates: d.date.slice(i0, i1 + 1),
    };
  }

  // Bucket daily rows and workouts in the range by day / week / month.
  function aggregate(R) {
    const U = UNITS[R.unit], d = D.daily;
    const keys = [], pos = new Map(), rows = [];
    for (let i = R.i0; i <= R.i1; i++) {
      const k = U.key(d.date[i]);
      if (!pos.has(k)) { pos.set(k, keys.length); keys.push(k); rows.push([]); }
      rows[pos.get(k)].push(i);
    }
    const A = { unit: R.unit, keys, labels: keys.map(U.label), days: rows.map((r) => r.length) };
    const scale = U.len / 30.44;
    for (const col of MEANS) {
      if (!d[col]) continue;
      const minN = SPARSE_MIN[col] ? Math.max(1, Math.round(SPARSE_MIN[col] * scale)) : 1;
      A[col] = rows.map((r) => { const v = r.map((i) => d[col][i]).filter(isNum); return v.length >= minN ? sum(v) / v.length : null; });
    }
    A.days_with_watch = rows.map((r) => r.filter((i) => d.active_kcal[i] > 50).length);

    const met = (i, a, g) => isNum(d[a]?.[i]) && isNum(d[g]?.[i]) && d[a][i] >= d[g][i];
    const ring = (a, g) => rows.map((r) => {
      const rr = r.filter((i) => d.move_goal?.[i] > 0);
      return rr.length ? (rr.filter((i) => met(i, a, g)).length / rr.length) * 100 : null;
    });
    A.move_closed_pct = ring("move_kcal", "move_goal");
    A.exercise_closed_pct = ring("exercise_ring_min", "exercise_goal");
    A.stand_closed_pct = ring("stand_hours", "stand_goal");

    // change across a bucket = first weight of the next day after it minus its own first weight
    A.weight_change_lb = rows.map((r) => {
      const ws = r.filter((i) => isNum(d.weight_lb[i]));
      if (!ws.length) return null;
      const next = d.weight_lb[r[r.length - 1] + 1];
      return (isNum(next) ? next : d.weight_lb[ws[ws.length - 1]]) - d.weight_lb[ws[0]];
    });

    const zeros = () => keys.map(() => 0);
    A.workouts = zeros(); A.workout_min = zeros(); A.football_min = zeros(); A.football_games = zeros(); A.football_km = zeros();
    for (const w of R.W) {
      const j = pos.get(U.key(w.date));
      if (j === undefined) continue;
      A.workouts[j] += 1;
      A.workout_min[j] += w.duration_min || 0;
      if (w.category === "Football") {
        A.football_games[j] += 1;
        A.football_min[j] += w.duration_min || 0;
        A.football_km[j] += w.distance_km || 0;
      }
    }
    A.implied_intake_kcal = keys.map((_, j) => (A.days_with_watch[j] >= Math.max(1, 0.65 * A.days[j]) && isNum(A.tdee_est[j]) && isNum(A.weight_change_lb[j])
      ? A.tdee_est[j] + (A.weight_change_lb[j] * KCAL_PER_LB) / A.days[j] : null));
    A.corr = correlations(A);
    return A;
  }

  function correlations(A) {
    const ok = A.keys.map((_, j) => A.days_with_watch[j] >= 0.5 * A.days[j]);
    const out = [];
    for (const [col, label] of CORR_TARGETS) {
      const ys0 = A[col];
      if (!ys0) continue;
      const xs = [], ys = [];
      A.weight_lb.forEach((w, j) => { if (ok[j] && isNum(w) && isNum(ys0[j])) { xs.push(w); ys.push(ys0[j]); } });
      if (xs.length < 8) continue;
      const mx = mean(xs), my = mean(ys);
      let sxy = 0, sxx = 0, syy = 0;
      xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; syy += (ys[i] - my) ** 2; });
      if (!sxx || !syy) continue;
      const slope = sxy / sxx;
      out.push({ metric: col, label, r: sxy / Math.sqrt(sxx * syy), n: xs.length, slope, intercept: my - slope * mx, per_10lb: slope * 10 });
    }
    return out;
  }

  function phasesIn(R) {
    const end1 = addDays(R.to, 1);
    return (D.summary.phases || []).map((p) => ({ ...p, start: maxStr(p.start, R.from), end: minStr(p.end, end1) })).filter((p) => p.start < p.end);
  }
  function phaseOf(phases, date) {
    for (const p of phases) if (date >= p.start && date < p.end) return p.key;
    return null;
  }
  const scansIn = (R) => (D.dexa || []).filter((s) => R.inR(s.date));

  // ---------------------------------------------------------------- sections
  function renderKpis(R) {
    const p = D.summary.profile || {};
    const wl = R.col("weight_lb").filter(isNum);
    const w0 = wl[0], w1 = wl[wl.length - 1];
    const scan = scansIn(R).pop();
    const vo2 = R.col("vo2max");
    const vo2Recent = mean(vo2.slice(-60)) ?? vo2.filter(isNum).pop();
    const hours = (ws) => sum(ws.map((w) => w.duration_min)) / 60;
    const denseMean = (col) => {
      const v = R.col(col).filter(isNum);
      return v.length >= (SPARSE_MIN[col] || 1) ? mean(v) : null;
    };
    $("kpis").innerHTML = [
      kpi("Weight", nf(w1, 1), "lb", isNum(w1) ? `BMI ${nf(lbToBmi(w1, p.height_cm), 1)} · ${esc(p.height_ftin || "")}` : ""),
      wl.length > 1 ? kpi("Weight change", signed(w1 - w0, 1), "lb", `${nf(w0, 1)} → ${nf(w1, 1)} lb`) : "",
      scan ? kpi("Body fat", nf(scan.body_fat_pct, 1), "%", `DEXA · ${fmtDate(scan.date)}`) : "",
      kpi("Football games", nf(R.FB.length), "", `${nf(hours(R.FB))} h · ${nf(sum(R.FB.map((g) => g.distance_km)))} km`),
      kpi("Workouts", nf(R.W.length), "", `${nf(hours(R.W))} h`),
      kpi("VO₂ max", nf(vo2Recent, 1), "ml/kg/min", "60-day mean"),
      kpi("Resting HR", nf(denseMean("rhr")), "bpm", "mean"),
      kpi("Steps", nf(mean(R.col("steps"))), "/day", "mean"),
      kpi("Sleep", nf(denseMean("sleep_h"), 1), "h/night", "mean"),
    ].join("");
  }

  function renderWeight(R, A) {
    const Wt = D.weight, h = Wt.height_cm || D.summary.profile.height_cm;
    const line = pairs(R.dates, R.col("weight_lb"));
    const logPts = Wt.log.filter((r) => R.inR(r.date)).map((r) => [r.date, r.weight_lb]);
    const scale = (Wt.weigh_ins || []).filter((r) => R.inR(r.date)).map((r) => [r.date, r.weight_lb]);
    const dexa = (Wt.dexa || []).filter((r) => R.inR(r.date)).map((r) => ({ value: [r.date, r.weight_lb], bf: r.body_fat_pct }));
    const all = [...line, ...logPts, ...scale, ...dexa.map((x) => x.value)].map((p) => p[1]);
    if (!all.length) return hideSection("weight");
    const lo = Math.floor((Math.min(...all) - 2) / 5) * 5, hi = Math.ceil((Math.max(...all) + 2) / 5) * 5;
    const phases = phasesIn(R);
    const events = (D.summary.events || []).filter((e) => R.inR(e.date));

    chart("c-weight", {
      legend: legend(),
      grid: grid({ right: 14 }),
      tooltip: tip({ trigger: "item", formatter: (p) => `${fmtDate(p.value[0])}<br><b>${nf(p.value[1], 1)} lb</b> · BMI ${nf(lbToBmi(p.value[1], h), 1)}${p.data?.bf ? `<br>${nf(p.data.bf, 1)}% body fat` : ""}<br><span style="color:${C.muted}">${p.seriesName}</span>` }),
      xAxis: timeAxis({ min: R.from, max: R.to }),
      yAxis: [
        valAxis({ min: lo, max: hi, name: "lb" }),
        valAxis({ min: lbToBmi(lo, h), max: lbToBmi(hi, h), name: "BMI", splitLine: { show: false }, axisLabel: { color: C.faint, formatter: (v) => v.toFixed(1), showMinLabel: false, showMaxLabel: false } }),
      ],
      series: [
        {
          name: "Weight", type: "line", data: line, showSymbol: false, smooth: 0.2, lineStyle: { width: 2.5, color: C.blue }, itemStyle: { color: C.blue },
          markArea: {
            silent: true,
            data: phases.length > 1 ? phases.map((p) => [
              { xAxis: p.start, itemStyle: { color: PHASE_FILL[p.key] }, label: { show: true, position: "insideTop", color: C.faint, fontSize: 11, formatter: p.label } },
              { xAxis: p.end },
            ]) : [],
          },
          markLine: {
            silent: true, symbol: "none",
            data: events.map((e) => ({ xAxis: e.date, lineStyle: { color: C.line, type: "dashed" }, label: { formatter: e.label, color: C.muted, fontSize: 10, position: "insideEndTop" } })),
          },
        },
        { name: "Monthly log", type: "scatter", data: logPts, symbolSize: 5, itemStyle: { color: C.blue } },
        { name: "Scale", type: "scatter", data: scale, symbolSize: 7, itemStyle: { color: "transparent", borderColor: C.yellow, borderWidth: 1.5 } },
        { name: "DEXA", type: "scatter", data: dexa, symbol: "diamond", symbolSize: 13, itemStyle: { color: C.orange } },
      ].filter((s) => s.data.length),
    });

    const unit = UNITS[A.unit].name;
    $("h-weight-change").textContent = `Weight change / ${unit}`;
    const wi = firstIdx(A.weight_change_lb);
    if (wi < 0) hideCard("c-weight-change");
    else {
      chart("c-weight-change", {
        grid: grid({ top: 14 }),
        tooltip: tip({ valueFormatter: (v) => `${signed(v, 1)} lb` }),
        xAxis: bucketAxis(A, A.labels.slice(wi)),
        yAxis: valAxis({ name: "lb", scale: false }),
        series: [{
          type: "bar", name: "Change", barMaxWidth: 12,
          data: A.weight_change_lb.slice(wi).map((v) => ({ value: v, itemStyle: { color: v > 0 ? C.orange : C.blue, borderRadius: v > 0 ? [2, 2, 0, 0] : [0, 0, 2, 2] } })),
        }],
      });
    }

    const perWeek = A.unit !== "day";
    const hrs = (mins) => mins.map((v, j) => (perWeek ? v / 60 / (A.days[j] / 7) : v / 60));
    const fb = hrs(A.football_min), all_ = hrs(A.workout_min);
    chart("c-weight-training", {
      legend: legend(),
      grid: grid(),
      tooltip: tip({ valueFormatter: (v) => nf(v, 1) }),
      xAxis: bucketAxis(A, A.labels),
      yAxis: [valAxis({ name: perWeek ? "h/week" : "h", scale: false }), valAxis({ name: "lb", splitLine: { show: false } })],
      series: [
        { name: "Football", type: "bar", stack: "h", data: fb, itemStyle: { color: C.green }, barMaxWidth: 12 },
        { name: "Other training", type: "bar", stack: "h", data: all_.map((v, j) => Math.max(0, v - fb[j])), itemStyle: { color: C.purple }, barMaxWidth: 12 },
        { name: "Weight", type: "line", yAxisIndex: 1, data: A.weight_lb, showSymbol: false, smooth: 0.3, lineStyle: { color: C.blue, width: 2 }, itemStyle: { color: C.blue } },
      ],
    });
  }

  function renderDexa(R) {
    const X = scansIn(R).pop();
    if (!X) return hideSection("composition");

    chart("c-dexa-donut", {
      tooltip: tip({ trigger: "item", formatter: (p) => `${p.name}: <b>${nf(p.value, 1)} lb</b> (${nf(p.percent, 1)}%)` }),
      legend: legend({ top: "bottom" }),
      title: { text: `${nf(X.total_lb, 1)} lb`, subtext: `${nf(X.body_fat_pct, 1)}% fat`, left: "center", top: "38%", textStyle: { color: C.text, fontSize: 22 }, subtextStyle: { color: C.muted } },
      series: [{
        type: "pie", radius: ["52%", "75%"], center: ["50%", "46%"], label: { show: false },
        itemStyle: { borderColor: C.card, borderWidth: 3, borderRadius: 4 },
        data: [
          { name: "Lean", value: X.lean_lb, itemStyle: { color: C.blue } },
          { name: "Fat", value: X.fat_lb, itemStyle: { color: C.orange } },
          { name: "Bone", value: X.bone_lb, itemStyle: { color: C.line } },
        ],
      }],
    });

    const Rg = X.regional || {};
    const pct = [
      ["Body fat %", X.body_fat_pct_percentile, `${nf(X.body_fat_pct, 1)}%`],
      ["Visceral fat", X.vat_lb_percentile, `${nf(X.vat_lb, 2)} lb`],
      ["Lean mass index", X.lmi_percentile, `${nf(X.lmi, 1)} kg/m²`],
      ["Appendicular lean (ALMI)", X.almi_percentile, `${nf(X.almi, 2)} kg/m²`],
      ["Bone density", X.bmd_percentile, `${nf(X.bmd, 2)} g/cm²`],
      ["Leg lean mass", Rg.legs?.lean?.percentile, `${nf(Rg.legs?.lean?.lb, 1)} lb`],
      ["Trunk lean mass", Rg.trunk?.lean?.percentile, `${nf(Rg.trunk?.lean?.lb, 1)} lb`],
      ["Arm lean mass", Rg.arms?.lean?.percentile, `${nf(Rg.arms?.lean?.lb, 1)} lb`],
    ].filter((r) => isNum(r[1])).reverse();
    if (!pct.length) hideCard("c-dexa-pct");
    else {
      chart("c-dexa-pct", {
        grid: grid({ top: 6, right: 34 }),
        tooltip: tip({ trigger: "item", formatter: (p) => `${p.name}: <b>${pct[p.dataIndex][2]}</b><br>${p.value}th percentile` }),
        xAxis: valAxis({ min: 0, max: 100, scale: false, axisLabel: { color: C.faint } }),
        yAxis: catAxis(pct.map((r) => r[0]), { axisLabel: { color: C.muted, fontSize: 11 } }),
        series: [{
          type: "bar", barWidth: 12, label: { show: true, position: "right", color: C.text },
          data: pct.map((r) => ({ value: r[1], itemStyle: { borderRadius: 3, color: C.blue } })),
          markLine: { silent: true, symbol: "none", data: [{ xAxis: 50 }], lineStyle: { color: C.line, type: "dashed" }, label: { show: false } },
        }],
      });
    }

    const regions = ["arms", "legs", "trunk", "android", "gynoid", "head"].filter((r) => Rg[r]);
    const label = (r) => r[0].toUpperCase() + r.slice(1);
    chart("c-dexa-regional", {
      legend: legend(),
      grid: grid(),
      tooltip: tip({ valueFormatter: (v) => `${nf(v, 1)} lb` }),
      xAxis: valAxis({ name: "lb", scale: false }),
      yAxis: catAxis(regions.map(label).reverse()),
      series: [["Lean", "lean", C.blue], ["Fat", "fat", C.orange], ["Bone", "bone", C.line]].map(([n, k, col]) => ({
        name: n, type: "bar", stack: "r", barWidth: 14, itemStyle: { color: col },
        data: regions.map((r) => Rg[r]?.[k]?.lb ?? null).reverse(),
      })),
    });

    const rows = Object.entries(X.symmetry || {}).map(([reg, s]) => {
      const L = s.left || {}, Rr = s.right || {};
      const diff = isNum(L.lean_lbs) && isNum(Rr.lean_lbs) ? ((Rr.lean_lbs - L.lean_lbs) / ((Rr.lean_lbs + L.lean_lbs) / 2)) * 100 : null;
      return [label(reg), nf(L.lean_lbs, 1), nf(Rr.lean_lbs, 1), `${signed(diff, 1)}%`, nf(L.fat_lbs, 1), nf(Rr.fat_lbs, 1), nf(L.total_lbs, 1), nf(Rr.total_lbs, 1)];
    });
    if (rows.length) table("t-symmetry", ["Region", "Lean L", "Lean R", "R vs L", "Fat L", "Fat R", "Total L", "Total R"], rows);
    else hideCard("t-symmetry");
  }

  function footballYears(FB) {
    const out = {};
    for (const g of FB) (out[g.date.slice(0, 4)] ||= []).push(g);
    return Object.keys(out).sort().map((y) => {
      const gs = out[y], gps = gs.filter((g) => isNum(g.top_kmh));
      return [y, nf(gs.length), nf(sum(gs.map((g) => g.duration_min)) / 60), nf(sum(gs.map((g) => g.distance_km))),
        nf(mean(gs.map((g) => g.distance_km)), 1), nf(mean(gs.map((g) => g.duration_min))), nf(mean(gs.map((g) => g.active_kcal))),
        nf(mean(gs.map((g) => g.avg_hr))), isNum(median(gps.map((g) => g.top_kmh))) ? `${nf(median(gps.map((g) => g.top_kmh)), 1)} km/h` : "—",
        nf(mean(gps.map((g) => g.sprints)), 1)];
    });
  }

  function renderFootball(R, A) {
    const FB = R.FB;
    if (!FB.length) return hideSection("football");
    const gps = FB.filter((g) => isNum(g.top_kmh));
    $("football-kpis").innerHTML = [
      kpi("Games", nf(FB.length)),
      kpi("Games / month", nf((FB.length / R.span) * 30.44, 1)),
      kpi("Distance / game", nf(mean(FB.map((g) => g.distance_km)), 1), "km"),
      kpi("Duration / game", nf(mean(FB.map((g) => g.duration_min))), "min"),
      kpi("Avg HR / game", nf(mean(FB.map((g) => g.avg_hr))), "bpm"),
      kpi("Top speed · median", nf(median(gps.map((g) => g.top_kmh)), 1), "km/h", `${nf(gps.length)} GPS games`),
      kpi("Sprints / game", nf(mean(gps.map((g) => g.sprints)), 1)),
    ].join("");

    // calendar: one row per year, cell width shared so partial years line up
    const played = pairs(R.dates, R.col("football_min")).filter((p) => p[1] > 0);
    const years = []; for (let y = +R.to.slice(0, 4); y >= +R.from.slice(0, 4); y--) years.push(y);
    const cellH = 13, perYear = cellH * 7 + 44;
    chart("c-football-cal", {
      tooltip: { formatter: (p) => `${fmtDate(p.value[0])}<br><b>${nf(p.value[1])} min</b>`, backgroundColor: C.tip, borderColor: C.border, textStyle: { color: C.text, fontSize: 12 }, transitionDuration: 0 },
      visualMap: { show: false, min: 0, max: 150, inRange: { color: ["#0e4429", "#006d32", "#26a641", "#39d353"] } },
      calendar: years.map((y, i) => {
        const a = maxStr(R.from, `${y}-01-01`), b = minStr(R.to, `${y}-12-31`);
        const weeks = Math.ceil((daysBetween(a, b) + 1 + weekday(a)) / 7);
        return {
          range: [a, b], top: 28 + i * perYear, left: 46, width: `${Math.min(92, (weeks / 53) * 92)}%`, cellSize: ["auto", cellH],
          itemStyle: { color: C.tip, borderColor: C.card, borderWidth: 2 }, splitLine: { show: false },
          yearLabel: { show: true, position: "left", color: C.muted, fontSize: 13, margin: 30 },
          monthLabel: { color: C.faint, fontSize: 10, nameMap: "en" }, dayLabel: { firstDay: 1, nameMap: ["S", "M", "T", "W", "T", "F", "S"], color: C.faint, fontSize: 9 },
        };
      }),
      series: years.map((y, i) => ({ type: "heatmap", coordinateSystem: "calendar", calendarIndex: i, data: played.filter((p) => p[0].startsWith(String(y))) })),
    }, 28 + years.length * perYear - 18);

    // games per bucket, starting at the first bucket with a game
    $("h-football-games").textContent = `Games / ${UNITS[A.unit].name}`;
    const gi = A.football_games.findIndex((v) => v > 0);
    chart("c-football-games", {
      legend: legend(),
      grid: grid(),
      tooltip: tip(),
      xAxis: bucketAxis(A, A.labels.slice(gi)),
      yAxis: [valAxis({ name: "games", scale: false, minInterval: 1 }), valAxis({ name: "km", scale: false, splitLine: { show: false } })],
      series: [
        { name: "Games", type: "bar", data: A.football_games.slice(gi), itemStyle: { color: C.green, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 14 },
        { name: "Distance (km)", type: "line", yAxisIndex: 1, data: A.football_km.slice(gi).map((v) => +v.toFixed(1)), showSymbol: false, smooth: 0.3, lineStyle: { color: C.blue, width: 1.5 }, itemStyle: { color: C.blue } },
      ],
    });

    const perGame = (id, list, key, color, unit, digits, symbol) => {
      if (!list.length) return hideCard(id);
      const roll = rolling(list.map((g) => g[key]), 15);
      chart(id, {
        grid: grid({ top: 14 }),
        tooltip: tip({ trigger: "item", formatter: (p) => `${fmtDate(p.value[0])}<br><b>${nf(p.value[1], digits)} ${unit}</b>${p.seriesName === "Rolling" ? " · 15-game mean" : ` · ${nf(list[p.dataIndex].duration_min)} min`}` }),
        xAxis: timeAxis(),
        yAxis: valAxis({ name: unit, scale: symbol !== "zero" }),
        series: [
          { name: "Game", type: "scatter", data: list.map((g) => [g.date, g[key]]), symbolSize: 5, itemStyle: { color, opacity: 0.45 } },
          { name: "Rolling", type: "line", data: list.map((g, i) => [g.date, roll[i]]), showSymbol: false, lineStyle: { color: C.text, width: 2 }, itemStyle: { color: C.text } },
        ],
      });
    };
    perGame("c-football-dist", FB.filter((g) => isNum(g.distance_km) && g.distance_km > 0.3), "distance_km", C.green, "km", 2, "zero");
    perGame("c-football-hr", FB.filter((g) => isNum(g.avg_hr)), "avg_hr", C.red, "bpm", 0);

    if (gps.length) {
      chart("c-football-speed", {
        legend: legend(),
        grid: grid(),
        tooltip: tip({ trigger: "item", formatter: (p) => { const g = gps[p.dataIndex]; return `${fmtDate(g.date)}<br>Top speed <b>${nf(g.top_kmh, 1)} km/h</b><br>${nf(g.sprints)} sprints · ${nf(g.hsr_m)} m high-speed<br>${nf(g.gps_km, 2)} km in ${nf(g.duration_min)} min`; } }),
        xAxis: timeAxis(),
        yAxis: [valAxis({ name: "km/h" }), valAxis({ name: "sprints", scale: false, splitLine: { show: false } })],
        series: [
          { name: "Top speed", type: "scatter", data: gps.map((g) => [g.date, g.top_kmh]), symbolSize: 7, itemStyle: { color: C.orange } },
          { name: "Sprints", type: "scatter", yAxisIndex: 1, data: gps.map((g) => [g.date, g.sprints]), symbol: "triangle", symbolSize: 6, itemStyle: { color: C.purple, opacity: 0.7 } },
        ],
      });
    } else hideCard("c-football-speed");

    // weekday x hour
    const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const g of FB) if (isNum(g.weekday) && isNum(g.hour)) heat[g.weekday][g.hour] += 1;
    const used = []; heat.forEach((row) => row.forEach((v, hh) => { if (v > 0) used.push(hh); }));
    const h0 = Math.max(0, Math.min(...used) - 1), h1 = Math.min(23, Math.max(...used) + 1);
    const hrs = []; for (let hh = h0; hh <= h1; hh++) hrs.push(hh);
    const hdata = []; let hmax = 1;
    heat.forEach((row, wd) => hrs.forEach((hh, j) => { hdata.push([j, wd, row[hh]]); hmax = Math.max(hmax, row[hh]); }));
    chart("c-football-when", {
      grid: grid({ top: 10, bottom: 10 }),
      tooltip: { formatter: (p) => `${WEEKDAYS[p.value[1]]} ${clock(hrs[p.value[0]])}–${clock(hrs[p.value[0]] + 1)}<br><b>${p.value[2]} games</b>`, backgroundColor: C.tip, borderColor: C.border, textStyle: { color: C.text, fontSize: 12 }, transitionDuration: 0 },
      xAxis: catAxis(hrs.map((x) => (x === 0 ? "12a" : x < 12 ? `${x}a` : x === 12 ? "12p" : `${x - 12}p`)), { axisLabel: { color: C.muted, fontSize: 10 } }),
      yAxis: catAxis(WEEKDAYS, { inverse: true }),
      visualMap: { show: false, min: 0, max: hmax, inRange: { color: [C.tip, "#0e4429", "#26a641", "#39d353"] } },
      series: [{ type: "heatmap", data: hdata, itemStyle: { borderColor: C.card, borderWidth: 2, borderRadius: 3 } }],
    });

    const zk = ["z1", "z2", "z3", "z4", "z5"];
    const zoneNames = ["Z1 easy", "Z2 aerobic", "Z3 tempo", "Z4 threshold", "Z5 max"];
    const zoneCols = [C.line, C.blue, C.green, C.orange, C.red];
    const zt = Object.fromEntries(zk.map((z) => [z, sum(FB.map((g) => g[z]))]));
    const ztotal = sum(zk.map((z) => zt[z]));
    if (ztotal) {
      chart("c-football-zones", {
        grid: grid({ top: 6, right: 70 }),
        tooltip: tip({ trigger: "item", formatter: (p) => `${zoneNames[4 - p.dataIndex]}<br><b>${nf(p.value, 1)}%</b> · ${nf(zt[zk[4 - p.dataIndex]] / 60, 1)} h` }),
        xAxis: valAxis({ min: 0, scale: false, axisLabel: { formatter: "{value}%", color: C.faint } }),
        yAxis: catAxis(zoneNames.slice().reverse()),
        series: [{
          type: "bar", barWidth: 18,
          label: { show: true, position: "right", color: C.text, formatter: (p) => `${nf(p.value)}% · ${nf(zt[zk[4 - p.dataIndex]] / 60)} h` },
          data: zk.slice().reverse().map((z, i) => ({ value: (zt[z] / ztotal) * 100, itemStyle: { color: zoneCols[4 - i], borderRadius: 3 } })),
        }],
      });
    } else hideCard("c-football-zones");

    table("t-football-years", ["Year", "Games", "Hours", "Km", "Km / game", "Min / game", "kcal / game", "Avg HR", "Top speed", "Sprints / game"], footballYears(FB));
  }

  function metricVsWeight(A, id, key, color, digits, label) {
    const i0 = firstIdx(A[key] || []);
    if (i0 < 0) return hideCard(id);
    const vals = A[key].slice(i0);
    const roll = vals.map((v, i) => { const w = vals.slice(Math.max(0, i - 1), i + 2).filter(isNum); return w.length >= 2 || isNum(v) ? mean(w) : null; });
    chart(id, {
      grid: grid({ top: 14 }),
      tooltip: tip(),
      xAxis: bucketAxis(A, A.labels.slice(i0)),
      yAxis: [valAxis({ axisLabel: { color: C.muted } }), valAxis({ splitLine: { show: false }, axisLabel: { color: C.faint, formatter: "{value} lb" } })],
      series: [
        { name: label, type: "scatter", data: vals, symbolSize: 5, itemStyle: { color, opacity: 0.55 }, tooltip: { valueFormatter: (v) => nf(v, digits) } },
        { name: `${label} (3-pt avg)`, type: "line", data: roll, connectNulls: true, smooth: 0.3, showSymbol: false, lineStyle: { color, width: 2.5 }, itemStyle: { color }, tooltip: { valueFormatter: (v) => nf(v, digits) } },
        { name: "Weight (lb)", type: "line", yAxisIndex: 1, data: A.weight_lb.slice(i0), smooth: 0.3, showSymbol: false, lineStyle: { color: C.line, width: 1.5, type: "dashed" }, itemStyle: { color: C.line }, tooltip: { valueFormatter: (v) => nf(v) } },
      ],
    });
  }

  function scatterVsWeight(R, A, id, key, label) {
    const phases = phasesIn(R);
    const pts = A.keys.map((k, j) => ({ lab: A.labels[j], w: A.weight_lb[j], v: A[key]?.[j], ph: phaseOf(phases, bucketDate(k)) })).filter((p) => isNum(p.w) && isNum(p.v));
    if (!pts.length) return hideCard(id);
    const fit = A.corr.find((c) => c.metric === key);
    const xs = pts.map((p) => p.w), x0 = Math.min(...xs), x1 = Math.max(...xs);
    const series = phases.map((ph) => ({
      name: ph.label, type: "scatter", symbolSize: 8, itemStyle: { color: PHASE_DOT[ph.key] || C.blue, opacity: 0.8 },
      data: pts.filter((p) => p.ph === ph.key).map((p) => ({ value: [p.w, p.v], lab: p.lab })),
    })).filter((s) => s.data.length);
    if (fit) series.push({ name: `Fit · r ${nf(fit.r, 2)}`, type: "line", showSymbol: false, silent: true, lineStyle: { color: C.text, type: "dashed", width: 1.5 }, itemStyle: { color: C.text }, data: [[x0, fit.intercept + fit.slope * x0], [x1, fit.intercept + fit.slope * x1]] });
    chart(id, {
      legend: legend({ type: "scroll", pageIconColor: C.muted, pageTextStyle: { color: C.faint } }),
      grid: grid({ top: 40 }),
      tooltip: tip({ trigger: "item", formatter: (p) => (p.data?.lab ? `${esc(p.data.lab)}<br>${nf(p.value[0], 1)} lb · ${label} <b>${nf(p.value[1], 1)}</b>` : p.seriesName) }),
      xAxis: valAxis({ name: "lb", nameLocation: "end" }),
      yAxis: valAxis({ name: label }),
      series,
    });
  }

  function renderHeart(R, A) {
    metricVsWeight(A, "c-vo2", "vo2max", C.green, 1, "VO₂ max");
    metricVsWeight(A, "c-rhr", "rhr", C.red, 1, "Resting HR");
    metricVsWeight(A, "c-hrv", "hrv", C.purple, 1, "HRV");
    metricVsWeight(A, "c-walk", "walking_speed_kmh", C.blue, 2, "Walking speed");

    const corr = A.corr.slice().sort((a, b) => Math.abs(a.r) - Math.abs(b.r));
    if (corr.length) {
      chart("c-corr", {
        grid: grid({ top: 6, right: 40 }),
        tooltip: tip({ trigger: "item", formatter: (p) => { const c = corr[p.dataIndex]; return `${esc(c.label)}<br>r <b>${nf(c.r, 2)}</b> · n ${c.n} ${UNITS[A.unit].name}s<br>${signed(c.per_10lb, 2)} / +10 lb`; } }),
        xAxis: valAxis({ min: -1, max: 1, scale: false }),
        yAxis: catAxis(corr.map((c) => c.label), { axisLabel: { color: C.muted, fontSize: 11 } }),
        series: [{
          type: "bar", barWidth: 12, label: { show: true, position: "right", color: C.text, formatter: (p) => nf(p.value, 2) },
          data: corr.map((c) => ({ value: c.r, itemStyle: { color: c.r >= 0 ? C.blue : C.orange, borderRadius: 3 } })),
        }],
      }, Math.max(200, 34 * corr.length + 30));
    } else hideCard("c-corr");
    scatterVsWeight(R, A, "c-scatter-vo2", "vo2max", "VO₂ max");
    scatterVsWeight(R, A, "c-scatter-rhr", "rhr", "RHR");
  }

  function renderActivity(R, A) {
    const si = firstIdx(A.steps);
    if (si < 0) hideCard("c-steps");
    else {
      chart("c-steps", {
        legend: legend(),
        grid: grid(),
        tooltip: tip({ valueFormatter: (v) => nf(v) }),
        xAxis: bucketAxis(A, A.labels.slice(si)),
        yAxis: [valAxis({ name: "steps/day", scale: false }), valAxis({ name: "kcal/day", scale: false, splitLine: { show: false } })],
        series: [
          { name: "Steps / day", type: "bar", data: A.steps.slice(si), itemStyle: { color: C.blue, opacity: 0.75, borderRadius: [2, 2, 0, 0] }, barMaxWidth: 12 },
          { name: "Active kcal / day", type: "line", yAxisIndex: 1, data: A.active_kcal.slice(si), smooth: 0.3, showSymbol: false, connectNulls: true, lineStyle: { color: C.orange, width: 2 }, itemStyle: { color: C.orange } },
        ],
      });
    }

    const W = R.W;
    if (W.length) {
      const mixUnit = R.span > 730 ? "year" : R.unit === "day" ? "week" : R.unit;
      const U = UNITS[mixUnit];
      const keys = [...new Set(W.map((w) => U.key(w.date)))].sort();
      const totals = {};
      for (const w of W) totals[w.category] = (totals[w.category] || 0) + (w.duration_min || 0);
      const cats = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
      chart("c-mix", {
        legend: legend({ type: "scroll", top: "auto", bottom: 0, pageIconColor: C.muted, pageTextStyle: { color: C.faint } }),
        grid: grid({ top: 14, bottom: 34 }),
        tooltip: tip({ valueFormatter: (v) => `${nf(v, 1)} h` }),
        xAxis: catAxis(keys.map(U.label), mixUnit === "week" ? { axisLabel: { ...AX.axisLabel, formatter: (v) => v.replace(/, \d{4}$/, "") } } : {}),
        yAxis: valAxis({ scale: false, axisLabel: { formatter: "{value} h", color: C.muted } }),
        series: cats.map((c) => ({
          name: c, type: "bar", stack: "mix", barMaxWidth: 34, itemStyle: { color: CAT_COLORS[c] || C.line },
          data: keys.map((k) => +(sum(W.filter((w) => w.category === c && U.key(w.date) === k).map((w) => w.duration_min)) / 60).toFixed(1)),
        })),
      });
    } else hideCard("c-mix");

    const ri = firstIdx(A.move_closed_pct);
    if (ri >= 0) {
      chart("c-rings", {
        legend: legend(),
        grid: grid(),
        tooltip: tip({ valueFormatter: (v) => `${nf(v)}%` }),
        xAxis: bucketAxis(A, A.labels.slice(ri)),
        yAxis: valAxis({ min: 0, max: 100, scale: false, axisLabel: { formatter: "{value}%", color: C.muted } }),
        series: [["Move", "move_closed_pct", C.red], ["Exercise", "exercise_closed_pct", C.green], ["Stand", "stand_closed_pct", C.sky]].map(([n, k, col]) => ({
          name: n, type: "line", data: rolling(A[k].slice(ri), 3), smooth: 0.3, showSymbol: false, connectNulls: true, lineStyle: { color: col, width: 2 }, itemStyle: { color: col },
        })),
      });
    } else hideCard("c-rings");

    const recent = W.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.hour || 0) - (a.hour || 0))).slice(0, 15);
    if (!recent.length) return hideCard("t-recent");
    table("t-recent", ["Date", "Type", "Min", "Km", "kcal", "Avg HR", "Max HR", "Load"],
      recent.map((w) => [
        `${fmtDate(w.date)} <span class="pill">${esc(WEEKDAYS[w.weekday] || "")}</span>`,
        `<span class="dot" style="background:${CAT_COLORS[w.category] || C.line}" aria-hidden="true"></span>${esc(w.activity)}`,
        nf(w.duration_min), isNum(w.distance_km) && w.distance_km > 0 ? nf(w.distance_km, 2) : "—",
        w.kcal_est && isNum(w.active_kcal) ? `<span title="HR estimate">~${nf(w.active_kcal)}</span>` : nf(w.active_kcal),
        nf(w.avg_hr), nf(w.max_hr), nf(w.trimp),
      ]));
  }

  function renderLoad(R) {
    const ctl = R.col("ctl");
    if (!ctl.some((v) => v > 1)) return hideSection("load");
    chart("c-load", {
      legend: legend(),
      grid: grid(),
      tooltip: tip({ valueFormatter: (v) => nf(v) }),
      xAxis: timeAxis({ min: R.from, max: R.to }),
      yAxis: valAxis({ name: "TRIMP / day" }),
      series: [
        { name: "Daily load", type: "bar", data: pairs(R.dates, R.col("trimp")).filter((p) => p[1] > 0), itemStyle: { color: "rgba(139,152,165,0.35)" }, barMaxWidth: 6 },
        { name: "Fitness (CTL)", type: "line", data: pairs(R.dates, ctl), showSymbol: false, lineStyle: { color: C.blue, width: 2.5 }, itemStyle: { color: C.blue } },
        { name: "Fatigue (ATL)", type: "line", data: pairs(R.dates, R.col("atl")), showSymbol: false, lineStyle: { color: C.pink, width: 1.2 }, itemStyle: { color: C.pink } },
        { name: "Form (TSB)", type: "line", data: pairs(R.dates, R.col("tsb")), showSymbol: false, lineStyle: { color: C.yellow, width: 1.2, type: "dashed" }, itemStyle: { color: C.yellow } },
      ],
    });
  }

  function renderEnergy(A) {
    const ei = A.tdee_est.findIndex((v, j) => isNum(v) && isNum(A.weight_lb[j]));
    if (ei < 0) return hideSection("energy");
    chart("c-energy", {
      legend: legend(),
      grid: grid({ right: 24 }),
      tooltip: tip({ valueFormatter: (v) => `${nf(v)} kcal/day` }),
      xAxis: bucketAxis(A, A.labels.slice(ei)),
      yAxis: valAxis({ name: "kcal/day" }),
      series: [
        { name: "Expenditure (BMR + active)", type: "line", data: A.tdee_est.slice(ei), smooth: 0.3, showSymbol: false, connectNulls: true, lineStyle: { color: C.orange, width: 2.5 }, itemStyle: { color: C.orange } },
        { name: "Implied intake", type: "line", data: A.implied_intake_kcal.slice(ei), smooth: 0.3, symbolSize: 4, connectNulls: false, lineStyle: { color: C.blue, width: 2 }, itemStyle: { color: C.blue } },
        { name: "BMR (Mifflin)", type: "line", data: A.bmr_est.slice(ei), smooth: 0.3, showSymbol: false, lineStyle: { color: C.line, width: 1.5, type: "dashed" }, itemStyle: { color: C.line } },
      ],
    });
  }

  // Same definitions as healthstats/analysis.py phase_table, clipped to the selected range.
  function phaseStats(p) {
    const d = D.daily, i0 = daysBetween(D.start, p.start), i1 = daysBetween(D.start, p.end) - 1;
    const idx = []; for (let i = Math.max(0, i0); i <= Math.min(d.date.length - 1, i1); i++) idx.push(i);
    const days = daysBetween(p.start, p.end), weeks = Math.max(days / 7, 1);
    const watch = idx.filter((i) => d.active_kcal[i] > 50);
    const wk = D.W.filter((w) => w.date >= p.start && w.date < p.end), fb = wk.filter((w) => w.category === "Football");
    const avg = (col, min) => { const v = idx.map((i) => d[col]?.[i]).filter(isNum); return v.length >= Math.min(min, Math.max(1, Math.floor(days / 3))) ? mean(v) : null; };
    const wl = idx.map((i) => d.weight_lb[i]).filter(isNum);
    return {
      ...p, days,
      steps: mean(watch.map((i) => d.steps[i])), active_kcal: mean(watch.map((i) => d.active_kcal[i])), exercise_min: mean(watch.map((i) => d.exercise_min[i])),
      workouts_per_week: wk.length / weeks, workout_hours_per_week: sum(wk.map((w) => w.duration_min)) / 60 / weeks,
      football_per_month: ((fb.length / weeks) * 52) / 12, football_hours: sum(fb.map((w) => w.duration_min)) / 60,
      rhr: avg("rhr", 30), hrv: avg("hrv", 30), vo2max: avg("vo2max", 5), walking_speed_kmh: avg("walking_speed_kmh", 30), sleep_h: avg("sleep_h", 30),
      weight_start_lb: wl[0] ?? null, weight_end_lb: wl[wl.length - 1] ?? null,
      weight_lb_per_month: wl.length >= 14 ? (wl[wl.length - 1] - wl[0]) / (wl.length / 30.44) : null,
    };
  }

  function renderPhases(R) {
    const P = phasesIn(R).map(phaseStats);
    if (!P.length) return hideSection("phases");
    const rowsDef = [
      ["Dates", (p) => `${fmtDate(p.start)} – ${fmtDate(addDays(p.end, -1))}`],
      ["Days", (p) => nf(p.days)],
      ["Weight", (p) => (isNum(p.weight_start_lb) ? `${nf(p.weight_start_lb)} → ${nf(p.weight_end_lb)} lb` : "—")],
      ["Weight change / month", (p) => (isNum(p.weight_lb_per_month) ? `${signed(p.weight_lb_per_month, 1)} lb` : "—")],
      ["Steps / day", (p) => nf(p.steps)],
      ["Active energy / day", (p) => (isNum(p.active_kcal) ? `${nf(p.active_kcal)} kcal` : "—")],
      ["Exercise minutes / day", (p) => nf(p.exercise_min)],
      ["Workouts / week", (p) => nf(p.workouts_per_week, 1)],
      ["Training hours / week", (p) => nf(p.workout_hours_per_week, 1)],
      ["Football games / month", (p) => nf(p.football_per_month, 1)],
      ["Football hours (total)", (p) => nf(p.football_hours)],
      ["Resting HR", (p) => (isNum(p.rhr) ? `${nf(p.rhr, 1)} bpm` : "—")],
      ["HRV (SDNN)", (p) => (isNum(p.hrv) ? `${nf(p.hrv, 1)} ms` : "—")],
      ["VO₂ max", (p) => nf(p.vo2max, 1)],
      ["Walking speed", (p) => (isNum(p.walking_speed_kmh) ? `${nf(p.walking_speed_kmh, 2)} km/h` : "—")],
      ["Sleep / night", (p) => (isNum(p.sleep_h) ? `${nf(p.sleep_h, 1)} h` : "—")],
    ];
    table("t-phases", ["Metric", ...P.map((p) => p.label)], rowsDef.map(([label, f]) => [esc(label), ...P.map(f)]));
  }

  function renderSleep(A) {
    const idx = A.keys.map((_, j) => j).filter((j) => isNum(A.sleep_h[j]));
    if (idx.length < 3) return hideSection("sleep");
    const a = idx[0], b = idx[idx.length - 1] + 1;
    chart("c-sleep", {
      grid: grid({ top: 14 }),
      tooltip: tip({ valueFormatter: (v) => `${nf(v, 1)} h` }),
      xAxis: bucketAxis(A, A.labels.slice(a, b)),
      yAxis: valAxis({ name: "h", min: (v) => Math.min(4, Math.floor(v.min)), max: (v) => Math.max(9, Math.ceil(v.max)) }),
      series: [{ name: "Sleep", type: "bar", data: A.sleep_h.slice(a, b), barMaxWidth: 12, itemStyle: { color: C.purple, borderRadius: [2, 2, 0, 0] } }],
    });
    chart("c-bedtime", {
      legend: legend(),
      grid: grid(),
      tooltip: tip({ valueFormatter: (v) => clock(v) }),
      xAxis: bucketAxis(A, A.labels.slice(a, b)),
      yAxis: valAxis({ inverse: true, axisLabel: { color: C.muted, formatter: (v) => clock(v) } }),
      series: [
        { name: "Bedtime", type: "line", data: A.bedtime_h.slice(a, b), smooth: 0.3, showSymbol: false, connectNulls: true, lineStyle: { color: C.purple, width: 2 }, itemStyle: { color: C.purple } },
        { name: "Wake", type: "line", data: A.wake_h.slice(a, b), smooth: 0.3, showSymbol: false, connectNulls: true, lineStyle: { color: C.yellow, width: 2 }, itemStyle: { color: C.yellow } },
      ],
    });
  }

  function render(from, to) {
    const R = makeRange(from, to);
    const A = aggregate(R);
    document.querySelectorAll("main section, main .card").forEach((el) => { el.hidden = false; });
    safe("kpis", () => renderKpis(R));
    safe("weight", () => renderWeight(R, A));
    safe("dexa", () => renderDexa(R));
    safe("football", () => renderFootball(R, A));
    safe("heart", () => renderHeart(R, A));
    safe("activity", () => renderActivity(R, A));
    safe("load", () => renderLoad(R));
    safe("energy", () => renderEnergy(A));
    safe("phases", () => renderPhases(R));
    safe("sleep", () => renderSleep(A));
    const anything = $("kpis").children.length || [...document.querySelectorAll("main section")].some((s) => !s.hidden);
    $("empty").hidden = !!anything;
    $("range-status").textContent = `${fmtDate(from)} – ${fmtDate(to)}`;
  }

  // ---------------------------------------------------------------- range controls
  function presetRange(key) {
    let from = D.start;
    if (key === "ytd") from = `${D.end.slice(0, 4)}-01-01`;
    else if (PRESET_MONTHS[key]) from = addDays(addMonths(D.end, -PRESET_MONTHS[key]), 1);
    return { from: maxStr(from, D.start), to: D.end };
  }

  function initRange() {
    const form = $("range"), fromEl = $("from"), toEl = $("to"), err = $("range-error");
    const buttons = [...document.querySelectorAll("[data-preset]")];
    for (const el of [fromEl, toEl]) { el.min = D.start; el.max = D.end; }

    const apply = (from, to, preset) => {
      fromEl.value = from; toEl.value = to;
      document.querySelectorAll(".presets [data-preset]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.preset === preset)));
      const q = new URLSearchParams();
      if (preset && preset !== "all") q.set("range", preset);
      else if (!preset) { q.set("from", from); q.set("to", to); }
      history.replaceState(null, "", `${location.pathname}${q.size ? `?${q}` : ""}${location.hash}`);
      render(from, to);
    };
    const setError = (msg, fields = []) => {
      err.textContent = msg; err.hidden = !msg;
      for (const el of [fromEl, toEl]) el.toggleAttribute("aria-invalid", fields.includes(el));
      for (const el of fields) el.setAttribute("aria-invalid", "true");
    };

    buttons.forEach((b) => b.addEventListener("click", () => {
      setError("");
      const r = presetRange(b.dataset.preset);
      apply(r.from, r.to, b.dataset.preset);
    }));
    form.addEventListener("change", () => {
      let from = fromEl.value, to = toEl.value;
      const missing = [fromEl, toEl].filter((el) => !isIsoDate(el.value));
      if (missing.length) return setError("Invalid date", missing);
      from = maxStr(minStr(from, D.end), D.start); to = maxStr(minStr(to, D.end), D.start);
      if (from > to) return setError("From after To", [fromEl, toEl]);
      setError("");
      const match = Object.keys({ ...PRESET_MONTHS, ytd: 1, all: 1 }).find((k) => { const r = presetRange(k); return r.from === from && r.to === to; });
      apply(from, to, match || null);
    });
    form.addEventListener("submit", (e) => e.preventDefault());

    const q = new URLSearchParams(location.search);
    const preset = q.get("range");
    if (preset && (PRESET_MONTHS[preset] || preset === "ytd")) { const r = presetRange(preset); return apply(r.from, r.to, preset); }
    const f = q.get("from"), t = q.get("to");
    if (isIsoDate(f) && isIsoDate(t) && f <= t) {
    const clamp = (s) => minStr(maxStr(s, D.start), D.end);
    const from = clamp(f), to = clamp(t);
    if (from <= to) return apply(from, to, null);
    }
    const r = presetRange("all");
    apply(r.from, r.to, "all");
  }

  // keep anchor targets clear of the sticky bar, whose height changes as it wraps
  const topbar = $("topbar");
  new ResizeObserver(() => document.documentElement.style.setProperty("--topbar-h", `${topbar.offsetHeight}px`)).observe(topbar);

  // ---------------------------------------------------------------- boot
  $("range").setAttribute("aria-busy", "true");
  load().then((data) => {
    D = data;
    initRange();
  }).catch((e) => {
    console.error(e);
    const el = $("error");
    el.hidden = false;
    el.textContent = `Data unavailable · ${e.message}`;
  }).finally(() => $("range").removeAttribute("aria-busy"));
})();
