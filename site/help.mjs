const HELP = {
  sport: ["Sport filter", "Workouts, session charts and training load use the selected sport. Body measurements, sleep and daily activity use the date range only."],
  range: ["Date range", "Inclusive start and end dates. Presets end on the latest export date. Charts use daily, weekly or monthly buckets depending on the range."],
  weight: ["Weight", "Monthly log interpolated between entries, with scale readings and DEXA scans shown separately. BMI = weight in kg / height in metres squared."],
  "weight-change": ["Weight change", "End weight minus start weight. Chart bars use the interpolated weight change across each date bucket."],
  "weight-training": ["Weight and training", "Training hours use the selected sport. Weight is the daily interpolated log. Weekly rates account for partial weeks or months."],
  composition: ["Body composition", "Latest DEXA scan within the date range. Lean tissue, fat and bone mass are shown in pounds."],
  percentiles: ["DEXA percentiles", "Position in the scan provider's reference population. The middle line is the 50th percentile, not a target."],
  symmetry: ["Left and right symmetry", "Lean, fat and total mass by side. R vs L = (right lean - left lean) / their mean, as a percentage."],
  workouts: ["Workouts", "Recorded sessions from the selected sport and dates. Overlapping Apple Health and Strava recordings are merged before counting."],
  volume: ["Training volume", "Sessions and training hours across the selected range. Weekly rates divide by elapsed days / 7, including partial weeks."],
  consistency: ["Training consistency", "An active week contains at least one selected session. The line is the share of active weeks in a trailing 8-week window. Streaks count consecutive active weeks; partial boundary weeks are included. Missing recordings can appear as inactive weeks."],
  intensity: ["Training intensity", "Share of recorded heart-rate minutes in each zone. High intensity is Z4 + Z5. Zone boundaries are 60%, 70%, 80% and 90% of estimated maximum HR. Missing HR time is excluded, not treated as easy training."],
  efficiency: ["Distance rate and heart rate", "Distance divided by total session duration, including rest breaks; not instantaneous speed. HR is the mean of available session averages. Only sessions with positive distance and duration are included, and only one activity type is plotted at a time."],
  "sport-comparison": ["Sport comparison", "Per-sport totals and rates over the same selected dates. Distance rate uses only sessions with recorded distance and duration. Missing readings are excluded. Different sports and recording coverage are not directly comparable."],
  recovery: ["Training and next-day resting HR", "Each point pairs a workout day's selected-sport TRIMP with next-day RHR minus its preceding 28-day mean (at least 7 readings). Both paired days are inside the range; the baseline may start earlier. Other sports, sleep and illness can also affect RHR. Association, not causation."],
  daily: ["Daily measurements", "All-day Apple Health measurements, filtered by date rather than sport. A missing measurement is not a zero."],
  vo2: ["VO2 max", "Apple Health estimate of aerobic capacity, in ml/kg/min. The overview uses the last 60 days in the range, falling back to the latest available reading."],
  rhr: ["Resting heart rate", "Mean Apple Health resting heart rate in beats per minute. Sparse buckets are omitted; the trend line smooths three adjacent buckets."],
  hrv: ["Heart-rate variability", "SDNN in milliseconds: variation between heartbeats. Chart points are bucket means; the line smooths three adjacent buckets."],
  correlation: ["Correlation", "Pearson r from -1 to +1. At least 8 paired buckets and watch coverage on half the days are required. Association does not establish causation."],
  rings: ["Activity rings", "Percentage of recorded ring days meeting each goal, smoothed over three buckets. Daily totals are not filtered by sport."],
  load: ["Training load", "Daily TRIMP from the selected sport. CTL: 42-day exponential mean. ATL: 7-day mean. TSB: CTL minus ATL. Earlier sessions seed the curves before the selected start date."],
  energy: ["Energy estimates", "BMR: Mifflin-St Jeor estimate. Expenditure: BMR plus recorded active calories. Implied intake: expenditure plus weight change at 3,500 kcal/lb. Estimates, not measured food intake; independent of sport."],
  periods: ["Period comparison", "Each configured period is clipped to the date range. Workout rates use the selected sport; daily body and health measurements do not."],
  sleep: ["Sleep", "Recorded sleep, assigned to the waking date. Averages exclude missing nights; sparse buckets are omitted. Times use the inferred local time zone."],
};

export function helpButton(key) {
  if (!key || !HELP[key]) return "";
  return `<button type="button" class="help-trigger" popovertarget="help-${key}" aria-label="About ${HELP[key][0]}" aria-describedby="help-${key}">i</button>`;
}

export function renderHelp() {
  document.querySelectorAll("[data-help]").forEach((el) => {
    if (el.tagName === "LABEL") {
      if (!el.nextElementSibling?.classList.contains("help-trigger")) el.insertAdjacentHTML("afterend", helpButton(el.dataset.help));
    } else if (!el.querySelector(".help-trigger")) el.insertAdjacentHTML("beforeend", helpButton(el.dataset.help));
  });
}

export function initHelp() {
  let trigger;
  let pinned = null;
  let showTimer;
  let hideTimer;
  const popupFor = (button) => document.getElementById(button.getAttribute("popovertarget"));
  const isOpen = (popup) => popup.matches(":popover-open");
  const show = (button) => {
    clearTimeout(hideTimer);
    const popup = popupFor(button);
    trigger = button;
    if (!isOpen(popup)) popup.showPopover();
  };
  // Hover and keyboard-focus previews close when both the trigger and the popover are left; clicks pin them open.
  const scheduleHide = () => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!trigger?.isConnected) return;
      const popup = popupFor(trigger);
      if (popup === pinned || !isOpen(popup) || popup.matches(":hover") || trigger.matches(":hover, :focus-visible")) return;
      popup.hidePopover();
    }, 150);
  };
  const position = (popup) => {
    if (!trigger?.isConnected) return;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const width = popup.offsetWidth || Math.min(300, viewportWidth - 24);
    const height = popup.offsetHeight;
    popup.style.left = `${Math.max(12, Math.min(rect.left, viewportWidth - width - 12))}px`;
    const below = rect.bottom + 8;
    popup.style.top = `${Math.max(12, below + height <= viewportHeight - 12 ? below : rect.top - height - 8)}px`;
  };
  for (const [key, [, text]] of Object.entries(HELP)) {
    const popup = document.createElement("div");
    popup.id = `help-${key}`;
    popup.className = "help-content";
    popup.setAttribute("popover", "auto");
    popup.setAttribute("role", "tooltip");
    popup.textContent = text;
    popup.addEventListener("beforetoggle", (event) => {
      if (event.newState === "open") requestAnimationFrame(() => position(popup));
      else if (pinned === popup) pinned = null;
    });
    popup.addEventListener("toggle", (event) => {
      if (event.newState === "open") position(popup);
    });
    popup.addEventListener("pointerenter", () => clearTimeout(hideTimer));
    popup.addEventListener("pointerleave", (event) => {
      if (event.pointerType !== "touch") scheduleHide();
    });
    document.body.append(popup);
  }
  document.addEventListener("pointerover", (event) => {
    const button = event.target instanceof Element && event.target.closest(".help-trigger");
    if (!button || event.pointerType === "touch" || button.contains(event.relatedTarget)) return;
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = setTimeout(() => show(button), 80);
  });
  document.addEventListener("pointerout", (event) => {
    const button = event.target instanceof Element && event.target.closest(".help-trigger");
    if (!button || event.pointerType === "touch" || button.contains(event.relatedTarget)) return;
    scheduleHide();
  });
  document.addEventListener("focusin", (event) => {
    const button = event.target instanceof Element && event.target.closest(".help-trigger");
    if (button?.matches(":focus-visible")) show(button);
  });
  document.addEventListener("focusout", (event) => {
    if (event.target instanceof Element && event.target.closest(".help-trigger")) scheduleHide();
  });
  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element && event.target.closest(".help-trigger");
    if (!button) return;
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    const popup = popupFor(button);
    trigger = button;
    if (isOpen(popup) && pinned !== popup) {
      // Already previewed by hover or focus: keep it open instead of letting the native toggle close it.
      event.preventDefault();
      pinned = popup;
      return;
    }
    if (!isOpen(popup)) pinned = popup;
    position(popup);
  });
  const close = () => document.querySelectorAll(".help-content:popover-open").forEach((el) => el.hidePopover());
  window.addEventListener("resize", close);
  document.addEventListener("scroll", (event) => {
    if (!(event.target instanceof Element && event.target.closest(".help-content"))) close();
  }, true);
  renderHelp();
}
