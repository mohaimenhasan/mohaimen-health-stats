/* Body Stats — renders site/data/*.json with ECharts. */
(() => {
  "use strict";

  const C = {
    text: "#e6edf3", muted: "#8b98a5", faint: "#5c6773", border: "#1f2833", card: "#11171f", bg: "#0b0f14",
    green: "#3fb950", blue: "#58a6ff", orange: "#f0883e", red: "#f85149", yellow: "#d29922",
    purple: "#bc8cff", teal: "#39c5cf", pink: "#f778ba", sky: "#79c0ff",
  };
  const CAT_COLORS = {
    Football: C.green, Running: C.orange, Walking: C.blue, Strength: C.purple, Hiking: C.teal,
    Cycling: C.yellow, Swimming: C.sky, "Cardio machines": C.pink, "Other sports": "#a5d6ff", Other: C.faint,
  };
  const PHASE_COLORS = { before: "rgba(139,152,165,0.06)", desk: "rgba(248,81,73,0.07)", cut: "rgba(63,185,80,0.08)" };
  const PHASE_DOT = { before: C.faint, desk: C.red, cut: C.green };
  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  // ---------------------------------------------------------------- helpers
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const nf = (v, d = 0) => (isNum(v) ? v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—");
  const signed = (v, d = 0) => (isNum(v) ? (v > 0 ? "+" : v < 0 ? "−" : "") + nf(Math.abs(v), d) : "—");
  const asDate = (s) => new Date(s.length === 7 ? `${s}-15T12:00:00` : `${s}T12:00:00`);
  const fmtDate = (s) => (s ? asDate(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
  const fmtMonth = (s) => (s ? asDate(s.slice(0, 7)).toLocaleDateString("en-US", { month: "short", year: "numeric" }) : "—");
  const clock = (h) => {
    if (!isNum(h)) return "—";
    const m = Math.round((((h % 24) + 24) % 24) * 60);
    return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  const sum = (a) => a.reduce((s, v) => s + (isNum(v) ? v : 0), 0);
  const mean = (a) => { const v = a.filter(isNum); return v.length ? sum(v) / v.length : null; };
  const pairs = (xs, ys, f = (x) => x) => xs.map((x, i) => [f(x), ys[i]]).filter((p) => isNum(p[1]));
  const rolling = (vals, n) => vals.map((_, i) => mean(vals.slice(Math.max(0, i - n + 1), i + 1)));
  const lbToBmi = (lb, cm) => (lb * 0.45359237) / (cm / 100) ** 2;
  const bmiToLb = (bmi, cm) => (bmi * (cm / 100) ** 2) / 0.45359237;

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
  const tip = (o = {}) => ({
    trigger: "axis", confine: true, backgroundColor: "#161b22", borderColor: C.border,
    textStyle: { color: C.text, fontSize: 12 }, axisPointer: { lineStyle: { color: C.faint } }, ...o,
  });
  const legend = (o = {}) => ({ top: 0, textStyle: { color: C.muted }, itemWidth: 14, itemHeight: 8, icon: "roundRect", ...o });
  const grid = (o = {}) => ({ left: 6, right: 10, top: 34, bottom: 6, containLabel: true, ...o });

  const charts = [];
  function chart(id, option, height) {
    const el = $(id);
    if (!el) return null;
    if (height) el.style.height = `${height}px`;
    const c = echarts.init(el, null, { renderer: "canvas" });
    c.setOption({ backgroundColor: "transparent", textStyle: { color: C.muted, fontFamily: FONT }, animationDuration: 500, ...option });
    charts.push(c);
    return c;
  }
  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => charts.forEach((c) => c.resize()), 120); });

  function table(el, headers, rows) {
    $(el).innerHTML = `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }
  function kpi(label, value, unit = "", delta = "", cls = "") {
    if (value === "—") return "";
    return `<div class="card kpi ${cls}"><div class="label">${esc(label)}</div><div class="value">${value}${unit ? `<small>${esc(unit)}</small>` : ""}</div>${delta ? `<div class="delta">${delta}</div>` : ""}</div>`;
  }
  function hideSection(id, msg) {
    const s = $(id);
    if (!s) return;
    s.querySelectorAll(".grid, .card").forEach((n) => n.remove());
    const p = document.createElement("p");
    p.className = "lede";
    p.textContent = msg;
    s.appendChild(p);
  }
  const safe = (name, fn) => { try { fn(); } catch (e) { console.error(`[${name}]`, e); } };

  // ---------------------------------------------------------------- data
  async function load() {
    const names = ["summary", "daily", "monthly", "workouts", "football", "weight", "dexa"];
    const out = {};
    await Promise.all(names.map(async (n) => {
      const r = await fetch(`data/${n}.json`, { cache: "no-cache" });
      if (!r.ok) throw new Error(`data/${n}.json: HTTP ${r.status}`);
      out[n] = await r.json();
    }));
    const wk = out.workouts;
    out.W = wk.rows.map((r) => Object.fromEntries(wk.columns.map((c, i) => [c, r[i]])));
    out.FB = out.W.filter((w) => w.category === "Football");
    return out;
  }

  function phaseOf(phases, date) {
    for (const p of phases) if ((!p.start || date >= p.start) && (!p.end || date < p.end)) return p.key;
    return null;
  }
  function phaseAreas(phases, x = (d) => d) {
    return {
      silent: true,
      data: phases.filter((p) => PHASE_COLORS[p.key]).map((p) => [
        { xAxis: x(p.start), itemStyle: { color: PHASE_COLORS[p.key] }, label: { show: true, position: "insideTop", color: C.faint, fontSize: 11, formatter: p.label } },
        { xAxis: x(p.end) },
      ]),
    };
  }

  // ---------------------------------------------------------------- sections
  function renderHero(D) {
    const S = D.summary, k = S.kpis, p = S.profile || {};
    document.title = p.title || "Body Stats";
    $("title").textContent = p.title || "Body Stats";
    $("tagline").textContent = p.tagline || "";
    $("meta").textContent = `Apple Health since ${fmtDate(S.data_start)} · data through ${fmtDate(S.export_date)} · built ${fmtDate(S.generated_at.slice(0, 10))}`;
    const fb = D.football;
    $("kpis").innerHTML = [
      kpi("Weight now", nf(k.weight_now_lb), "lb", `BMI ${nf(k.bmi_now, 1)} · ${esc(p.height_ftin || "")}`),
      kpi("Down from peak", isNum(k.weight_lost_lb) ? `−${nf(k.weight_lost_lb)}` : "—", "lb", `peak ${nf(k.weight_peak_lb)} lb · ${fmtMonth(k.weight_peak_date)}`, "good"),
      kpi("Body fat", nf(k.body_fat_pct, 1), "%", "DEXA"),
      kpi("Football games", nf(k.football_games), "", `${nf(k.football_hours)} h · ${nf(fb.km)} km`),
      kpi("Workouts", nf(k.workouts), "", `${nf(k.workout_hours)} h total`),
      kpi("VO₂ max", nf(k.vo2max_now, 1), "", "ml/kg/min, latest"),
      kpi("Resting HR", nf(k.rhr_now), "bpm", "last 30 days"),
      kpi("Steps", nf(k.steps_30d), "/day", "last 30 days"),
    ].join("");
    $("insight-cards").innerHTML = (S.insights || []).map((i) => `
      <div class="card insight ${esc(i.tone)}">
        <div class="kicker">${esc(i.kicker)}</div>
        <div class="headline">${esc(i.headline)}</div>
        <p class="body">${esc(i.body)}</p>
      </div>`).join("");
    const c = S.counts || {};
    $("counts").textContent = `${nf(c.apple_samples)} Apple Health samples · ${nf(c.apple_workouts)} Apple workouts + ${nf(c.strava_activities)} Strava activities → ${nf(c.workouts_after_dedupe)} unique workouts. Generated ${S.generated_at.replace("T", " ").replace("+00:00", " UTC")}.`;
  }

  function renderWeight(D) {
    const S = D.summary, Wt = D.weight, d = D.daily, m = D.monthly;
    const h = Wt.height_cm || S.profile.height_cm;
    $("height-label").textContent = `${h} cm`;
    const k = S.kpis;
    $("weight-lede").textContent = `${nf(Wt.log[0]?.weight_lb)} lb in ${fmtMonth(Wt.log[0]?.date)} → peak ${nf(Wt.peak.weight_lb)} lb in ${fmtMonth(Wt.peak.date)} → ${nf(k.weight_now_lb)} lb now.`;

    const line = pairs(d.date, d.weight_lb);
    const logPts = Wt.log.map((r) => [r.date, r.weight_lb]);
    const scale = (Wt.weigh_ins || []).map((r) => [r.date, r.weight_lb]);
    const dexa = (Wt.dexa || []).map((r) => ({ value: [r.date, r.weight_lb], bf: r.body_fat_pct }));
    const all = [...line, ...logPts, ...scale].map((p) => p[1]);
    const lo = Math.floor((Math.min(...all) - 4) / 5) * 5, hi = Math.ceil((Math.max(...all) + 4) / 5) * 5;
    const xs = [...line, ...scale].map((p) => p[0]).sort();
    const phases = S.phases.map((p) => ({ ...p, start: p.start < xs[0] ? xs[0] : p.start }));

    chart("c-weight", {
      legend: legend(),
      grid: grid({ right: 14 }),
      tooltip: tip({ trigger: "item", formatter: (p) => `${fmtDate(p.value[0])}<br><b>${nf(p.value[1], 1)} lb</b> · BMI ${nf(lbToBmi(p.value[1], h), 1)}${p.data?.bf ? `<br>${nf(p.data.bf, 1)}% body fat` : ""}<br><span style="color:${C.muted}">${p.seriesName}</span>` }),
      xAxis: timeAxis(),
      yAxis: [
        valAxis({ min: lo, max: hi, name: "lb", interval: 10 }),
        valAxis({ min: lbToBmi(lo, h), max: lbToBmi(hi, h), name: "BMI", splitLine: { show: false }, axisLabel: { color: C.faint, formatter: (v) => v.toFixed(0), showMinLabel: false, showMaxLabel: false } }),
      ],
      series: [
        {
          name: "Weight", type: "line", data: line, showSymbol: false, smooth: 0.2, lineStyle: { width: 2.5, color: C.blue }, itemStyle: { color: C.blue },
          areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: "rgba(88,166,255,0.25)" }, { offset: 1, color: "rgba(88,166,255,0)" }]) },
          markArea: phaseAreas(phases),
          markLine: {
            silent: true, symbol: "none",
            data: [
              ...[25, 30].filter((b) => bmiToLb(b, h) > lo && bmiToLb(b, h) < hi).map((b) => ({
                yAxis: bmiToLb(b, h), lineStyle: { color: b === 30 ? C.red : C.yellow, type: "dotted", opacity: 0.6 },
                label: { formatter: `BMI ${b}`, color: C.faint, position: "insideStartTop", fontSize: 10 },
              })),
              ...(S.events || []).filter((e) => e.date >= xs[0]).map((e) => ({
                xAxis: e.date, lineStyle: { color: C.faint, type: "dashed" },
                label: { formatter: e.label, color: C.muted, fontSize: 10, position: "insideEndTop" },
              })),
            ],
          },
        },
        { name: "Monthly log", type: "scatter", data: logPts, symbolSize: 5, itemStyle: { color: C.blue, opacity: 0.9 } },
        { name: "Scale", type: "scatter", data: scale, symbolSize: 7, itemStyle: { color: "transparent", borderColor: C.yellow, borderWidth: 1.5 } },
        { name: "DEXA", type: "scatter", data: dexa, symbol: "diamond", symbolSize: 13, itemStyle: { color: C.orange } },
      ],
    });

    const months = m.month, wc = m.weight_change_lb;
    const first = months.findIndex((_, i) => isNum(wc[i]));
    const ms = months.slice(first), wcs = wc.slice(first);
    chart("c-weight-change", {
      grid: grid({ top: 14 }),
      tooltip: tip({ valueFormatter: (v) => `${signed(v, 1)} lb` }),
      xAxis: catAxis(ms.map(fmtMonth)),
      yAxis: valAxis({ name: "lb", scale: false }),
      series: [{
        type: "bar", name: "Change", barMaxWidth: 10,
        data: wcs.map((v) => ({ value: v, itemStyle: { color: v > 0 ? C.red : C.green, borderRadius: v > 0 ? [2, 2, 0, 0] : [0, 0, 2, 2] } })),
      }],
    });

    const hpw = m.workout_min.map((v, i) => (isNum(v) && m.days[i] ? v / 60 / (m.days[i] / 7) : null));
    const fbh = m.min_football.map((v, i) => (isNum(v) && m.days[i] ? v / 60 / (m.days[i] / 7) : null));
    const s0 = Math.max(0, m.weight_lb.findIndex(isNum) - 3);
    chart("c-weight-training", {
      legend: legend(),
      grid: grid(),
      tooltip: tip({ valueFormatter: (v) => nf(v, 1) }),
      xAxis: catAxis(months.slice(s0).map(fmtMonth)),
      yAxis: [valAxis({ name: "h/week", scale: false }), valAxis({ name: "lb", splitLine: { show: false } })],
      series: [
        { name: "Football", type: "bar", stack: "h", data: fbh.slice(s0), itemStyle: { color: C.green }, barMaxWidth: 10 },
        { name: "Other training", type: "bar", stack: "h", data: hpw.slice(s0).map((v, i) => (isNum(v) ? Math.max(0, v - (fbh[s0 + i] || 0)) : null)), itemStyle: { color: C.purple }, barMaxWidth: 10 },
        { name: "Weight", type: "line", yAxisIndex: 1, data: m.weight_lb.slice(s0), showSymbol: false, smooth: 0.3, lineStyle: { color: C.blue, width: 2 }, itemStyle: { color: C.blue } },
      ],
    });
  }

  function renderDexa(D) {
    const scans = D.dexa || [];
    if (!scans.length) return hideSection("composition", "No DEXA scans yet.");
    const X = scans[scans.length - 1];
    const ref = X.reference || {};
    $("dexa-lede").textContent = `${X.provider || "DEXA"} scan on ${fmtDate(X.date)}: ${nf(X.total_lb, 1)} lb total — ${nf(X.lean_lb, 1)} lb lean, ${nf(X.fat_lb, 1)} lb fat (${nf(X.body_fat_pct, 1)}%), ${nf(X.bone_lb, 1)} lb bone. Visceral fat ${nf(X.vat_lb, 2)} lb.${X.rmr?.HTW_FFM ? ` Estimated resting metabolic rate ${nf(X.rmr.HTW_FFM)} kcal/day.` : ""}`;
    $("dexa-ref").textContent = ref.population ? `Vs. ${nf(ref.population)} ${String(ref.gender || "").toLowerCase()}s aged ${ref.min_age}–${ref.max_age}. For fat, a lower percentile means leaner.` : "";

    chart("c-dexa-donut", {
      tooltip: tip({ trigger: "item", formatter: (p) => `${p.name}: <b>${nf(p.value, 1)} lb</b> (${nf(p.percent, 1)}%)` }),
      legend: legend({ top: "bottom" }),
      title: { text: `${nf(X.total_lb, 1)} lb`, subtext: `${nf(X.body_fat_pct, 1)}% fat`, left: "center", top: "38%", textStyle: { color: C.text, fontSize: 22 }, subtextStyle: { color: C.muted } },
      series: [{
        type: "pie", radius: ["52%", "75%"], center: ["50%", "46%"], avoidLabelOverlap: true, label: { show: false },
        itemStyle: { borderColor: C.card, borderWidth: 3, borderRadius: 4 },
        data: [
          { name: "Lean", value: X.lean_lb, itemStyle: { color: C.blue } },
          { name: "Fat", value: X.fat_lb, itemStyle: { color: C.orange } },
          { name: "Bone", value: X.bone_lb, itemStyle: { color: C.faint } },
        ],
      }],
    });

    const R = X.regional || {};
    const pct = [
      ["Body fat %", X.body_fat_pct_percentile, `${nf(X.body_fat_pct, 1)}%`, true],
      ["Visceral fat", X.vat_lb_percentile, `${nf(X.vat_lb, 2)} lb`, true],
      ["Lean mass index", X.lmi_percentile, `${nf(X.lmi, 1)} kg/m²`],
      ["Appendicular lean (ALMI)", X.almi_percentile, `${nf(X.almi, 2)} kg/m²`],
      ["Bone density", X.bmd_percentile, `${nf(X.bmd, 2)} g/cm²`],
      ["Leg lean mass", R.legs?.lean?.percentile, `${nf(R.legs?.lean?.lb, 1)} lb`],
      ["Trunk lean mass", R.trunk?.lean?.percentile, `${nf(R.trunk?.lean?.lb, 1)} lb`],
      ["Arm lean mass", R.arms?.lean?.percentile, `${nf(R.arms?.lean?.lb, 1)} lb`],
    ].filter((r) => isNum(r[1])).reverse();
    chart("c-dexa-pct", {
      grid: grid({ top: 6, right: 34 }),
      tooltip: tip({ trigger: "item", formatter: (p) => `${p.name}: <b>${pct[p.dataIndex][2]}</b><br>${p.value}th percentile${pct[p.dataIndex][3] ? " (lower = leaner)" : ""}` }),
      xAxis: valAxis({ min: 0, max: 100, scale: false, axisLabel: { color: C.faint, formatter: "{value}" } }),
      yAxis: catAxis(pct.map((r) => r[0]), { axisLabel: { color: C.muted, fontSize: 11 } }),
      series: [{
        type: "bar", barWidth: 12, label: { show: true, position: "right", color: C.text, formatter: (p) => `${p.value}` },
        data: pct.map((r) => ({ value: r[1], itemStyle: { borderRadius: 3, color: r[3] ? (r[1] <= 30 ? C.green : r[1] >= 70 ? C.red : C.yellow) : (r[1] >= 70 ? C.green : r[1] <= 30 ? C.orange : C.blue) } })),
        markLine: { silent: true, symbol: "none", data: [{ xAxis: 50 }], lineStyle: { color: C.faint, type: "dashed" }, label: { show: false } },
      }],
    });

    const regions = ["arms", "legs", "trunk", "android", "gynoid", "head"].filter((r) => R[r]);
    const label = (r) => r[0].toUpperCase() + r.slice(1);
    chart("c-dexa-regional", {
      legend: legend(),
      grid: grid(),
      tooltip: tip({ valueFormatter: (v) => `${nf(v, 1)} lb` }),
      xAxis: valAxis({ name: "lb", scale: false }),
      yAxis: catAxis(regions.map(label).reverse()),
      series: [["Lean", "lean", C.blue], ["Fat", "fat", C.orange], ["Bone", "bone", C.faint]].map(([n, k, col]) => ({
        name: n, type: "bar", stack: "r", barWidth: 14, itemStyle: { color: col },
        data: regions.map((r) => R[r]?.[k]?.lb ?? null).reverse(),
      })),
    });

    const sym = X.symmetry || {};
    const rows = Object.entries(sym).map(([reg, s]) => {
      const L = s.left || {}, Rr = s.right || {};
      const diff = isNum(L.lean_lbs) && isNum(Rr.lean_lbs) ? ((Rr.lean_lbs - L.lean_lbs) / ((Rr.lean_lbs + L.lean_lbs) / 2)) * 100 : null;
      return [label(reg), nf(L.lean_lbs, 1), nf(Rr.lean_lbs, 1), `${signed(diff, 1)}%`, nf(L.fat_lbs, 1), nf(Rr.fat_lbs, 1), nf(L.total_lbs, 1), nf(Rr.total_lbs, 1)];
    });
    if (rows.length) table("t-symmetry", ["Region", "Lean L", "Lean R", "R vs L", "Fat L", "Fat R", "Total L", "Total R"], rows);
    else $("t-symmetry").closest(".card").remove();
  }

  function renderFootball(D) {
    const F = D.football, FB = D.FB, m = D.monthly, d = D.daily;
    if (!F || !F.games) return hideSection("football", "No football sessions found.");
    $("football-lede").textContent = `${nf(F.games)} games since ${fmtDate(F.first_date)} — ${nf(F.hours)} hours, ${nf(F.km)} km and ${nf(F.kcal)} active kcal. Average game: ${nf(F.avg_minutes)} min at ${nf(F.avg_hr)} bpm.`;
    const yoy = F.prev_365 ? (F.last_365 / F.prev_365 - 1) * 100 : null;
    $("football-kpis").innerHTML = [
      kpi("Last 12 months", nf(F.last_365), "games", isNum(yoy) ? `${signed(yoy)}% vs. previous 12 (${nf(F.prev_365)})` : ""),
      kpi("Longest streak", nf(F.streak?.longest_weeks), "weeks", `current: ${nf(F.streak?.current_weeks)} weeks`),
      kpi("Busiest month", nf(F.busiest_month?.games), "games", fmtMonth(F.busiest_month?.month)),
      kpi("Busiest week", nf(F.busiest_week?.games), "games", `week of ${fmtDate(F.busiest_week?.week_of)}`),
      kpi("Top speed (median)", nf(F.top_kmh_median, 1), "km/h", `${nf(F.gps_games)} GPS-tracked games`),
      kpi("Sprints / game", nf(F.sprints_per_game, 1), "", `≥ 21 km/h · ${nf(F.hsr_m_per_game)} m high-speed running`),
    ].join("");

    // calendar
    const daysPlayed = pairs(d.date, d.football_min).filter((p) => p[1] > 0);
    const y0 = +F.first_date.slice(0, 4), y1 = +D.summary.export_date.slice(0, 4);
    const years = []; for (let y = y1; y >= y0; y--) years.push(y);
    const cellH = 13, perYear = cellH * 7 + 44;
    chart("c-football-cal", {
      tooltip: { formatter: (p) => `${fmtDate(p.value[0])}<br><b>${nf(p.value[1])} min</b> of football`, backgroundColor: "#161b22", borderColor: C.border, textStyle: { color: C.text, fontSize: 12 } },
      visualMap: { show: false, min: 0, max: 150, inRange: { color: ["#0e4429", "#006d32", "#26a641", "#39d353"] } },
      calendar: years.map((y, i) => ({
        range: String(y), top: 28 + i * perYear, left: 46, right: 8, cellSize: ["auto", cellH],
        itemStyle: { color: "#161b22", borderColor: C.card, borderWidth: 2 }, splitLine: { show: false },
        yearLabel: { show: true, position: "left", color: C.muted, fontSize: 13, margin: 30 },
        monthLabel: { color: C.faint, fontSize: 10, nameMap: "en" }, dayLabel: { firstDay: 1, nameMap: ["S", "M", "T", "W", "T", "F", "S"], color: C.faint, fontSize: 9 },
      })),
      series: years.map((y, i) => ({ type: "heatmap", coordinateSystem: "calendar", calendarIndex: i, data: daysPlayed.filter((p) => p[0].startsWith(String(y))) })),
    }, 28 + years.length * perYear - 18);

    // monthly
    const firstM = F.first_date.slice(0, 7);
    const mi = m.month.findIndex((x) => x >= firstM);
    chart("c-football-monthly", {
      legend: legend(),
      grid: grid(),
      tooltip: tip(),
      xAxis: catAxis(m.month.slice(mi).map(fmtMonth)),
      yAxis: [valAxis({ name: "games", scale: false, minInterval: 1 }), valAxis({ name: "km", scale: false, splitLine: { show: false } })],
      series: [
        { name: "Games", type: "bar", data: m.football_games.slice(mi), itemStyle: { color: C.green, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 14 },
        { name: "Distance (km)", type: "line", yAxisIndex: 1, data: m.football_km.slice(mi).map((v) => (isNum(v) ? +v.toFixed(1) : v)), showSymbol: false, smooth: 0.3, lineStyle: { color: C.blue, width: 1.5 }, itemStyle: { color: C.blue } },
      ],
    });

    // distance per game
    const dist = FB.filter((g) => isNum(g.distance_km) && g.distance_km > 0.3);
    const roll = rolling(dist.map((g) => g.distance_km), 15);
    chart("c-football-dist", {
      grid: grid({ top: 14 }),
      tooltip: tip({ trigger: "item", formatter: (p) => `${fmtDate(p.value[0])}<br><b>${nf(p.value[1], 2)} km</b>${p.seriesName === "Game" ? ` · ${nf(dist[p.dataIndex].duration_min)} min` : " (15-game avg)"}` }),
      xAxis: timeAxis(),
      yAxis: valAxis({ name: "km", scale: false }),
      series: [
        { name: "Game", type: "scatter", data: dist.map((g) => [g.date, g.distance_km]), symbolSize: 5, itemStyle: { color: C.green, opacity: 0.45 } },
        { name: "Rolling", type: "line", data: dist.map((g, i) => [g.date, roll[i]]), showSymbol: false, lineStyle: { color: C.text, width: 2 }, itemStyle: { color: C.text } },
      ],
    });

    // speed & sprints
    const gps = FB.filter((g) => isNum(g.top_kmh));
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
    } else $("c-football-speed").closest(".card").remove();

    // weekday x hour
    const heat = F.weekday_hour || [];
    const hours = []; heat.forEach((row) => row.forEach((v, h) => { if (v > 0) hours.push(h); }));
    const h0 = Math.max(0, Math.min(...hours) - 1), h1 = Math.min(23, Math.max(...hours) + 1);
    const hrs = []; for (let hh = h0; hh <= h1; hh++) hrs.push(hh);
    const hdata = []; let hmax = 1;
    heat.forEach((row, wd) => hrs.forEach((hh, j) => { hdata.push([j, wd, row[hh] || 0]); hmax = Math.max(hmax, row[hh] || 0); }));
    chart("c-football-when", {
      grid: grid({ top: 10, bottom: 10 }),
      tooltip: { formatter: (p) => `${WEEKDAYS[p.value[1]]} ${clock(hrs[p.value[0]])}–${clock(hrs[p.value[0]] + 1)}<br><b>${p.value[2]} games</b>`, backgroundColor: "#161b22", borderColor: C.border, textStyle: { color: C.text, fontSize: 12 } },
      xAxis: catAxis(hrs.map((x) => (x === 0 ? "12a" : x < 12 ? `${x}a` : x === 12 ? "12p" : `${x - 12}p`)), { axisLabel: { color: C.muted, fontSize: 10 } }),
      yAxis: catAxis(WEEKDAYS, { inverse: true }),
      visualMap: { show: false, min: 0, max: hmax, inRange: { color: ["#161b22", "#0e4429", "#26a641", "#39d353"] } },
      series: [{ type: "heatmap", data: hdata, itemStyle: { borderColor: C.card, borderWidth: 2, borderRadius: 3 } }],
    });

    // zones per year (share of dense-HR time)
    const Y = F.per_year || {};
    const yrs = Object.keys(Y).sort();
    const zoneNames = ["Z1 easy", "Z2 aerobic", "Z3 tempo", "Z4 threshold", "Z5 max"];
    const zoneCols = [C.faint, C.blue, C.green, C.orange, C.red];
    const zt = F.zones_total_min || {};
    const ztotal = sum(["z1", "z2", "z3", "z4", "z5"].map((z) => zt[z]));
    $("zones-note").textContent = ztotal ? `Time in each heart-rate zone, from games with dense heart-rate sampling (${nf(ztotal / 60)} h). Zones are % of max HR ${nf(D.summary.hr?.max_est)} bpm.` : "";
    const zk = ["z1", "z2", "z3", "z4", "z5"];
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
    } else $("c-football-zones").closest(".card").remove();

    table("t-football-years", ["Year", "Games", "Hours", "Km", "Km / game", "Min / game", "kcal / game", "Avg HR", "Top speed", "Sprints / game"],
      yrs.map((y) => { const r = Y[y]; return [y, nf(r.games), nf(r.hours), nf(r.km), nf(r.km_per_game, 1), nf(r.avg_min), nf(r.kcal_per_game), nf(r.avg_hr), isNum(r.top_kmh_median) ? `${nf(r.top_kmh_median, 1)} km/h` : "—", nf(r.sprints_per_game, 1)]; }));

    const R = F.records || {};
    const rec = [
      ["Longest game", R.longest, (v) => `${nf(v)} min`],
      ["Farthest", R.farthest, (v) => `${nf(v, 1)} km`],
      ["Most energy", R.most_kcal, (v) => `${nf(v)} kcal`],
      ["Highest avg HR", R.highest_avg_hr, (v) => `${nf(v)} bpm`],
      ["Top speed", R.top_speed, (v) => `${nf(v, 1)} km/h`],
      ["Most sprints", R.most_sprints, (v) => nf(v)],
      ["Biggest training load", R.biggest_load, (v) => `${nf(v)} TRIMP`],
    ].filter((r) => r[1]);
    $("football-records").innerHTML = rec.map(([w, r, f]) => `<li><span class="what">${esc(w)}</span><span class="val">${f(r.value)}<span class="when">${fmtDate(r.date)}</span></span></li>`).join("");

    const hr = FB.filter((g) => isNum(g.avg_hr));
    const hroll = rolling(hr.map((g) => g.avg_hr), 15);
    chart("c-football-hr", {
      grid: grid({ top: 14 }),
      tooltip: tip({ trigger: "item", formatter: (p) => `${fmtDate(p.value[0])}<br><b>${nf(p.value[1])} bpm</b>${p.seriesName === "Rolling" ? " (15-game avg)" : ""}` }),
      xAxis: timeAxis(),
      yAxis: valAxis({ name: "bpm" }),
      series: [
        { name: "Game", type: "scatter", data: hr.map((g) => [g.date, g.avg_hr]), symbolSize: 5, itemStyle: { color: C.red, opacity: 0.4 } },
        { name: "Rolling", type: "line", data: hr.map((g, i) => [g.date, hroll[i]]), showSymbol: false, lineStyle: { color: C.text, width: 2 }, itemStyle: { color: C.text } },
      ],
    });
  }

  function metricVsWeight(D, id, key, color, digits, unit) {
    const m = D.monthly;
    const i0 = m[key].findIndex(isNum);
    if (i0 < 0) return $(id)?.closest(".card")?.remove();
    const months = m.month.slice(i0);
    const vals = m[key].slice(i0);
    const roll = vals.map((v, i) => { const w = vals.slice(Math.max(0, i - 1), i + 2).filter(isNum); return w.length >= 2 || isNum(v) ? mean(w) : null; });
    chart(id, {
      grid: grid({ top: 14 }),
      tooltip: tip(),
      xAxis: catAxis(months.map(fmtMonth)),
      yAxis: [valAxis({ axisLabel: { color: C.muted } }), valAxis({ splitLine: { show: false }, axisLabel: { color: C.faint, formatter: "{value} lb" } })],
      series: [
        { name: unit, type: "scatter", data: vals, symbolSize: 5, itemStyle: { color, opacity: 0.55 }, tooltip: { valueFormatter: (v) => nf(v, digits) } },
        { name: `${unit} (3-mo avg)`, type: "line", data: roll, connectNulls: true, smooth: 0.3, showSymbol: false, lineStyle: { color, width: 2.5 }, itemStyle: { color }, tooltip: { valueFormatter: (v) => nf(v, digits) } },
        { name: "Weight (lb)", type: "line", yAxisIndex: 1, data: m.weight_lb.slice(i0), smooth: 0.3, showSymbol: false, lineStyle: { color: C.faint, width: 1.5, type: "dashed" }, itemStyle: { color: C.faint }, tooltip: { valueFormatter: (v) => nf(v) } },
      ],
    });
  }

    function scatterVsWeight(D, id, key, color, label) {
    const m = D.monthly, S = D.summary;
    const pts = m.month.map((mo, i) => ({ mo, w: m.weight_lb[i], v: m[key][i], ph: phaseOf(S.phases, `${mo}-15`) })).filter((p) => isNum(p.w) && isNum(p.v));
    if (!pts.length) return $(id)?.closest(".card")?.remove();
    const corr = (S.correlations || []).find((c) => c.metric === key);
    const xs = pts.map((p) => p.w), x0 = Math.min(...xs), x1 = Math.max(...xs);
    const series = S.phases.map((ph) => ({
      name: ph.label, type: "scatter", symbolSize: 8, itemStyle: { color: PHASE_DOT[ph.key] || C.blue, opacity: 0.8 },
      data: pts.filter((p) => p.ph === ph.key).map((p) => ({ value: [p.w, p.v], mo: p.mo })),
    })).filter((s) => s.data.length);
    if (corr) series.push({ name: `fit (r = ${nf(corr.r, 2)})`, type: "line", showSymbol: false, silent: true, lineStyle: { color: C.text, type: "dashed", width: 1.5 }, itemStyle: { color: C.text }, data: [[x0, corr.intercept + corr.slope * x0], [x1, corr.intercept + corr.slope * x1]] });
    chart(id, {
      legend: legend({ type: "scroll" }),
      grid: grid({ top: 40 }),
      tooltip: tip({ trigger: "item", formatter: (p) => p.data?.mo ? `${fmtMonth(p.data.mo)}<br>${nf(p.value[0], 1)} lb · ${label} <b>${nf(p.value[1], 1)}</b>` : p.seriesName }),
      xAxis: valAxis({ name: "lb", nameLocation: "end" }),
      yAxis: valAxis({ name: label }),
      series,
    });
  }

  function renderHeart(D) {
    metricVsWeight(D, "c-vo2", "vo2max", C.green, 1, "VO₂ max");
    metricVsWeight(D, "c-rhr", "rhr", C.red, 1, "Resting HR");
    metricVsWeight(D, "c-hrv", "hrv", C.purple, 1, "HRV");
    metricVsWeight(D, "c-walk", "walking_speed_kmh", C.blue, 2, "Walking speed");

    const corr = (D.summary.correlations || []).slice().sort((a, b) => Math.abs(a.r) - Math.abs(b.r));
    if (corr.length) {
      chart("c-corr", {
        grid: grid({ top: 6, right: 40 }),
        tooltip: tip({ trigger: "item", formatter: (p) => { const c = corr[p.dataIndex]; return `${esc(c.label)}<br>r = <b>${nf(c.r, 2)}</b> over ${c.n} months<br>${signed(c.per_10lb, 2)} per +10 lb`; } }),
        xAxis: valAxis({ min: -1, max: 1, scale: false }),
        yAxis: catAxis(corr.map((c) => c.label), { axisLabel: { color: C.muted, fontSize: 11 } }),
        series: [{
          type: "bar", barWidth: 12, label: { show: true, position: "right", color: C.text, formatter: (p) => nf(p.value, 2) },
          data: corr.map((c) => ({ value: c.r, itemStyle: { color: c.r >= 0 ? C.blue : C.orange, borderRadius: 3 } })),
        }],
      }, Math.max(200, 34 * corr.length + 30));
    }
    scatterVsWeight(D, "c-scatter-vo2", "vo2max", C.green, "VO₂ max");
    scatterVsWeight(D, "c-scatter-rhr", "rhr", C.red, "RHR");
  }

  function renderActivity(D) {
    const m = D.monthly, W = D.W;
    const i0 = m.steps.findIndex(isNum);
    chart("c-steps", {
      legend: legend(),
      grid: grid(),
      tooltip: tip({ valueFormatter: (v) => nf(v) }),
      xAxis: catAxis(m.month.slice(i0).map(fmtMonth)),
      yAxis: [valAxis({ name: "steps/day", scale: false }), valAxis({ name: "kcal/day", scale: false, splitLine: { show: false } })],
      series: [
        { name: "Steps / day", type: "bar", data: m.steps.slice(i0), itemStyle: { color: C.blue, opacity: 0.75, borderRadius: [2, 2, 0, 0] }, barMaxWidth: 12 },
        { name: "Active kcal / day", type: "line", yAxisIndex: 1, data: m.active_kcal.slice(i0), smooth: 0.3, showSymbol: false, connectNulls: true, lineStyle: { color: C.orange, width: 2 }, itemStyle: { color: C.orange } },
      ],
    });

    const years = [...new Set(W.map((w) => w.date.slice(0, 4)))].sort();
    const cats = Object.entries(W.reduce((a, w) => ((a[w.category] = (a[w.category] || 0) + (w.duration_min || 0)), a), {})).sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    chart("c-mix", {
      legend: legend({ type: "scroll", top: "auto", bottom: 0, pageIconColor: C.muted, pageTextStyle: { color: C.faint } }),
      grid: grid({ top: 14, bottom: 34 }),
      tooltip: tip({ valueFormatter: (v) => `${nf(v)} h` }),
      xAxis: catAxis(years),
      yAxis: valAxis({ scale: false, axisLabel: { formatter: "{value} h", color: C.muted } }),
      series: cats.map((c) => ({
        name: c, type: "bar", stack: "mix", barMaxWidth: 34, itemStyle: { color: CAT_COLORS[c] || C.faint },
        data: years.map((y) => +(sum(W.filter((w) => w.category === c && w.date.startsWith(y)).map((w) => w.duration_min)) / 60).toFixed(1)),
      })),
    });

    const r0 = m.move_closed_pct.findIndex(isNum);
    if (r0 >= 0) {
      chart("c-rings", {
        legend: legend(),
        grid: grid(),
        tooltip: tip({ valueFormatter: (v) => `${nf(v)}%` }),
        xAxis: catAxis(m.month.slice(r0).map(fmtMonth)),
        yAxis: valAxis({ min: 0, max: 100, scale: false, axisLabel: { formatter: "{value}%", color: C.muted } }),
        series: [["Move", "move_closed_pct", C.red], ["Exercise", "exercise_closed_pct", C.green], ["Stand", "stand_closed_pct", C.sky]].map(([n, k, col]) => ({
          name: n, type: "line", data: rolling(m[k].slice(r0), 3), smooth: 0.3, showSymbol: false, connectNulls: true, lineStyle: { color: col, width: 2 }, itemStyle: { color: col },
        })),
      });
    } else $("c-rings").closest(".card").remove();

    const recent = W.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.hour || 0) - (a.hour || 0))).slice(0, 15);
    table("t-recent", ["Date", "Type", "Min", "Km", "kcal", "Avg HR", "Max HR", "Load"],
      recent.map((w) => [
        `${fmtDate(w.date)} <span class="pill">${esc(WEEKDAYS[w.weekday] || "")}</span>`,
        `<span class="dot" style="background:${CAT_COLORS[w.category] || C.faint}"></span>${esc(w.activity)}`,
        nf(w.duration_min), isNum(w.distance_km) && w.distance_km > 0 ? nf(w.distance_km, 2) : "—", w.kcal_est && isNum(w.active_kcal) ? `<span title="estimated from heart rate">~${nf(w.active_kcal)}</span>` : nf(w.active_kcal), nf(w.avg_hr), nf(w.max_hr), nf(w.trimp),
      ]));
  }

  function renderLoad(D) {
    const d = D.daily;
    const start = d.date.findIndex((_, i) => isNum(d.ctl[i]) && d.ctl[i] > 1);
    if (start < 0) return hideSection("load", "Not enough heart-rate data for a training-load model.");
    const dates = d.date.slice(start);
    const n = dates.length;
    const zoomStart = Math.max(0, 100 - (730 / n) * 100);
    chart("c-load", {
      legend: legend(),
      grid: grid({ bottom: 50 }),
      tooltip: tip({ valueFormatter: (v) => nf(v) }),
      xAxis: timeAxis(),
      yAxis: valAxis({ name: "TRIMP / day" }),
      dataZoom: [
        { type: "slider", start: zoomStart, end: 100, height: 22, bottom: 8, borderColor: C.border, textStyle: { color: C.faint }, fillerColor: "rgba(88,166,255,0.12)", dataBackground: { lineStyle: { color: C.faint }, areaStyle: { color: "rgba(139,152,165,0.15)" } } },
        { type: "inside", start: zoomStart, end: 100, zoomOnMouseWheel: false, moveOnMouseWheel: false },
      ],
      series: [
        { name: "Daily load", type: "bar", data: pairs(dates, d.trimp.slice(start)).filter((p) => p[1] > 0), itemStyle: { color: "rgba(139,152,165,0.35)" }, barMaxWidth: 4 },
        { name: "Fitness (CTL)", type: "line", data: pairs(dates, d.ctl.slice(start)), showSymbol: false, lineStyle: { color: C.blue, width: 2.5 }, itemStyle: { color: C.blue }, areaStyle: { color: "rgba(88,166,255,0.08)" } },
        { name: "Fatigue (ATL)", type: "line", data: pairs(dates, d.atl.slice(start)), showSymbol: false, lineStyle: { color: C.pink, width: 1.2 }, itemStyle: { color: C.pink } },
        { name: "Form (TSB)", type: "line", data: pairs(dates, d.tsb.slice(start)), showSymbol: false, lineStyle: { color: C.yellow, width: 1.2, type: "dashed" }, itemStyle: { color: C.yellow } },
      ],
    });
  }

  function renderEnergy(D) {
    const m = D.monthly;
    const i0 = m.tdee_est.findIndex((v, i) => isNum(v) && isNum(m.weight_lb[i]));
    if (i0 < 0) return hideSection("energy", "Not enough data.");
    const months = m.month.slice(i0);
    chart("c-energy", {
      legend: legend(),
      grid: grid({ right: 24 }),
      tooltip: tip({ valueFormatter: (v) => `${nf(v)} kcal/day` }),
      xAxis: catAxis(months.map(fmtMonth)),
      yAxis: valAxis({ name: "kcal/day" }),
      series: [
        { name: "Expenditure (BMR + active)", type: "line", data: m.tdee_est.slice(i0), smooth: 0.3, showSymbol: false, connectNulls: true, lineStyle: { color: C.orange, width: 2.5 }, itemStyle: { color: C.orange } },
        { name: "Implied intake", type: "line", data: m.implied_intake_kcal.slice(i0), smooth: 0.3, symbolSize: 4, connectNulls: false, lineStyle: { color: C.blue, width: 2 }, itemStyle: { color: C.blue } },
        { name: "BMR (Mifflin)", type: "line", data: m.bmr_est.slice(i0), smooth: 0.3, showSymbol: false, lineStyle: { color: C.faint, width: 1.5, type: "dashed" }, itemStyle: { color: C.faint } },
      ],
    });
  }

  function renderPhases(D) {
    const P = D.summary.phases || [];
    if (!P.length) return;
    const rowsDef = [
      ["Period", (p) => `${fmtMonth(p.start)} – ${p.end > D.summary.export_date ? "now" : fmtMonth(p.end)}`],
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
    table("t-phases", ["", ...P.map((p) => p.label)], rowsDef.map(([label, f]) => [esc(label), ...P.map(f)]));
  }

  function renderSleep(D) {
    const m = D.monthly;
    const idx = m.month.map((_, i) => i).filter((i) => isNum(m.sleep_h[i]));
    if (idx.length < 3) return hideSection("sleep", "Not enough sleep data.");
    const a = idx[0], b = idx[idx.length - 1];
    const months = m.month.slice(a, b + 1);
    $("sleep-lede").textContent = `Sleep data covers ${fmtMonth(m.month[a])} – ${fmtMonth(m.month[b])}, mostly from iPhone bedtime ("in bed") tracking; later months don't have enough nights recorded. Average ${nf(mean(idx.map((i) => m.sleep_h[i])), 1)} h per night.`;
    chart("c-sleep", {
      grid: grid({ top: 14 }),
      tooltip: tip({ valueFormatter: (v) => `${nf(v, 1)} h` }),
      xAxis: catAxis(months.map(fmtMonth)),
      yAxis: valAxis({ name: "h", min: 4, max: 9 }),
      series: [{
        name: "Sleep", type: "bar", data: m.sleep_h.slice(a, b + 1), barMaxWidth: 12,
        itemStyle: { color: C.purple, borderRadius: [2, 2, 0, 0] },
        markLine: { silent: true, symbol: "none", data: [{ yAxis: 7 }], lineStyle: { color: C.faint, type: "dashed" }, label: { formatter: "7 h", color: C.faint } },
      }],
    });
    chart("c-bedtime", {
      legend: legend(),
      grid: grid(),
      tooltip: tip({ valueFormatter: (v) => clock(v) }),
      xAxis: catAxis(months.map(fmtMonth)),
      yAxis: valAxis({ inverse: true, axisLabel: { color: C.muted, formatter: (v) => clock(v) } }),
      series: [
        { name: "Bedtime", type: "line", data: m.bedtime_h.slice(a, b + 1), smooth: 0.3, showSymbol: false, connectNulls: true, lineStyle: { color: C.purple, width: 2 }, itemStyle: { color: C.purple } },
        { name: "Wake", type: "line", data: m.wake_h.slice(a, b + 1), smooth: 0.3, showSymbol: false, connectNulls: true, lineStyle: { color: C.yellow, width: 2 }, itemStyle: { color: C.yellow } },
      ],
    });
  }

  // ---------------------------------------------------------------- boot
  load().then((D) => {
    safe("hero", () => renderHero(D));
    safe("weight", () => renderWeight(D));
    safe("dexa", () => renderDexa(D));
    safe("football", () => renderFootball(D));
    safe("heart", () => renderHeart(D));
    safe("activity", () => renderActivity(D));
    safe("load", () => renderLoad(D));
    safe("energy", () => renderEnergy(D));
    safe("phases", () => renderPhases(D));
    safe("sleep", () => renderSleep(D));
  }).catch((e) => {
    console.error(e);
    const el = $("error");
    el.style.display = "block";
    el.textContent = `Couldn't load data: ${e.message}`;
  });
})();
