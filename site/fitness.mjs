export function sportLabel(name) {
  if (name === "Football") return "Soccer";
  return name.replace(/([a-z])([A-Z])/g, "$1 $2");
}

const slug = (name) => sportLabel(name).toLowerCase().replace(/[^a-z0-9]+/g, "-");

export function sportOptions(workouts) {
  const categories = new Map();
  for (const w of workouts) {
    if (!categories.has(w.category)) categories.set(w.category, new Set());
    categories.get(w.category).add(w.activity);
  }
  const options = [{ value: "all", label: "All sports" }];
  for (const category of [...categories.keys()].sort((a, b) => sportLabel(a).localeCompare(sportLabel(b)))) {
    const activities = [...categories.get(category)].sort();
    if (activities.length === 1) {
      options.push({ value: slug(activities[0]), label: sportLabel(activities[0]), category });
    } else {
      const group = sportLabel(category);
      options.push({ value: `all-${slug(category)}`, label: `All ${group.toLowerCase()}`, category, group });
      for (const activity of activities) {
        options.push({ value: slug(activity), label: sportLabel(activity), activity, group });
      }
    }
  }
  return options;
}

export function selectWorkouts(workouts, selection) {
  return workouts.filter((w) => selection.activity ? w.activity === selection.activity
    : selection.category ? w.category === selection.category : true);
}

export function trainingLoad(workouts, dates) {
  const index = new Map(dates.map((date, i) => [date, i]));
  const trimp = dates.map(() => 0);
  for (const w of workouts) {
    const i = index.get(w.date);
    if (i !== undefined && Number.isFinite(w.trimp)) trimp[i] += w.trimp;
  }
  // Same initial value and exponential decay as analysis.training_load.
  const ewma = (days) => {
    const alpha = 1 - Math.exp(-1 / days);
    let previous = trimp[0] ?? 0;
    return trimp.map((value) => (previous += alpha * (value - previous)));
  };
  const ctl = ewma(42), atl = ewma(7);
  return { trimp, ctl, atl, tsb: ctl.map((value, i) => value - atl[i]) };
}

const DAY = 86400000;
const stamp = (date) => Date.parse(`${date}T00:00:00Z`);
const dateString = (time) => new Date(time).toISOString().slice(0, 10);
const monday = (date) => stamp(date) - ((new Date(stamp(date)).getUTCDay() + 6) % 7) * DAY;
const total = (values) => values.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);

export function trainingSummary(workouts, from, to) {
  const weeks = new Map();
  for (let time = monday(from); time <= stamp(to); time += 7 * DAY) {
    weeks.set(dateString(time), { date: dateString(time), sessions: 0, minutes: 0 });
  }
  const selected = workouts.filter((w) => w.date >= from && w.date <= to);
  for (const w of selected) {
    const week = weeks.get(dateString(monday(w.date)));
    week.sessions += 1;
    week.minutes += Number.isFinite(w.duration_min) ? w.duration_min : 0;
  }
  let streak = 0, longestStreak = 0;
  const rows = [...weeks.values()];
  for (const week of rows) {
    streak = week.sessions ? streak + 1 : 0;
    longestStreak = Math.max(longestStreak, streak);
  }
  const activeWeeks = rows.filter((w) => w.sessions > 0).length;
  const elapsedWeeks = ((stamp(to) - stamp(from)) / DAY + 1) / 7;
  const zones = ["z1", "z2", "z3", "z4", "z5"].map((key) => total(selected.map((w) => w[key])));
  const zoneMinutes = total(zones);
  return {
    weeks: rows, activeWeeks, longestStreak,
    sessions: selected.length,
    hours: total(selected.map((w) => w.duration_min)) / 60,
    sessionsPerWeek: selected.length / elapsedWeeks,
    hoursPerWeek: total(selected.map((w) => w.duration_min)) / 60 / elapsedWeeks,
    activeWeekPct: activeWeeks / rows.length * 100,
    highIntensityPct: zoneMinutes ? (zones[3] + zones[4]) / zoneMinutes * 100 : null,
    zoneMinutes,
  };
}

export function recoveryPairs(workouts, daily, from, to) {
  const loads = new Map();
  for (const w of workouts) {
    if (Number.isFinite(w.trimp)) loads.set(w.date, (loads.get(w.date) || 0) + w.trimp);
  }
  const pairs = [];
  for (let i = 0; i < daily.date.length - 1; i++) {
    const date = daily.date[i], next = daily.date[i + 1], rhr = daily.rhr?.[i + 1];
    const load = loads.get(date);
    if (date < from || next > to || !(load > 0) || !Number.isFinite(rhr)) continue;
    const previous = daily.rhr.slice(Math.max(0, i - 27), i + 1).filter(Number.isFinite);
    if (previous.length < 7) continue;
    const baseline = total(previous) / previous.length;
    pairs.push({ date, next, load, rhr, baseline, delta: rhr - baseline });
  }
  return pairs;
}

export function linearFit(points, minSamples = 8) {
  if (points.length < minSamples) return null;
  const mx = total(points.map((p) => p[0])) / points.length;
  const my = total(points.map((p) => p[1])) / points.length;
  let xx = 0, xy = 0, yy = 0;
  for (const [x, y] of points) {
    xx += (x - mx) ** 2;
    xy += (x - mx) * (y - my);
    yy += (y - my) ** 2;
  }
  if (!xx || !yy) return null;
  const slope = xy / xx;
  return { n: points.length, r: xy / Math.sqrt(xx * yy), slope, intercept: my - slope * mx };
}
