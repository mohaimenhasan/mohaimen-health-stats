import assert from "node:assert/strict";
import test from "node:test";
import { sportOptions, selectWorkouts, trainingLoad, trainingSummary, recoveryPairs, linearFit } from "../site/fitness.mjs";

const workouts = [
  { category: "Football", activity: "Soccer", date: "2024-01-01", trimp: 100 },
  { category: "Running", activity: "Running", date: "2024-01-01", trimp: 40 },
  { category: "Football", activity: "Soccer", date: "2024-01-03", trimp: 50 },
  { category: "Strength", activity: "FunctionalStrengthTraining", date: "2024-01-02", trimp: 20 },
  { category: "Strength", activity: "TraditionalStrengthTraining", date: "2024-01-03", trimp: null },
  { category: "Other sports", activity: "Tennis", date: "2024-01-03", trimp: 10 },
  { category: "Other sports", activity: "Basketball", date: "2024-01-02", trimp: 30 },
];

test("sport choices filter individual sports and grouped activity types", () => {
  const options = sportOptions(workouts);
  const selected = (key) => selectWorkouts(workouts, options.find((s) => s.value === key));
  assert.equal(new Set(options.map((s) => s.value)).size, options.length);
  assert.deepEqual(selected("all"), workouts);
  assert.deepEqual(selected("soccer"), [workouts[0], workouts[2]]);
  assert.deepEqual(selected("all-strength"), [workouts[3], workouts[4]]);
  assert.deepEqual(selected("functional-strength-training"), [workouts[3]]);
  assert.deepEqual(selected("tennis"), [workouts[5]]);
  assert.deepEqual(selected("all-other-sports"), [workouts[5], workouts[6]]);
});

test("sport load preserves pre-range history and includes days without sessions", () => {
  const dates = ["2024-01-01", "2024-01-02", "2024-01-03"];
  const soccer = selectWorkouts(workouts, sportOptions(workouts).find((s) => s.value === "soccer"));
  const load = trainingLoad(soccer, dates);
  assert.deepEqual(load.trimp, [100, 0, 50]);
  assert.equal(load.ctl[0], 100);
  assert.ok(Math.abs(load.ctl[1] - 100 * Math.exp(-1 / 42)) < 1e-10);
  assert.ok(Math.abs(load.atl[1] - 100 * Math.exp(-1 / 7)) < 1e-10);
  assert.equal(load.tsb[2], load.ctl[2] - load.atl[2]);
  const clipped = load.ctl.slice(1);
  assert.ok(clipped[0] > 0);
  assert.notDeepEqual(clipped, trainingLoad(soccer, dates.slice(1)).ctl);
});

test("load sums same-day sessions and excludes missing or out-of-timeline readings", () => {
  const load = trainingLoad([...workouts, { date: "2023-12-31", trimp: 999 }], ["2024-01-01", "2024-01-02", "2024-01-03"]);
  assert.deepEqual(load.trimp, [140, 50, 60]);
  assert.deepEqual(trainingLoad([], []), { trimp: [], ctl: [], atl: [], tsb: [] });
});

test("training consistency includes inactive weeks and normalizes partial-week rates", () => {
  const sessions = [
    { date: "2024-01-01", duration_min: 60, z1: 20, z4: 10 },
    { date: "2024-01-08", duration_min: 60, z2: 20, z5: 10 },
    { date: "2024-01-22", duration_min: 90 },
    { date: "2023-12-31", duration_min: 1000 },
  ];
  const summary = trainingSummary(sessions, "2024-01-01", "2024-01-28");
  assert.deepEqual(summary.weeks.map((w) => w.sessions), [1, 1, 0, 1]);
  assert.equal(summary.activeWeekPct, 75);
  assert.equal(summary.longestStreak, 2);
  assert.equal(summary.hoursPerWeek, 3.5 / 4);
  assert.equal(summary.sessionsPerWeek, 3 / 4);
  assert.ok(Math.abs(summary.highIntensityPct - 100 / 3) < 1e-10);
  const partial = trainingSummary(sessions, "2024-01-01", "2024-01-02");
  assert.equal(partial.sessionsPerWeek, 3.5);
  assert.equal(trainingSummary([], "2024-01-01", "2024-01-28").highIntensityPct, null);
});

test("recovery pairs use preceding RHR readings without crossing the selected end date", () => {
  const dates = Array.from({ length: 35 }, (_, i) => new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10));
  const daily = { date: dates, rhr: dates.map(() => 60) };
  daily.rhr[30] = 65;
  const sessions = [
    { date: dates[3], trimp: 20 },
    { date: dates[29], trimp: 70 },
    { date: dates[29], trimp: 30 },
    { date: dates[30], trimp: 40 },
  ];
  const pairs = recoveryPairs(sessions, daily, dates[29], dates[30]);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0], { date: dates[29], next: dates[30], load: 100, rhr: 65, baseline: 60, delta: 5 });
  assert.equal(recoveryPairs(sessions, daily, dates[0], dates[4]).length, 0);
});

test("correlation fits require enough nonconstant paired observations", () => {
  const points = Array.from({ length: 8 }, (_, i) => [i, 2 * i + 3]);
  assert.deepEqual(linearFit(points), { n: 8, r: 1, slope: 2, intercept: 3 });
  assert.equal(linearFit(points.slice(0, 7)), null);
  assert.equal(linearFit(points.map((p) => [p[0], 5])), null);
});
