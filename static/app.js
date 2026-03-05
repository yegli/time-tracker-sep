/* ── State ──────────────────────────────────────────────────────────────────── */
const state = {
  sprintA: null,
  sprintB: null,
  compareMode: false,
  epicMap: null,        // loaded once: { "SEP-7": "Epic Name", ... } or null
  sprintLengthWeeks: null,  // null = auto-detect from worklogs
  allWorklogs: null,    // null = not yet loaded; Array = cached combined rows
};

/* ── Table filter/sort state (persisted across re-renders, reset on sprint change) ── */
const tableState = {
  search: "",
  member: "",
  status: "",
  sortCol: null,     // column key string or null
  sortDir: 1,        // 1 = asc, -1 = desc
  showComments: false,
};

/* ── Chart instances (destroyed before re-create) ───────────────────────────── */
const charts = {};

/* ── DOM references ─────────────────────────────────────────────────────────── */
const elSprintSelect  = document.getElementById("sprint-select");
const elSprintBSelect = document.getElementById("sprint-b-select");
const elSprintBGroup  = document.getElementById("sprint-b-group");
const elCompareToggle = document.getElementById("compare-toggle");
const elLayout        = document.getElementById("app-layout");
const elEmptyState    = document.getElementById("empty-state");
const elErrorBanner   = document.getElementById("error-banner");
const elErrorMessage  = document.getElementById("error-message");
const elErrorDismiss  = document.getElementById("error-dismiss");
const elThemeToggle   = document.getElementById("theme-toggle");
const elNavTabs       = document.querySelectorAll(".nav-tab");
const elViews         = document.querySelectorAll(".view");
const elCompareTab    = document.querySelector(".compare-tab");

/* ── Initialise ─────────────────────────────────────────────────────────────── */
async function init() {
  restoreTheme();
  await Promise.all([loadSprintList(), loadEpicMapping()]);
  bindEvents();
}

/** Fetch /api/epic-mapping once at startup. Sets state.epicMap or leaves it null. */
async function loadEpicMapping() {
  try {
    const res = await fetch("/api/epic-mapping");
    if (!res.ok) return;
    const data = await res.json();
    if (data && typeof data === "object") state.epicMap = data;
  } catch (_) {
    // non-fatal — epic view will show placeholder
  }
}

/* ── Sprint list ────────────────────────────────────────────────────────────── */
async function loadSprintList() {
  let sprints;
  try {
    const res = await fetch("/api/sprints");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sprints = await res.json();
  } catch (err) {
    showError("Could not load sprint list: " + err.message);
    return;
  }

  if (sprints.length === 0) {
    showEmptyState();
    return;
  }

  populateDropdown(elSprintSelect, sprints);
  populateDropdown(elSprintBSelect, sprints);
  showLayout();

  // Auto-select the first sprint (or previously persisted one)
  const saved = localStorage.getItem("time-tracker-last-sprint");
  const match = sprints.find(s => s.filename === saved);
  const initial = match ? match.filename : sprints[0].filename;
  elSprintSelect.value = initial;
  await setSprintA(initial);
}

function populateDropdown(selectEl, sprints) {
  // Clear existing options (except placeholder)
  while (selectEl.options.length > 1) selectEl.remove(1);
  sprints.forEach(({ filename, label }) => {
    const opt = document.createElement("option");
    opt.value = filename;
    opt.textContent = label;
    selectEl.appendChild(opt);
  });
}

/* ── Sprint loading ─────────────────────────────────────────────────────────── */
async function loadSprint(filename) {
  const res = await fetch(`/api/sprint/${encodeURIComponent(filename)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const result = Papa.parse(text, { header: true, skipEmptyLines: true });
  validateHeaders(result.meta.fields);
  // Coerce numeric field
  result.data.forEach(row => {
    row["Time Spent (s)"] = Number(row["Time Spent (s)"]) || 0;
  });
  return result.data;
}

/** Fetch every sprint file and return all rows combined (cached in state.allWorklogs). */
async function _loadAllWorklogs() {
  try {
    const res = await fetch("/api/sprints");
    if (!res.ok) return [];
    const sprints = await res.json();
    const arrays  = await Promise.all(
      sprints.map(({ filename }) => loadSprint(filename).catch(() => []))
    );
    return arrays.flat();
  } catch {
    return [];
  }
}

function validateHeaders(fields) {
  const required = [
    "Last Updated", "Time Spent (s)", "Team Member",
    "Issue Key", "Issue Description", "Issue Type", "Status",
  ];
  const missing = required.filter(f => !fields.includes(f));
  if (missing.length > 0) {
    throw new Error(`Missing required columns: ${missing.join(", ")}`);
  }
}

async function setSprintA(filename) {
  try {
    const rows = await loadSprint(filename);
    state.sprintA = rows;                                    // only write on success
    localStorage.setItem("time-tracker-last-sprint", filename);
    // Reset table filters when the sprint changes (AC10)
    tableState.search = "";
    tableState.member = "";
    tableState.status = "";
    tableState.sortCol = null;
    tableState.sortDir = 1;
  } catch (err) {
    showError(err.message);
    // leave state.sprintA unchanged so existing data stays visible
  }
  renderAll();
}

async function setSprintB(filename) {
  if (!filename) { state.sprintB = null; renderAll(); return; }
  try {
    const rows = await loadSprint(filename);
    state.sprintB = rows;                                    // only write on success
  } catch (err) {
    showError(err.message);
    // leave state.sprintB unchanged
  }
  renderAll();
}

/* ── Data transforms ────────────────────────────────────────────────────────── */

/** Parse "dd/mm/yyyy" → "yyyy-mm-dd". Never pass dd/mm/yyyy to new Date(). */
function parseDate(ddmmyyyy) {
  const [dd, mm, yyyy] = ddmmyyyy.split("/");
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/** Generate every ISO date between startISO and endISO inclusive. */
function _dateRange(startISO, endISO) {
  const dates = [];
  const cur = new Date(startISO + "T00:00:00Z");
  const end = new Date(endISO   + "T00:00:00Z");
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Total seconds per team member.
 * Returns: { "Yanick Egli": 14400, "Till Studer": 28800 }
 */
function aggregateByMember(rows) {
  const result = {};
  for (const row of rows) {
    const m = row["Team Member"];
    if (!m) continue;
    result[m] = (result[m] || 0) + row["Time Spent (s)"];
  }
  return result;
}

/**
 * Seconds per category per team member.
 * Returns: { "Yanick Egli": { Admin: 3600, Coding: 7200, Documentation: 1800 }, ... }
 */
function aggregateByMemberCategory(rows) {
  const result = {};
  for (const row of rows) {
    const m   = row["Team Member"];
    const cat = row["Fix version"] || "_unknown";
    if (!m) continue;
    if (!result[m]) result[m] = {};
    result[m][cat] = (result[m][cat] || 0) + row["Time Spent (s)"];
  }
  return result;
}

/**
 * Total seconds per category across all members.
 * Returns: { Admin: N, Coding: N, Documentation: N, _unknown: N }
 */
function aggregateByCategoryTotal(rows) {
  const result = {};
  for (const row of rows) {
    const cat = row["Fix version"] || "_unknown";
    result[cat] = (result[cat] || 0) + row["Time Spent (s)"];
  }
  return result;
}

/**
 * Total seconds per issue key, sorted descending.
 * Returns: [{ key, description, status, issueType, seconds }, ...]
 */
function aggregateByIssue(rows) {
  const map = {};
  for (const row of rows) {
    const key = row["Issue Key"];
    if (!key) continue;
    if (!map[key]) {
      map[key] = {
        key,
        description: row["Issue Description"],
        status:      row["Status"],
        issueType:   row["Issue Type"],
        seconds:     0,
      };
    }
    map[key].seconds += row["Time Spent (s)"];
    // Use the latest status seen (it may have progressed across log entries)
    map[key].status = row["Status"];
  }
  return Object.values(map).sort((a, b) => b.seconds - a.seconds);
}

/**
 * Daily totals per team member with a continuous date axis.
 * Returns: { dates: ["2026-02-19", ...], members: { "Name": [sec, 0, sec, ...] } }
 */
function aggregateByDay(rows) {
  const byDate = {};     // { isoDate: { member: seconds } }
  const memberSet = new Set();

  for (const row of rows) {
    const raw = row["Last Updated"];
    if (!raw) continue;
    const iso    = parseDate(raw);
    const member = row["Team Member"];
    if (!member) continue;
    memberSet.add(member);
    if (!byDate[iso]) byDate[iso] = {};
    byDate[iso][member] = (byDate[iso][member] || 0) + row["Time Spent (s)"];
  }

  if (memberSet.size === 0) return { dates: [], members: {} };

  const presentDates = Object.keys(byDate).sort();
  const dates = _dateRange(presentDates[0], presentDates[presentDates.length - 1]);

  const members = {};
  for (const m of memberSet) {
    members[m] = dates.map(d => (byDate[d] && byDate[d][m]) || 0);
  }

  return { dates, members };
}

/**
 * Total seconds per status value.
 * Returns: { "Done": 32400, "Review": 3600, ... }
 */
function aggregateByStatus(rows) {
  const result = {};
  for (const row of rows) {
    const s = row["Status"];
    if (!s) continue;
    result[s] = (result[s] || 0) + row["Time Spent (s)"];
  }
  return result;
}

/**
 * Total seconds per epic. Returns null when no epicMap is provided.
 * Issues not found in epicMap are grouped under "Unmapped".
 * Returns: { "Epic: Tooling": 3600, ... } or null
 */
function aggregateByEpic(rows, epicMap) {
  if (!epicMap) return null;
  const result = {};
  for (const row of rows) {
    const epic = epicMap[row["Issue Key"]] || "Unmapped";
    result[epic] = (result[epic] || 0) + row["Time Spent (s)"];
  }
  return result;
}

/**
 * Compare two sprints and return per-member deltas, totals, and issue overlap.
 * Returns: { members, totalA, totalB, totalDelta, totalDeltaPercent, overlap }
 */
function diffSprints(rowsA, rowsB) {
  const byMemberA = aggregateByMember(rowsA);
  const byMemberB = aggregateByMember(rowsB);
  const byIssueA  = aggregateByIssue(rowsA);
  const byIssueB  = aggregateByIssue(rowsB);

  // Per-member delta (union of all members across both sprints)
  const allMembers = new Set([...Object.keys(byMemberA), ...Object.keys(byMemberB)]);
  const members = {};
  for (const m of allMembers) {
    const a = byMemberA[m] || 0;
    const b = byMemberB[m] || 0;
    const delta = b - a;
    const deltaPercent = a === 0
      ? (b > 0 ? null : 0)   // null = new member (would be +∞%)
      : Math.round((delta / a) * 100);
    members[m] = { a, b, delta, deltaPercent };
  }

  // Totals
  const totalA = Object.values(byMemberA).reduce((s, v) => s + v, 0);
  const totalB = Object.values(byMemberB).reduce((s, v) => s + v, 0);
  const totalDelta = totalB - totalA;
  const totalDeltaPercent = totalA === 0
    ? (totalB > 0 ? null : 0)
    : Math.round((totalDelta / totalA) * 100);

  // Issue overlap — full union so "dropped" and "new" issues are included
  const issueMapA = Object.fromEntries(byIssueA.map(i => [i.key, i]));
  const issueMapB = Object.fromEntries(byIssueB.map(i => [i.key, i]));
  const allKeys   = new Set([...Object.keys(issueMapA), ...Object.keys(issueMapB)]);
  const overlap   = Array.from(allKeys).map(key => ({
    key,
    description: (issueMapA[key] || issueMapB[key]).description,
    secondsA:    issueMapA[key] ? issueMapA[key].seconds : 0,
    secondsB:    issueMapB[key] ? issueMapB[key].seconds : 0,
  })).sort((a, b) =>
    Math.abs(b.secondsB - b.secondsA) - Math.abs(a.secondsB - a.secondsA)
  );

  return { members, totalA, totalB, totalDelta, totalDeltaPercent, overlap };
}

/* ── Colour & format utilities ──────────────────────────────────────────────── */

const PALETTE = [
  "#7eb8f7", // pastel blue
  "#6dd9a8", // pastel green
  "#ffd47a", // pastel amber
  "#b8a0e8", // pastel violet
  "#f79090", // pastel coral
  "#6adde8", // pastel cyan
  "#ffb87a", // pastel orange
  "#b0e07a", // pastel lime
  "#f7a0c8", // pastel pink
  "#6adbd0", // pastel teal
];

const STATUS_COLORS = {
  "Done":            "#6dd9a8",
  "Review":          "#7eb8f7",
  "Ready / Refined": "#ffd47a",
  "In Progress":     "#b8a0e8",
};

const CATEGORIES      = ["Admin", "Coding", "Documentation"];
const CATEGORY_COLORS = {
  Admin:         "#f59e0b",   // amber
  Coding:        "#3b82f6",   // blue
  Documentation: "#8b5cf6",   // violet
  _unknown:      "#94a3b8",   // slate
};

/* Project-wide budget constants */
const PROJECT_WEEKS      = 15;
const PROJECT_BUDGET_HRS = 600;

/** Convert a hex colour to rgba with the given alpha (0–1). */
function _rgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const _memberColorCache = {};
let   _paletteIdx = 0;

/** Return a stable colour for a member name (same name → same colour always). */
function memberColor(name) {
  if (!_memberColorCache[name]) {
    _memberColorCache[name] = PALETTE[_paletteIdx % PALETTE.length];
    _paletteIdx++;
  }
  return _memberColorCache[name];
}

/** Return the colour for a status value, falling back to grey. */
function statusColor(status) {
  return STATUS_COLORS[status] || "#94a3b8";
}

/** Format seconds as "Xh" or "Xh Ym". */
function formatHours(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/* ── Render dispatcher ──────────────────────────────────────────────────────── */
function renderAll() {
  // Each view render function will be filled in by later tasks.
  // Stubs ensure no errors when called here.
  if (typeof renderOverview  === "function") renderOverview();
  if (typeof renderMember    === "function") renderMember();
  if (typeof renderIssue     === "function") renderIssue();
  if (typeof renderTimeline  === "function") renderTimeline();
  if (typeof renderEpic      === "function") renderEpic();
  if (typeof renderTable     === "function") renderTable();
  if (typeof renderCapacity  === "function") renderCapacity();
  if (typeof renderCompare   === "function") renderCompare();
}

/* ── Tab switching ──────────────────────────────────────────────────────────── */
function switchView(viewName) {
  elNavTabs.forEach(tab => tab.classList.toggle("active", tab.dataset.view === viewName));
  elViews.forEach(view => view.classList.toggle("active", view.id === `view-${viewName}`));
}

/* ── Compare mode ───────────────────────────────────────────────────────────── */
function setCompareMode(on) {
  state.compareMode = on;
  elSprintBGroup.hidden = !on;
  elCompareTab.hidden   = !on;
  if (on) {
    switchView("compare");
  } else {
    state.sprintB = null;
    elSprintBSelect.value = "";
    switchView("overview");
  }
  renderAll();
}

/* ── Visibility helpers ─────────────────────────────────────────────────────── */
function showLayout() {
  elLayout.hidden    = false;
  elEmptyState.style.display = "none";
}

function showEmptyState() {
  elLayout.hidden    = true;
  elEmptyState.style.display = "";
}

/* ── Error banner ───────────────────────────────────────────────────────────── */
function showError(msg) {
  elErrorMessage.textContent = msg;
  elErrorBanner.hidden = false;
}
function hideError() { elErrorBanner.hidden = true; }

/* ── Theme ──────────────────────────────────────────────────────────────────── */
function restoreTheme() {
  const saved = localStorage.getItem("time-tracker-theme") || "light";
  document.documentElement.setAttribute("data-theme", saved);
}
function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("time-tracker-theme", next);
}

/* ── Event binding ──────────────────────────────────────────────────────────── */
function bindEvents() {
  elSprintSelect.addEventListener("change", e => {
    if (e.target.value) setSprintA(e.target.value);
  });
  elSprintBSelect.addEventListener("change", e => {
    setSprintB(e.target.value || null);
  });
  elCompareToggle.addEventListener("change", e => {
    setCompareMode(e.target.checked);
  });
  elNavTabs.forEach(tab => {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  });
  elErrorDismiss.addEventListener("click", hideError);
  elThemeToggle.addEventListener("click", toggleTheme);

  // Upload
  const elUploadBtn   = document.getElementById("upload-btn");
  const elUploadInput = document.getElementById("upload-input");
  elUploadBtn.addEventListener("click", () => elUploadInput.click());
  elUploadInput.addEventListener("change", async () => {
    const file = elUploadInput.files[0];
    if (!file) return;
    elUploadInput.value = "";   // reset so same file can be re-selected
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch("/api/sprint/upload", { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.description || `HTTP ${res.status}`);
      }
      const { filename, label } = await res.json();
      // Refresh sprint list and select the new sprint
      state.allWorklogs = null;   // invalidate cross-sprint cache
      await loadSprintList();
      elSprintSelect.value = filename;
      await setSprintA(filename);
    } catch (err) {
      showError("Upload failed: " + err.message);
    }
  });
}

/* ── View: Overview ─────────────────────────────────────────────────────────── */

function renderOverview() {
  const el = document.getElementById("overview-content");
  if (!el) return;

  if (!state.sprintA) { el.innerHTML = ""; return; }

  const rows        = state.sprintA;
  const byMember    = aggregateByMember(rows);
  const byIssue     = aggregateByIssue(rows);
  const totalSecs   = rows.reduce((s, r) => s + r["Time Spent (s)"], 0);
  const memberCount = Object.keys(byMember).length;
  const issueCount  = byIssue.length;

  // Date range — parse all dates, find min/max
  const isoDates = rows.map(r => r["Last Updated"]).filter(Boolean).map(parseDate).sort();
  const dateRange = isoDates.length
    ? _fmtDateRange(isoDates[0], isoDates[isoDates.length - 1])
    : "—";

  // Member rows sorted descending by hours
  const memberRowsHtml = Object.entries(byMember)
    .sort(([, a], [, b]) => b - a)
    .map(([name, secs]) => {
      const pct   = totalSecs > 0 ? Math.round((secs / totalSecs) * 100) : 0;
      const color = memberColor(name);
      return `
        <div class="progress-row">
          <span class="progress-name" title="${name}">${name}</span>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" style="width:${pct}%;background:${color}"></div>
          </div>
          <span class="progress-label">${formatHours(secs)} (${pct}%)</span>
        </div>`;
    }).join("");

  el.innerHTML = `
    <div class="card-grid">
      <div class="stat-card">
        <div class="stat-label">Total Hours</div>
        <div class="stat-value">${formatHours(totalSecs)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Members</div>
        <div class="stat-value">${memberCount}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Issues</div>
        <div class="stat-value">${issueCount}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Date Range</div>
        <div class="stat-value overview-date">${dateRange}</div>
      </div>
    </div>
    <div class="chart-card">
      <h3>Team Members</h3>
      ${memberRowsHtml}
    </div>`;
}

/** Format two ISO dates as "Feb 19 – Feb 24 2026". */
function _fmtDateRange(startISO, endISO) {
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun",
                  "Jul","Aug","Sep","Oct","Nov","Dec"];
  const [sy, sm, sd] = startISO.split("-").map(Number);
  const [ey, em, ed] = endISO.split("-").map(Number);
  const s = `${MONTHS[sm - 1]} ${sd}`;
  const e = `${MONTHS[em - 1]} ${ed}`;
  if (startISO === endISO) return `${s} ${ey}`;
  if (sy === ey)           return `${s} – ${e} ${ey}`;
  return `${s} ${sy} – ${e} ${ey}`;          // cross-year edge case
}

/* ── View: By Member ────────────────────────────────────────────────────────── */

function renderMember() {
  const el = document.getElementById("member-content");
  if (!el) return;

  // Destroy existing charts to avoid memory leaks
  ["member-donut", "member-bar", "member-drill"].forEach(id => {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  });

  if (!state.sprintA) { el.innerHTML = ""; return; }

  const byMember = aggregateByMember(state.sprintA);
  // Sorted descending by seconds
  const sorted = Object.entries(byMember).sort(([, a], [, b]) => b - a);
  const names  = sorted.map(([n]) => n);
  const secs   = sorted.map(([, s]) => s);
  const colors = names.map(memberColor);

  el.innerHTML = `
    <div class="chart-row">
      <div class="chart-card chart-card--half">
        <div class="chart-card-header">
          <h3>Hours by Member</h3>
          <button class="btn-export-png" id="btn-export-member-donut">⬇ Export PNG</button>
        </div>
        <canvas id="canvas-member-donut"></canvas>
      </div>
      <div class="chart-card chart-card--half">
        <div class="chart-card-header">
          <h3>Member Breakdown</h3>
          <button class="btn-export-png" id="btn-export-member-bar">⬇ Export PNG</button>
        </div>
        <canvas id="canvas-member-bar"></canvas>
      </div>
    </div>
    <div id="member-drill"></div>`;

  // ── Donut chart ──
  charts["member-donut"] = new Chart(
    document.getElementById("canvas-member-donut"),
    {
      type: "doughnut",
      data: {
        labels: names,
        datasets: [{
          data: secs.map(s => +(s / 3600).toFixed(2)),
          backgroundColor: colors.map(c => _rgba(c, 0.45)),
          borderColor: colors,
          borderWidth: 2,
        }],
      },
      options: {
        plugins: {
          legend: { position: "bottom" },
          tooltip: {
            callbacks: {
              label: ctx => {
                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                const pct   = total > 0 ? Math.round((ctx.parsed / total) * 100) : 0;
                return ` ${ctx.label}: ${formatHours(secs[ctx.dataIndex])} (${pct}%)`;
              },
            },
          },
        },
      },
    }
  );

  // ── Horizontal bar chart ──
  charts["member-bar"] = new Chart(
    document.getElementById("canvas-member-bar"),
    {
      type: "bar",
      data: {
        labels: names,
        datasets: [{
          label: "Hours",
          data: secs.map(s => +(s / 3600).toFixed(2)),
          backgroundColor: colors.map(c => _rgba(c, 0.45)),
          borderColor: colors,
          borderWidth: 2,
        }],
      },
      options: {
        indexAxis: "y",
        onClick: (_evt, elements) => {
          if (elements.length > 0) _renderMemberDrill(names[elements[0].index]);
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ` ${formatHours(secs[ctx.dataIndex])}`,
            },
          },
        },
        scales: {
          x: { title: { display: true, text: "Hours" } },
        },
      },
    }
  );

  document.getElementById("btn-export-member-donut").addEventListener("click", () => {
    _exportPng(_buildMemberDonutExportConfig, `member_donut_${_sprintSlug()}`);
  });
  document.getElementById("btn-export-member-bar").addEventListener("click", () => {
    _exportPng(_buildMemberBarExportConfig, `member_bar_${_sprintSlug()}`);
  });
}

/** Render per-issue breakdown for the selected member below the main charts. */
function _renderMemberDrill(memberName) {
  const el = document.getElementById("member-drill");
  if (!el) return;

  if (charts["member-drill"]) { charts["member-drill"].destroy(); delete charts["member-drill"]; }

  const memberRows = state.sprintA.filter(r => r["Team Member"] === memberName);
  const issues     = aggregateByIssue(memberRows);   // sorted desc by seconds

  if (issues.length === 0) { el.innerHTML = ""; return; }

  el.innerHTML = `
    <div class="chart-card">
      <div class="chart-card-header">
        <h3>Drill-down: ${memberName}</h3>
        <button class="btn-export-png" id="btn-export-member-drill">⬇ Export PNG</button>
      </div>
      <canvas id="canvas-member-drill"></canvas>
    </div>`;

  charts["member-drill"] = new Chart(
    document.getElementById("canvas-member-drill"),
    {
      type: "bar",
      data: {
        labels: issues.map(i => `${i.key} — ${i.description}`),
        datasets: [{
          label: "Hours",
          data: issues.map(i => +(i.seconds / 3600).toFixed(2)),
          backgroundColor: issues.map(i => _rgba(statusColor(i.status), 0.45)),
          borderColor: issues.map(i => statusColor(i.status)),
          borderWidth: 2,
        }],
      },
      options: {
        indexAxis: "y",
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ` ${formatHours(issues[ctx.dataIndex].seconds)} · ${issues[ctx.dataIndex].status}`,
            },
          },
        },
        scales: {
          x: { title: { display: true, text: "Hours" } },
        },
      },
    }
  );

  document.getElementById("btn-export-member-drill").addEventListener("click", () => {
    _exportPng(
      () => _buildMemberDrillExportConfig(memberName),
      `member_drill_${memberName.replace(/\s+/g, "_").toLowerCase()}_${_sprintSlug()}`
    );
  });
}

/* ── View: By Issue ─────────────────────────────────────────────────────────── */

function renderIssue() {
  const el = document.getElementById("issue-content");
  if (!el) return;

  if (charts["issue-bar"]) { charts["issue-bar"].destroy(); delete charts["issue-bar"]; }

  if (!state.sprintA) { el.innerHTML = ""; return; }

  const issues = aggregateByIssue(state.sprintA);   // sorted desc by seconds

  // Build per-issue tooltip data: members who logged time on each issue
  const membersByIssue = {};
  for (const row of state.sprintA) {
    const k = row["Issue Key"], m = row["Team Member"];
    if (!k || !m) continue;
    if (!membersByIssue[k]) membersByIssue[k] = new Set();
    membersByIssue[k].add(m);
  }

  const MAX_LABEL = 50;
  const labels = issues.map(i => {
    const full = `${i.key} — ${i.description}`;
    return full.length > MAX_LABEL ? full.slice(0, MAX_LABEL - 1) + "…" : full;
  });
  const colors = issues.map(i => statusColor(i.status));

  // Legend: only statuses present in this sprint
  const presentStatuses = [...new Set(issues.map(i => i.status))];
  const legendHtml = presentStatuses.map(s => `
    <span class="legend-dot" style="background:${statusColor(s)}"></span>
    <span class="legend-label">${s}</span>`).join("");

  el.innerHTML = `
    <div class="chart-card">
      <div class="chart-card-header">
        <h3>Time by Issue</h3>
        <button class="btn-export-png" id="btn-export-issue">⬇ Export PNG</button>
      </div>
      <div class="legend-row">${legendHtml}</div>
      <canvas id="canvas-issue-bar"></canvas>
    </div>`;

  charts["issue-bar"] = new Chart(
    document.getElementById("canvas-issue-bar"),
    {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Hours",
          data: issues.map(i => +(i.seconds / 3600).toFixed(2)),
          backgroundColor: colors.map(c => _rgba(c, 0.45)),
          borderColor: colors,
          borderWidth: 2,
        }],
      },
      options: {
        indexAxis: "y",
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: ctx => issues[ctx[0].dataIndex].key,
              label: ctx => {
                const i = issues[ctx.dataIndex];
                const members = [...(membersByIssue[i.key] || [])].join(", ");
                return [
                  ` ${i.description}`,
                  ` Status: ${i.status}`,
                  ` Members: ${members}`,
                  ` Hours: ${formatHours(i.seconds)}`,
                ];
              },
            },
          },
        },
        scales: {
          x: { title: { display: true, text: "Hours" } },
          y: { ticks: { font: { size: 11 } } },
        },
      },
    }
  );

  document.getElementById("btn-export-issue").addEventListener("click", () => {
    _exportPng(_buildIssueExportConfig, `issues_${_sprintSlug()}`);
  });
}

/* ── View: Timeline ─────────────────────────────────────────────────────────── */

function renderTimeline() {
  const el = document.getElementById("timeline-content");
  if (!el) return;

  if (charts["timeline"]) { charts["timeline"].destroy(); delete charts["timeline"]; }

  if (!state.sprintA) { el.innerHTML = ""; return; }

  const { dates, members } = aggregateByDay(state.sprintA);

  if (dates.length === 0) { el.innerHTML = "<div class=\"chart-card\"><p>No date data available.</p></div>"; return; }

  // X-axis: "Feb 19" style labels
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const xLabels = dates.map(iso => {
    const [, mm, dd] = iso.split("-").map(Number);
    return `${MONTHS[mm - 1]} ${dd}`;
  });

  // One dataset per member, same colours as View 2
  const datasets = Object.entries(members).map(([name, secArr]) => ({
    label: name,
    data: secArr.map(s => +(s / 3600).toFixed(2)),
    backgroundColor: _rgba(memberColor(name), 0.45),
    borderColor: memberColor(name),
    borderWidth: 2,
  }));

  el.innerHTML = `
    <div class="chart-card">
      <div class="chart-card-header">
        <h3>Daily Hours by Member</h3>
        <button class="btn-export-png" id="btn-export-timeline">⬇ Export PNG</button>
      </div>
      <canvas id="canvas-timeline"></canvas>
    </div>`;

  document.getElementById("btn-export-timeline").addEventListener("click", () => {
    _exportPng(_buildTimelineExportConfig, `timeline_${_sprintSlug()}`);
  });

  charts["timeline"] = new Chart(
    document.getElementById("canvas-timeline"),
    {
      type: "bar",
      data: { labels: xLabels, datasets },
      options: {
        plugins: {
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.dataset.label}: ${formatHours(Math.round(ctx.parsed.y * 3600))}`,
            },
          },
        },
        scales: {
          x: { stacked: true },
          y: {
            stacked: true,
            title: { display: true, text: "Hours" },
            ticks: { callback: v => `${v}h` },
          },
        },
      },
    }
  );
}

/* ── View: By Epic ──────────────────────────────────────────────────────────── */

function renderEpic() {
  const el = document.getElementById("epic-content");
  if (!el) return;

  ["epic-bar", "epic-grouped"].forEach(id => {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  });

  if (!state.sprintA) { el.innerHTML = ""; return; }

  // ── Resolve epic map: CSV column first, then state.epicMap, then null ──
  const csvEpicCol = ["Epic Link", "Epic Name"].find(
    col => state.sprintA.length > 0 && col in state.sprintA[0]
  );
  let epicMap = null;
  if (csvEpicCol) {
    epicMap = {};
    for (const row of state.sprintA) {
      if (row["Issue Key"] && row[csvEpicCol]) epicMap[row["Issue Key"]] = row[csvEpicCol];
    }
    if (Object.keys(epicMap).length === 0) epicMap = null;
  } else if (state.epicMap) {
    epicMap = state.epicMap;
  }

  if (!epicMap) {
    el.innerHTML = `
      <div class="chart-card epic-placeholder">
        <p class="epic-placeholder__icon">ℹ️</p>
        <p><strong>No Epic data found.</strong></p>
        <p>To enable this view, either:</p>
        <ol>
          <li>Re-export your Jira worklogs with the <code>Epic Link</code> column included, or</li>
          <li>Create <code>epic-mapping.json</code> in the project root:<br>
            <code>{ "SEP-7": "Epic name", "SEP-22": "Another epic", ... }</code>
          </li>
        </ol>
      </div>`;
    return;
  }

  const byEpic = aggregateByEpic(state.sprintA, epicMap);   // { epicName: seconds }
  const epicsSorted = Object.entries(byEpic).sort(([, a], [, b]) => b - a);
  const epicNames   = epicsSorted.map(([n]) => n);
  const epicSecs    = epicsSorted.map(([, s]) => s);
  const epicColors  = epicNames.map((_, i) => PALETTE[i % PALETTE.length]);

  // ── Epic × Member breakdown ──
  const byMember = aggregateByMember(state.sprintA);
  const memberNames = Object.keys(byMember);
  // For each member: seconds per epic
  const memberEpicSecs = {};
  for (const m of memberNames) {
    memberEpicSecs[m] = {};
    const memberRows = state.sprintA.filter(r => r["Team Member"] === m);
    for (const row of memberRows) {
      const epic = epicMap[row["Issue Key"]] || "Unmapped";
      memberEpicSecs[m][epic] = (memberEpicSecs[m][epic] || 0) + row["Time Spent (s)"];
    }
  }
  const groupedDatasets = memberNames.map((name, i) => ({
    label: name,
    data: epicNames.map(epic => +((memberEpicSecs[name][epic] || 0) / 3600).toFixed(2)),
    backgroundColor: _rgba(memberColor(name), 0.45),
    borderColor: memberColor(name),
    borderWidth: 2,
  }));

  el.innerHTML = `
    <div class="chart-card">
      <div class="chart-card-header">
        <h3>Hours per Epic</h3>
        <button class="btn-export-png" id="btn-export-epic-bar">⬇ Export PNG</button>
      </div>
      <canvas id="canvas-epic-bar"></canvas>
    </div>
    <div class="chart-card">
      <div class="chart-card-header">
        <h3>Epic × Member Breakdown</h3>
        <button class="btn-export-png" id="btn-export-epic-grouped">⬇ Export PNG</button>
      </div>
      <canvas id="canvas-epic-grouped"></canvas>
    </div>`;

  charts["epic-bar"] = new Chart(
    document.getElementById("canvas-epic-bar"),
    {
      type: "bar",
      data: {
        labels: epicNames,
        datasets: [{
          label: "Hours",
          data: epicSecs.map(s => +(s / 3600).toFixed(2)),
          backgroundColor: epicColors.map(c => _rgba(c, 0.45)),
          borderColor: epicColors,
          borderWidth: 2,
        }],
      },
      options: {
        indexAxis: "y",
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => ` ${formatHours(epicSecs[ctx.dataIndex])}` } },
        },
        scales: { x: { title: { display: true, text: "Hours" } } },
      },
    }
  );

  charts["epic-grouped"] = new Chart(
    document.getElementById("canvas-epic-grouped"),
    {
      type: "bar",
      data: { labels: epicNames, datasets: groupedDatasets },
      options: {
        plugins: {
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.dataset.label}: ${formatHours(Math.round(ctx.parsed.y * 3600))}`,
            },
          },
        },
        scales: {
          x: { title: { display: true, text: "Epic" } },
          y: { title: { display: true, text: "Hours" }, ticks: { callback: v => `${v}h` } },
        },
      },
    }
  );

  document.getElementById("btn-export-epic-bar").addEventListener("click", () => {
    _exportPng(_buildEpicBarExportConfig, `epic_bar_${_sprintSlug()}`);
  });
  document.getElementById("btn-export-epic-grouped").addEventListener("click", () => {
    _exportPng(_buildEpicGroupedExportConfig, `epic_grouped_${_sprintSlug()}`);
  });
}

/* ── View: Data Table ───────────────────────────────────────────────────────── */

const TABLE_COLS = [
  { key: "Last Updated",      label: "Date",         fmt: r => _fmtTableDate(r["Last Updated"]) },
  { key: "Team Member",       label: "Member",        fmt: r => r["Team Member"] },
  { key: "Issue Key",         label: "Issue Key",     fmt: r => r["Issue Key"] },
  { key: "Issue Description", label: "Description",   fmt: r => r["Issue Description"] },
  { key: "Issue Type",        label: "Type",          fmt: r => r["Issue Type"] },
  { key: "Status",            label: "Status",        fmt: r => r["Status"] },
  { key: "Time Spent (s)",    label: "Hours",         fmt: r => formatHours(r["Time Spent (s)"]) },
  { key: "Worklog Comment",   label: "Comment",       fmt: r => r["Worklog Comment"] || "", hidden: true },
];

function _fmtTableDate(ddmmyyyy) {
  if (!ddmmyyyy) return "";
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const [dd, mm] = ddmmyyyy.split("/");
  return `${MONTHS[Number(mm) - 1]} ${Number(dd)}`;
}

function renderTable() {
  const el = document.getElementById("table-content");
  if (!el) return;

  if (!state.sprintA) { el.innerHTML = ""; return; }

  // ── Build filter controls ──
  const members  = [...new Set(state.sprintA.map(r => r["Team Member"]).filter(Boolean))].sort();
  const statuses = [...new Set(state.sprintA.map(r => r["Status"]).filter(Boolean))].sort();

  const memberOpts  = ["", ...members ].map(v => `<option value="${v}"${tableState.member===v?" selected":""}>${v||"All members"}</option>`).join("");
  const statusOpts  = ["", ...statuses].map(v => `<option value="${v}"${tableState.status===v?" selected":""}>${v||"All statuses"}</option>`).join("");
  const commentsBtnLabel = tableState.showComments ? "Hide comments" : "Show comments";

  el.innerHTML = `
    <div class="table-toolbar">
      <input id="tbl-search" class="tbl-search" type="search" placeholder="Search…" value="${_escAttr(tableState.search)}">
      <select id="tbl-member">${memberOpts}</select>
      <select id="tbl-status">${statusOpts}</select>
      <button id="tbl-clear" class="btn-secondary">Clear filters</button>
      <button id="tbl-comments" class="btn-secondary">${commentsBtnLabel}</button>
      <button id="tbl-export" class="btn-secondary">⬇ Export CSV</button>
    </div>
    <div class="table-wrap">
      <table class="data-table" id="data-table"></table>
    </div>`;

  // ── Bind toolbar events ──
  document.getElementById("tbl-search").addEventListener("input", e => {
    tableState.search = e.target.value; _renderTableBody();
  });
  document.getElementById("tbl-member").addEventListener("change", e => {
    tableState.member = e.target.value; _renderTableBody();
  });
  document.getElementById("tbl-status").addEventListener("change", e => {
    tableState.status = e.target.value; _renderTableBody();
  });
  document.getElementById("tbl-clear").addEventListener("click", () => {
    tableState.search = ""; tableState.member = ""; tableState.status = "";
    tableState.sortCol = null; tableState.sortDir = 1;
    renderTable();   // full re-render to reset dropdowns too
  });
  document.getElementById("tbl-comments").addEventListener("click", () => {
    tableState.showComments = !tableState.showComments; renderTable();
  });
  document.getElementById("tbl-export").addEventListener("click", _exportTable);

  _renderTableBody();
}

function _renderTableBody() {
  const table = document.getElementById("data-table");
  if (!table) return;

  const visibleCols = TABLE_COLS.filter(c => !c.hidden || tableState.showComments);

  // ── Filter rows ──
  const q = tableState.search.toLowerCase();
  let rows = state.sprintA.filter(r => {
    if (tableState.member && r["Team Member"] !== tableState.member) return false;
    if (tableState.status && r["Status"]      !== tableState.status)  return false;
    if (q) {
      const haystack = visibleCols.map(c => c.fmt(r)).join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  // ── Sort ──
  if (tableState.sortCol) {
    rows = [...rows].sort((a, b) => {
      const col = TABLE_COLS.find(c => c.key === tableState.sortCol);
      const va = col.key === "Time Spent (s)" ? a[col.key] : col.fmt(a);
      const vb = col.key === "Time Spent (s)" ? b[col.key] : col.fmt(b);
      if (va < vb) return -tableState.sortDir;
      if (va > vb) return  tableState.sortDir;
      return 0;
    });
  }

  const totalSecs = rows.reduce((s, r) => s + r["Time Spent (s)"], 0);

  // ── Header ──
  const headerCells = visibleCols.map(c => {
    let indicator = "";
    if (tableState.sortCol === c.key) indicator = tableState.sortDir === 1 ? " ▲" : " ▼";
    return `<th class="tbl-th" data-col="${c.key}">${c.label}${indicator}</th>`;
  }).join("");

  // ── Body ──
  const bodyRows = rows.map(r =>
    `<tr>${visibleCols.map(c => `<td class="tbl-td">${_escHtml(c.fmt(r))}</td>`).join("")}</tr>`
  ).join("") || `<tr><td colspan="${visibleCols.length}" class="tbl-empty">No matching rows.</td></tr>`;

  table.innerHTML = `
    <thead><tr>${headerCells}</tr></thead>
    <tbody>${bodyRows}</tbody>
    <tfoot><tr>
      <td colspan="${visibleCols.length - 1}" class="tbl-footer-label">
        ${rows.length} row${rows.length !== 1 ? "s" : ""} · Showing ${rows.length} of ${state.sprintA.length}
      </td>
      <td class="tbl-footer-total">Total: ${formatHours(totalSecs)}</td>
    </tr></tfoot>`;

  // ── Sort click handlers ──
  table.querySelectorAll(".tbl-th").forEach(th => {
    th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (tableState.sortCol === col) {
        if (tableState.sortDir === 1) { tableState.sortDir = -1; }
        else { tableState.sortCol = null; tableState.sortDir = 1; }
      } else {
        tableState.sortCol = col; tableState.sortDir = 1;
      }
      _renderTableBody();
    });
  });
}

/** Export the currently filtered+sorted table rows as a downloaded CSV file. */
function _exportTable() {
  if (!state.sprintA) return;

  const visibleCols = TABLE_COLS.filter(c => !c.hidden || tableState.showComments);

  // Re-run the same filter+sort logic to get the current visible rows
  const q = tableState.search.toLowerCase();
  let rows = state.sprintA.filter(r => {
    if (tableState.member && r["Team Member"] !== tableState.member) return false;
    if (tableState.status && r["Status"]      !== tableState.status)  return false;
    if (q) {
      const hay = visibleCols.map(c => c.fmt(r)).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  if (tableState.sortCol) {
    rows = [...rows].sort((a, b) => {
      const col = TABLE_COLS.find(c => c.key === tableState.sortCol);
      const va = col.key === "Time Spent (s)" ? a[col.key] : col.fmt(a);
      const vb = col.key === "Time Spent (s)" ? b[col.key] : col.fmt(b);
      return va < vb ? -tableState.sortDir : va > vb ? tableState.sortDir : 0;
    });
  }

  // Build CSV string
  const escape = v => `"${String(v).replace(/"/g, '""')}"`;
  const header = visibleCols.map(c => escape(c.label)).join(",");
  const body   = rows.map(r => visibleCols.map(c => escape(c.fmt(r))).join(",")).join("\n");
  const csv    = `${header}\n${body}`;

  // Derive a label from the active sprint filename
  const filename = elSprintSelect.value || "sprint";
  const label    = (elSprintSelect.selectedOptions[0]?.text || filename).replace(/\s+/g, "_");
  const ts       = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  const dlName   = `export_${label}_${ts}.csv`;

  const blob = new Blob([csv], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = dlName; a.click();
  URL.revokeObjectURL(url);
}

function _escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function _escAttr(s) {
  return String(s).replace(/"/g,"&quot;");
}

/* ── PNG export ─────────────────────────────────────────────────────────────── */

/**
 * Render a Chart.js config on a hidden 1600×900 canvas and download as PNG.
 *
 * @param {function} buildConfig  - returns a Chart.js config object (called fresh each time)
 * @param {string}   filename     - download name without extension
 */
function _exportPng(buildConfig, filename) {
  const cfg = buildConfig();
  if (!cfg) return;   // null = no data loaded, nothing to export

  const W = cfg.width  || 1600;
  const H = cfg.height || 900;

  // Off-screen container — must be in the DOM for Chart.js to measure it
  const wrap = document.createElement("div");
  wrap.style.cssText =
    `position:fixed;left:-9999px;top:0;width:${W}px;height:${H}px;overflow:hidden;`;
  document.body.appendChild(wrap);

  const canvas = document.createElement("canvas");
  canvas.width  = W;
  canvas.height = H;
  wrap.appendChild(canvas);

  // Inline plugin: white background (Chart.js renders transparent by default)
  const bgPlugin = {
    id: "_exportBg",
    beforeDraw(chart) {
      chart.ctx.save();
      chart.ctx.fillStyle = "#ffffff";
      chart.ctx.fillRect(0, 0, chart.width, chart.height);
      chart.ctx.restore();
    },
  };

  // Merge any extra plugins returned by the config builder
  const extraPlugins = Array.isArray(cfg.plugins) ? cfg.plugins : [];

  const chart = new Chart(canvas, {
    type:    cfg.type,
    data:    cfg.data,
    options: Object.assign({}, cfg.options, {
      animation:        false,
      responsive:       false,
      devicePixelRatio: 1,
    }),
    plugins: [bgPlugin, ...extraPlugins],
  });

  // Two rAF frames let Chart.js finish its synchronous draw pass
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const url = canvas.toDataURL("image/png");
    chart.destroy();
    document.body.removeChild(wrap);
    const a = document.createElement("a");
    a.href     = url;
    a.download = filename + ".png";
    a.click();
  }));
}

/** Sprint label derived from the currently selected sprint, safe for a filename. */
function _sprintSlug() {
  return (elSprintSelect.selectedOptions[0]?.text || "sprint")
    .replace(/[^a-z0-9]/gi, "_").toLowerCase();
}

/** Resolve the epic map for the current sprint: CSV column > state.epicMap > null. */
function _resolveEpicMap() {
  if (!state.sprintA) return null;
  const csvEpicCol = ["Epic Link", "Epic Name"].find(
    col => state.sprintA.length > 0 && col in state.sprintA[0]
  );
  if (csvEpicCol) {
    const map = {};
    for (const row of state.sprintA) {
      if (row["Issue Key"] && row[csvEpicCol]) map[row["Issue Key"]] = row[csvEpicCol];
    }
    return Object.keys(map).length > 0 ? map : null;
  }
  return state.epicMap || null;
}

/* ── Shared export style constants ───────────────────────────────────────────── */

const _EXP = {
  font:    "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
  title:   { size: 30, weight: "700", color: "#1e293b" },
  sub:     { size: 18, weight: "500", color: "#64748b" },
  tick:    { size: 18, weight: "600", color: "#334155" },
  axTitle: { size: 20, weight: "700", color: "#334155" },
  nameY:   { size: 22, weight: "600", color: "#1e293b" },
  grid:    "#e2e8f0",
  gridY:   "#f1f5f9",
  pad:     { top: 20, right: 60, bottom: 20, left: 20 },
};

function _expTitleBlock(text, subtext) {
  return {
    title: {
      display: true,
      text:    text,
      font:    { size: _EXP.title.size, weight: _EXP.title.weight },
      color:   _EXP.title.color,
      padding: { bottom: subtext ? 6 : 28 },
    },
    subtitle: subtext ? {
      display: true,
      text:    subtext,
      font:    { size: _EXP.sub.size, weight: _EXP.sub.weight },
      color:   _EXP.sub.color,
      padding: { bottom: 28 },
    } : { display: false },
    legend:  { display: false },
    tooltip: { enabled: false },
  };
}

function _expHorizScales(xMax) {
  return {
    x: Object.assign(
      { ticks: { font: { size: _EXP.tick.size, weight: _EXP.tick.weight }, color: _EXP.tick.color, callback: v => `${v}h` },
        grid:  { color: _EXP.grid, lineWidth: 1.5 },
        title: { display: true, text: "Hours",
                 font: { size: _EXP.axTitle.size, weight: _EXP.axTitle.weight },
                 color: _EXP.axTitle.color } },
      xMax != null ? { max: xMax } : {}
    ),
    y: {
      ticks: { font: { size: _EXP.nameY.size, weight: _EXP.nameY.weight }, color: _EXP.nameY.color },
      grid:  { color: _EXP.gridY, lineWidth: 1 },
    },
  };
}

/* ── Export: By Member — donut ───────────────────────────────────────────────── */

function _buildMemberDonutExportConfig() {
  if (!state.sprintA) return null;
  const byMember  = aggregateByMember(state.sprintA);
  const sorted    = Object.entries(byMember).sort(([, a], [, b]) => b - a);
  const names     = sorted.map(([n]) => n);
  const secs      = sorted.map(([, s]) => s);
  const colors    = names.map(memberColor);
  const totalSecs = secs.reduce((a, b) => a + b, 0);

  return {
    type: "doughnut",
    data: {
      labels: names,
      datasets: [{
        data:            secs.map(s => +(s / 3600).toFixed(2)),
        backgroundColor: colors.map(c => _rgba(c, 0.65)),
        borderColor:     colors,
        borderWidth:     4,
      }],
    },
    options: {
      layout: { padding: 48 },
      plugins: {
        ..._expTitleBlock("Hours by Member", _sprintSlug().replace(/_/g, " ")),
        legend: {
          display:  true,
          position: "bottom",
          labels: {
            font: { size: 20 }, boxWidth: 20, padding: 24, color: "#1e293b",
            generateLabels: () => names.map((name, i) => {
              const pct = totalSecs > 0 ? Math.round((secs[i] / totalSecs) * 100) : 0;
              return {
                text:        `${name}   ${formatHours(secs[i])}  (${pct}%)`,
                fillStyle:   _rgba(colors[i], 0.65),
                strokeStyle: colors[i],
                lineWidth:   2,
                hidden:      false,
                index:       i,
              };
            }),
          },
        },
      },
    },
  };
}

/* ── Export: By Member — bar ─────────────────────────────────────────────────── */

function _buildMemberBarExportConfig() {
  if (!state.sprintA) return null;
  const byMember = aggregateByMember(state.sprintA);
  const sorted   = Object.entries(byMember).sort(([, a], [, b]) => b - a);
  const names    = sorted.map(([n]) => n);
  const secs     = sorted.map(([, s]) => s);
  const colors   = names.map(memberColor);

  return {
    type: "bar",
    data: {
      labels: names,
      datasets: [{
        data:            secs.map(s => +(s / 3600).toFixed(2)),
        backgroundColor: colors.map(c => _rgba(c, 0.55)),
        borderColor:     colors,
        borderWidth:     4,
        borderRadius:    6,
        borderSkipped:   false,
      }],
    },
    options: {
      indexAxis: "y",
      layout:    { padding: _EXP.pad },
      plugins:   _expTitleBlock("Member Breakdown"),
      scales:    _expHorizScales(),
    },
  };
}

/* ── Export: By Member — drill-down ─────────────────────────────────────────── */

function _buildMemberDrillExportConfig(memberName) {
  if (!state.sprintA) return null;
  const issues = aggregateByIssue(state.sprintA.filter(r => r["Team Member"] === memberName));
  if (issues.length === 0) return null;

  const MAX = 56;
  const labels = issues.map(i => {
    const full = `${i.key} — ${i.description}`;
    return full.length > MAX ? full.slice(0, MAX - 1) + "…" : full;
  });
  const colors = issues.map(i => statusColor(i.status));
  const H = Math.max(900, 280 + issues.length * 48);

  return {
    type:   "bar",
    height: H,
    data: {
      labels,
      datasets: [{
        data:            issues.map(i => +(i.seconds / 3600).toFixed(2)),
        backgroundColor: colors.map(c => _rgba(c, 0.55)),
        borderColor:     colors,
        borderWidth:     4,
        borderRadius:    4,
        borderSkipped:   false,
      }],
    },
    options: {
      indexAxis: "y",
      layout:    { padding: _EXP.pad },
      plugins:   _expTitleBlock(`Drill-down: ${memberName}`),
      scales:    Object.assign(_expHorizScales(), {
        y: { ticks: { font: { size: 16, weight: "600" }, color: "#334155" }, grid: { color: _EXP.gridY, lineWidth: 1 } },
      }),
    },
  };
}

/* ── Export: By Issue ────────────────────────────────────────────────────────── */

function _buildIssueExportConfig() {
  if (!state.sprintA) return null;
  const issues = aggregateByIssue(state.sprintA);
  if (issues.length === 0) return null;

  const MAX = 58;
  const labels = issues.map(i => {
    const full = `${i.key} — ${i.description}`;
    return full.length > MAX ? full.slice(0, MAX - 1) + "…" : full;
  });
  const colors = issues.map(i => statusColor(i.status));
  const H = Math.max(900, 280 + issues.length * 44);

  return {
    type:   "bar",
    height: H,
    data: {
      labels,
      datasets: [{
        data:            issues.map(i => +(i.seconds / 3600).toFixed(2)),
        backgroundColor: colors.map(c => _rgba(c, 0.55)),
        borderColor:     colors,
        borderWidth:     4,
        borderRadius:    4,
        borderSkipped:   false,
      }],
    },
    options: {
      indexAxis: "y",
      layout:    { padding: _EXP.pad },
      plugins:   _expTitleBlock("Time by Issue"),
      scales:    Object.assign(_expHorizScales(), {
        y: { ticks: { font: { size: 15, weight: "600" }, color: "#334155" }, grid: { color: _EXP.gridY, lineWidth: 1 } },
      }),
    },
  };
}

/* ── Export: By Epic — totals bar ────────────────────────────────────────────── */

function _buildEpicBarExportConfig() {
  if (!state.sprintA) return null;
  const epicMap = _resolveEpicMap();
  if (!epicMap) return null;

  const byEpic      = aggregateByEpic(state.sprintA, epicMap);
  const epicsSorted = Object.entries(byEpic).sort(([, a], [, b]) => b - a);
  const epicNames   = epicsSorted.map(([n]) => n);
  const epicSecs    = epicsSorted.map(([, s]) => s);
  const epicColors  = epicNames.map((_, i) => PALETTE[i % PALETTE.length]);

  return {
    type: "bar",
    data: {
      labels: epicNames,
      datasets: [{
        data:            epicSecs.map(s => +(s / 3600).toFixed(2)),
        backgroundColor: epicColors.map(c => _rgba(c, 0.55)),
        borderColor:     epicColors,
        borderWidth:     4,
        borderRadius:    6,
        borderSkipped:   false,
      }],
    },
    options: {
      indexAxis: "y",
      layout:    { padding: _EXP.pad },
      plugins:   _expTitleBlock("Hours per Epic"),
      scales:    _expHorizScales(),
    },
  };
}

/* ── Export: By Epic — member grouped ───────────────────────────────────────── */

function _buildEpicGroupedExportConfig() {
  if (!state.sprintA) return null;
  const epicMap = _resolveEpicMap();
  if (!epicMap) return null;

  const byEpic     = aggregateByEpic(state.sprintA, epicMap);
  const epicNames  = Object.keys(byEpic).sort((a, b) => byEpic[b] - byEpic[a]);
  const byMember   = aggregateByMember(state.sprintA);
  const memberNames = Object.keys(byMember);

  const datasets = memberNames.map(name => {
    const memberRows = state.sprintA.filter(r => r["Team Member"] === name);
    const perEpic    = {};
    for (const row of memberRows) {
      const epic = epicMap[row["Issue Key"]] || "Unmapped";
      perEpic[epic] = (perEpic[epic] || 0) + row["Time Spent (s)"];
    }
    return {
      label:           name,
      data:            epicNames.map(e => +((perEpic[e] || 0) / 3600).toFixed(2)),
      backgroundColor: _rgba(memberColor(name), 0.55),
      borderColor:     memberColor(name),
      borderWidth:     4,
      borderRadius:    4,
      borderSkipped:   false,
    };
  });

  return {
    type: "bar",
    data: { labels: epicNames, datasets },
    options: {
      layout:  { padding: _EXP.pad },
      plugins: {
        ..._expTitleBlock("Epic × Member Breakdown"),
        legend: {
          display: true,
          labels:  { font: { size: 18, weight: "600" }, boxWidth: 18, padding: 20, color: "#1e293b" },
        },
      },
      scales: {
        x: { ticks: { font: { size: 18, weight: "600" }, color: "#334155" }, grid: { color: _EXP.grid, lineWidth: 1.5 } },
        y: {
          title: { display: true, text: "Hours",
                   font: { size: _EXP.axTitle.size, weight: _EXP.axTitle.weight },
                   color: _EXP.axTitle.color },
          ticks: { font: { size: 18, weight: "600" }, color: "#334155", callback: v => `${v}h` },
          grid:  { color: _EXP.grid, lineWidth: 1.5 },
        },
      },
    },
  };
}

/* ── Export: Compare ─────────────────────────────────────────────────────────── */

function _buildCompareExportConfig() {
  if (!state.sprintA || !state.sprintB) return null;
  const diff        = diffSprints(state.sprintA, state.sprintB);
  const memberNames = Object.keys(diff.members).sort();
  const dataA = memberNames.map(m => +(diff.members[m].a / 3600).toFixed(2));
  const dataB = memberNames.map(m => +(diff.members[m].b / 3600).toFixed(2));
  const labelA = elSprintSelect.selectedOptions[0]?.text  || "Sprint A";
  const labelB = elSprintBSelect.selectedOptions[0]?.text || "Sprint B";

  return {
    type: "bar",
    data: {
      labels: memberNames,
      datasets: [
        { label: labelA, data: dataA,
          backgroundColor: _rgba("#7eb8f7", 0.55), borderColor: "#7eb8f7",
          borderWidth: 4, borderRadius: 4, borderSkipped: false },
        { label: labelB, data: dataB,
          backgroundColor: _rgba("#6dd9a8", 0.55), borderColor: "#6dd9a8",
          borderWidth: 4, borderRadius: 4, borderSkipped: false },
      ],
    },
    options: {
      layout:  { padding: { top: 20, right: 48, bottom: 20, left: 20 } },
      plugins: {
        ..._expTitleBlock("Sprint Comparison — Hours per Member", `${labelA}  ·  ${labelB}`),
        legend: {
          display: true,
          labels:  { font: { size: 20, weight: "600" }, boxWidth: 20, padding: 24, color: "#1e293b" },
        },
      },
      scales: {
        x: { ticks: { font: { size: 18, weight: "600" }, color: "#334155" }, grid: { color: _EXP.grid, lineWidth: 1.5 } },
        y: {
          title: { display: true, text: "Hours",
                   font: { size: _EXP.axTitle.size, weight: _EXP.axTitle.weight },
                   color: _EXP.axTitle.color },
          ticks: { font: { size: 18, weight: "600" }, color: "#334155", callback: v => `${v}h` },
          grid:  { color: _EXP.grid, lineWidth: 1.5 },
        },
      },
    },
  };
}

/* ── Export: Timeline chart ──────────────────────────────────────────────────── */

function _buildTimelineExportConfig() {
  if (!state.sprintA) return null;
  const { dates, members } = aggregateByDay(state.sprintA);
  if (dates.length === 0) return null;

  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const xLabels = dates.map(iso => {
    const [, mm, dd] = iso.split("-").map(Number);
    return `${MONTHS[mm - 1]} ${dd}`;
  });

  const datasets = Object.entries(members).map(([name, secArr]) => ({
    label:           name,
    data:            secArr.map(s => +(s / 3600).toFixed(2)),
    backgroundColor: _rgba(memberColor(name), 0.65),
    borderColor:     memberColor(name),
    borderWidth:     3,
  }));

  return {
    type: "bar",
    data: { labels: xLabels, datasets },
    options: {
      layout: { padding: { top: 20, right: 40, bottom: 20, left: 20 } },
      plugins: {
        title: {
          display: true,
          text:    "Daily Hours by Member",
          font:    { size: _EXP.title.size, weight: _EXP.title.weight },
          color:   _EXP.title.color,
          padding: { bottom: 6 },
        },
        subtitle: {
          display: true,
          text:    _sprintSlug().replace(/_/g, " "),
          font:    { size: _EXP.sub.size, weight: _EXP.sub.weight },
          color:   _EXP.sub.color,
          padding: { bottom: 24 },
        },
        legend: {
          labels: { font: { size: 20, weight: "600" }, boxWidth: 20, padding: 20, color: "#1e293b" },
        },
        tooltip: { enabled: false },
      },
      scales: {
        x: {
          stacked: true,
          ticks: { font: { size: 18, weight: "600" }, color: "#334155", maxRotation: 45 },
          grid:  { color: _EXP.grid, lineWidth: 1.5 },
        },
        y: {
          stacked: true,
          title: { display: true, text: "Hours",
                   font: { size: _EXP.axTitle.size, weight: _EXP.axTitle.weight },
                   color: _EXP.axTitle.color },
          ticks: { font: { size: 18, weight: "600" }, color: "#334155", callback: v => `${v}h` },
          grid:  { color: _EXP.grid, lineWidth: 1.5 },
        },
      },
    },
  };
}

/* ── Export: Capacity chart ──────────────────────────────────────────────────── */

function _buildCapacityExportConfig() {
  if (!state.sprintA) return null;
  const { budgetSecs, members, weeks } = computeCapacity(state.sprintA, 8, state.sprintLengthWeeks);
  if (members.length === 0) return null;

  const budgetHrs = +(budgetSecs / 3600).toFixed(2);
  const names     = members.map(m => m.name);
  const worked    = members.map(m => +(m.workedSecs / 3600).toFixed(2));
  const maxHrs    = Math.max(budgetHrs, ...worked);
  const xMax      = +(maxHrs * 1.32).toFixed(1);

  const STATUS_CLR = { over: "#ef4444", exact: "#3b82f6", under: "#22c55e" };
  const colors     = members.map(m => STATUS_CLR[m.status] || "#94a3b8");

  // Enough vertical space: 100 px per row minimum, at least 900
  const H          = Math.max(900, 280 + members.length * 100);

  // Right-padding layout — split into two zones drawn by the plugin:
  //   • hours zone  (140 px): "Xh Ym / Xh Ym"
  //   • badge zone  (190 px): status pill
  const HOURS_ZONE = 150;
  const BADGE_W    = 178;
  const BADGE_PAD  = 16;
  const RIGHT_PAD  = HOURS_ZONE + BADGE_W + BADGE_PAD + 8;  // total right layout padding

  const labelsPlugin = {
    id: "_capLabels",
    afterDraw(chart) {
      const { ctx, chartArea, scales: { x } } = chart;
      const { top, bottom, right } = chartArea;
      ctx.save();

      // ── Dashed budget line ──────────────────────────────────────────────────
      const bx = x.getPixelForValue(budgetHrs);
      ctx.setLineDash([12, 6]);
      ctx.strokeStyle = "#94a3b8";
      ctx.lineWidth   = 2.5;
      ctx.beginPath(); ctx.moveTo(bx, top); ctx.lineTo(bx, bottom); ctx.stroke();
      ctx.setLineDash([]);

      // Label above budget line
      ctx.font      = `700 18px ${_EXP.font}`;
      ctx.fillStyle = "#94a3b8";
      ctx.textAlign = "center";
      ctx.fillText(`Budget: ${formatHours(budgetSecs)}`, bx, top - 16);

      // ── Per-row labels ──────────────────────────────────────────────────────
      const meta = chart.getDatasetMeta(0);
      members.forEach((m, i) => {
        const bar   = meta.data[i];
        const barY  = bar.y;
        const color = colors[i];

        // Hours text — always starts at right+10 (inside right-padding zone)
        const hoursText = `${formatHours(m.workedSecs)} / ${formatHours(budgetSecs)}`;
        ctx.font      = `600 18px ${_EXP.font}`;
        ctx.fillStyle = "#334155";
        ctx.textAlign = "left";
        ctx.fillText(hoursText, right + 10, barY);

        // Status badge pill
        const BADGE_H = 34;
        const badgeX  = right + HOURS_ZONE;
        const badgeY  = barY - BADGE_H / 2;

        // Pill background
        ctx.beginPath();
        ctx.fillStyle = color + "28";
        if (ctx.roundRect) ctx.roundRect(badgeX, badgeY, BADGE_W, BADGE_H, 8);
        else               ctx.rect(badgeX, badgeY, BADGE_W, BADGE_H);
        ctx.fill();

        // Pill text
        const badgeText =
          m.status === "over"  ? `+${formatHours(Math.abs(m.remainingSecs))} over`  :
          m.status === "under" ? `${formatHours(m.remainingSecs)} left` : "on target";
        ctx.font      = `700 17px ${_EXP.font}`;
        ctx.fillStyle = color;
        ctx.textAlign = "center";
        ctx.fillText(badgeText, badgeX + BADGE_W / 2, barY + 1);
      });

      ctx.restore();
    },
  };

  return {
    type:    "bar",
    width:   1600,
    height:  H,
    plugins: [labelsPlugin],
    data: {
      labels: names,
      datasets: [{
        data:            worked,
        backgroundColor: colors.map(c => c + "44"),
        borderColor:     colors,
        borderWidth:     4,
        borderRadius:    6,
        borderSkipped:   false,
      }],
    },
    options: {
      indexAxis: "y",
      layout: { padding: { top: 60, right: RIGHT_PAD, bottom: 28, left: 24 } },
      plugins: {
        title: {
          display: true,
          text:    "Capacity — Per-Member Hours",
          font:    { size: _EXP.title.size, weight: _EXP.title.weight },
          color:   _EXP.title.color,
          padding: { bottom: 6 },
        },
        subtitle: {
          display: true,
          text:    `${weeks} week${weeks !== 1 ? "s" : ""} · ${formatHours(budgetSecs)} budget / person`,
          font:    { size: _EXP.sub.size },
          color:   _EXP.sub.color,
          padding: { bottom: 32 },
        },
        legend:  { display: false },
        tooltip: { enabled: false },
      },
      scales: {
        x: {
          max:   xMax,
          title: { display: true, text: "Hours",
                   font: { size: _EXP.axTitle.size, weight: _EXP.axTitle.weight },
                   color: _EXP.axTitle.color },
          ticks: { font: { size: 18, weight: "600" }, color: "#334155", callback: v => `${v}h` },
          grid:  { color: _EXP.grid, lineWidth: 1.5 },
        },
        y: {
          ticks: { font: { size: 22, weight: "600" }, color: "#1e293b" },
          grid:  { color: _EXP.gridY, lineWidth: 1 },
        },
      },
    },
  };
}

/* ── Capacity helpers ───────────────────────────────────────────────────────── */

/**
 * Count the number of distinct ISO Mon–Sun weeks that contain at least one worklog.
 * Returns an integer (0, 1, 2, …).
 */
function sprintWeeks(rows) {
  const weeks = new Set();
  for (const row of rows) {
    const raw = row["Last Updated"];
    if (!raw) continue;
    const d   = new Date(parseDate(raw) + "T00:00:00Z");
    // Roll back to the Monday of this day's week
    const dow    = d.getUTCDay();                   // 0=Sun … 6=Sat
    const offset = dow === 0 ? -6 : 1 - dow;       // days to Monday
    const mon    = new Date(d.getTime() + offset * 86_400_000);
    weeks.add(mon.toISOString().slice(0, 10));      // "YYYY-MM-DD" of that Monday
  }
  return weeks.size;
}

/**
 * Calculate per-member capacity: budget vs actual.
 *
 * @param {Array}  rows          - sprint worklog rows
 * @param {number} hoursPerWeek  - weekly hour budget per person (default 8)
 * @returns {{
 *   weeks: number,
 *   budgetSecs: number,
 *   members: Array<{name, workedSecs, budgetSecs, remainingSecs, status}>
 * }}
 */
function computeCapacity(rows, hoursPerWeek = 8, overrideWeeks = null) {
  const weeks      = overrideWeeks != null ? overrideWeeks : sprintWeeks(rows);
  const budgetSecs = hoursPerWeek * weeks * 3600;
  const byMember   = aggregateByMember(rows);

  const members = Object.entries(byMember).map(([name, workedSecs]) => {
    const remainingSecs = budgetSecs - workedSecs;
    const status = remainingSecs > 0 ? "under" : remainingSecs < 0 ? "over" : "exact";
    return { name, workedSecs, budgetSecs, remainingSecs, status };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return { weeks, budgetSecs, members };
}

/* ── Project burn-down helpers ───────────────────────────────────────────────── */

/**
 * Aggregate all rows into per-week cumulative hours per category over a
 * PROJECT_WEEKS-wide timeline.  Week 1 starts on the Monday of the week that
 * contains the earliest worklog entry.
 */
function computeProjectBurn(rows) {
  if (!rows || rows.length === 0) return null;

  const MS_DAY  = 86_400_000;
  const MS_WEEK = 7 * MS_DAY;

  // Find project start: Monday of the week with the earliest entry
  const timestamps = rows
    .map(r => r["Last Updated"])
    .filter(Boolean)
    .map(s => new Date(parseDate(s) + "T00:00:00Z").getTime())
    .filter(t => !isNaN(t));
  if (timestamps.length === 0) return null;

  const minTs = Math.min(...timestamps);
  const dow   = new Date(minTs).getUTCDay();           // 0=Sun … 6=Sat
  const back  = dow === 0 ? -6 : 1 - dow;             // days back to Monday
  const projStartTs = minTs + back * MS_DAY;

  // Collect per-week per-category seconds (raw, non-cumulative)
  const allCatsSet = new Set();
  const weekData   = Array.from({ length: PROJECT_WEEKS }, () => ({}));

  for (const row of rows) {
    const raw = row["Last Updated"];
    if (!raw) continue;
    const ts = new Date(parseDate(raw) + "T00:00:00Z").getTime();
    if (isNaN(ts)) continue;
    const weekIdx = Math.floor((ts - projStartTs) / MS_WEEK);
    if (weekIdx < 0 || weekIdx >= PROJECT_WEEKS) continue;
    const cat  = row["Fix version"] || "_unknown";
    const secs = Number(row["Time Spent (s)"]) || 0;
    allCatsSet.add(cat);
    weekData[weekIdx][cat] = (weekData[weekIdx][cat] || 0) + secs;
  }

  // Ordered categories: defined CATEGORIES first, then extras, then _unknown
  const extraCats = [...allCatsSet].filter(c => !CATEGORIES.includes(c) && c !== "_unknown");
  const usedCats  = [
    ...CATEGORIES.filter(c => allCatsSet.has(c)),
    ...extraCats,
    ...(allCatsSet.has("_unknown") ? ["_unknown"] : []),
  ];

  // Build cumulative hour arrays per category
  const catCumHrs = {};
  usedCats.forEach(cat => {
    let running = 0;
    catCumHrs[cat] = weekData.map(wd => {
      running += (wd[cat] || 0) / 3600;
      return +running.toFixed(2);
    });
  });

  // Total cumulative
  let runningTotal = 0;
  const totalCumHrs = weekData.map(wd => {
    runningTotal += Object.values(wd).reduce((s, v) => s + v, 0) / 3600;
    return +runningTotal.toFixed(2);
  });

  // Week labels: "W1 (Feb 19)", "W2 (Feb 26)", …
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const weekLabels = Array.from({ length: PROJECT_WEEKS }, (_, i) => {
    const d = new Date(projStartTs + i * MS_WEEK);
    return `W${i + 1} (${MON[d.getUTCMonth()]} ${d.getUTCDate()})`;
  });

  return { weekLabels, catCumHrs, usedCats, totalCumHrs };
}

function _renderProjectBurnChart(burnEl, allRows) {
  if (charts["project-burn"]) { charts["project-burn"].destroy(); delete charts["project-burn"]; }

  const result = computeProjectBurn(allRows);
  if (!result) {
    burnEl.innerHTML = `<p style="color:var(--text-muted);padding:16px 0;font-size:.875rem">No worklog data found across all files.</p>`;
    return;
  }

  const { weekLabels, catCumHrs, usedCats, totalCumHrs } = result;

  // Linear budget pace: week i (1-indexed) → (i / PROJECT_WEEKS) * PROJECT_BUDGET_HRS
  const budgetLine = Array.from({ length: PROJECT_WEEKS }, (_, i) =>
    +((i + 1) * PROJECT_BUDGET_HRS / PROJECT_WEEKS).toFixed(1)
  );

  // Category datasets (cumulative lines, coloured, filled lightly under each)
  const datasets = usedCats.map(cat => {
    const color = CATEGORY_COLORS[cat] || CATEGORY_COLORS._unknown;
    return {
      label: cat === "_unknown" ? "Other" : cat,
      data:  catCumHrs[cat],
      borderColor: color,
      backgroundColor: _rgba(color, 0.12),
      borderWidth: 2,
      fill:    "origin",
      tension: 0.35,
      pointRadius: 2,
      pointHoverRadius: 5,
    };
  });

  // Total cumulative line (dark, bold)
  datasets.push({
    label: "Total",
    data:  totalCumHrs,
    borderColor: "#1e293b",
    backgroundColor: "transparent",
    borderWidth: 2.5,
    fill:    false,
    tension: 0.35,
    pointRadius: 2,
    pointHoverRadius: 5,
    order: -2,
  });

  // Budget pace line (dashed grey)
  datasets.push({
    label: `Budget (${PROJECT_BUDGET_HRS}h pace)`,
    data:  budgetLine,
    borderColor: "#94a3b8",
    backgroundColor: "transparent",
    borderWidth: 1.5,
    borderDash: [8, 4],
    fill:    false,
    tension: 0,
    pointRadius: 0,
    pointHoverRadius: 0,
    order: -1,
  });

  const burnLegendHtml = [
    ...usedCats.map(cat => {
      const color = CATEGORY_COLORS[cat] || CATEGORY_COLORS._unknown;
      const label = cat === "_unknown" ? "Other" : cat;
      return `<span class="cap-legend-item" style="--cat-clr:${color}">${_escHtml(label)}</span>`;
    }),
    `<span class="cap-legend-item" style="--cat-clr:#1e293b">Total</span>`,
    `<span class="cap-legend-item" style="--cat-clr:#94a3b8">Budget pace</span>`,
  ].join("");

  burnEl.innerHTML = `
    <div class="cap-legend">${burnLegendHtml}</div>
    <canvas id="canvas-project-burn"></canvas>`;

  charts["project-burn"] = new Chart(
    document.getElementById("canvas-project-burn"),
    {
      type: "line",
      data: { labels: weekLabels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        aspectRatio: 3,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: {
            ticks: { font: { size: 11 }, maxRotation: 40, minRotation: 40 },
          },
          y: {
            min: 0,
            max: Math.ceil(PROJECT_BUDGET_HRS * 1.1 / 50) * 50,
            title: { display: true, text: "Cumulative hours", font: { size: 11 }, color: "#64748b" },
            ticks: { callback: v => `${v}h`, font: { size: 11 } },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y}h`,
            },
          },
        },
      },
    }
  );
}

async function _renderProjectBurnAsync() {
  const burnEl = document.getElementById("project-burn-content");
  if (!burnEl) return;
  if (!state.allWorklogs) {
    state.allWorklogs = await _loadAllWorklogs();
  }
  _renderProjectBurnChart(burnEl, state.allWorklogs);
}

async function _renderProjectCapacityAsync() {
  const el = document.getElementById("project-cap-content");
  if (!el) return;
  if (!state.allWorklogs) {
    state.allWorklogs = await _loadAllWorklogs();
  }
  const rows = state.allWorklogs;
  if (!rows || rows.length === 0) {
    el.innerHTML = `<p style="color:var(--text-muted);font-size:.875rem">No data available.</p>`;
    return;
  }

  const { members } = computeCapacity(rows, 8, PROJECT_WEEKS);
  const byMemberCat = aggregateByMemberCategory(rows);

  const memberRowsHtml = members.map(({ name, workedSecs, budgetSecs: bSecs, remainingSecs, status }) => {
    const pct     = bSecs > 0 ? Math.min(workedSecs / bSecs, 1) * 100 : 0;
    const overPct = bSecs > 0 && workedSecs > bSecs
      ? ((workedSecs - bSecs) / bSecs) * 100
      : 0;

    const catData = byMemberCat[name] || {};
    const allCats = [...CATEGORIES, ...(Object.keys(catData).filter(c => !CATEGORIES.includes(c) && c !== "_unknown"))];
    const unknownSecs = catData["_unknown"] || 0;
    const segHtml = [
      ...allCats.map(cat => {
        const secs = catData[cat] || 0;
        if (!secs) return "";
        const w = workedSecs > 0 ? (secs / workedSecs) * pct : 0;
        const color = CATEGORY_COLORS[cat] || CATEGORY_COLORS._unknown;
        return `<div class="cap-bar-segment" style="width:${w.toFixed(2)}%;background:${color}" title="${cat}: ${formatHours(secs)}"></div>`;
      }),
      unknownSecs ? (() => {
        const w = workedSecs > 0 ? (unknownSecs / workedSecs) * pct : 0;
        return `<div class="cap-bar-segment" style="width:${w.toFixed(2)}%;background:${CATEGORY_COLORS._unknown}" title="Uncategorised: ${formatHours(unknownSecs)}"></div>`;
      })() : "",
    ].join("");

    const remainLabel = status === "over"
      ? `+${formatHours(Math.abs(remainingSecs))} over`
      : status === "under"
        ? `${formatHours(remainingSecs)} left`
        : "exact";
    const badgeCls = `cap-badge cap-badge--${status}`;

    return `
      <div class="cap-row">
        <span class="cap-name" title="${_escAttr(name)}">${_escHtml(name)}</span>
        <div class="cap-bar-wrap">
          <div class="cap-bar-bg">
            ${segHtml}
            ${overPct > 0 ? `<div class="cap-bar-over" style="width:${Math.min(overPct, 40).toFixed(1)}%"></div>` : ""}
          </div>
          <span class="cap-bar-budget-marker" title="Budget: ${formatHours(bSecs)}"></span>
        </div>
        <span class="cap-hours">${formatHours(workedSecs)} / ${formatHours(bSecs)}</span>
        <span class="${badgeCls}">${remainLabel}</span>
      </div>`;
  }).join("");

  el.innerHTML = `
    <div class="cap-legend">
      ${CATEGORIES.map(c => `<span class="cap-legend-item" style="--cat-clr:${CATEGORY_COLORS[c]}">${c}</span>`).join("")}
      <span style="flex:1"></span>
      <span class="cap-legend-item cap-legend-item--under">Under budget</span>
      <span class="cap-legend-item cap-legend-item--over">Over budget</span>
      <span class="cap-legend-item cap-legend-item--exact">On target</span>
    </div>
    <div class="cap-rows">
      ${memberRowsHtml}
    </div>`;
}

/* ── View: Capacity ─────────────────────────────────────────────────────────── */

function renderCapacity() {
  const el = document.getElementById("capacity-content");
  if (!el) return;

  if (!state.sprintA) { el.innerHTML = ""; return; }

  const autoWeeks = sprintWeeks(state.sprintA);
  const { weeks, budgetSecs, members } = computeCapacity(state.sprintA, 8, state.sprintLengthWeeks);

  if (members.length === 0) {
    el.innerHTML = `<div class="chart-card"><p>No worklog data available.</p></div>`;
    return;
  }

  const totalWorkedSecs = members.reduce((s, m) => s + m.workedSecs, 0);
  const totalBudgetSecs = budgetSecs * members.length;
  const totalRemaining  = totalBudgetSecs - totalWorkedSecs;
  const totalStatus     = totalRemaining > 0 ? "under" : totalRemaining < 0 ? "over" : "exact";

  // ── Summary stat cards ──
  const weeksLabel = weeks > 0 ? `${weeks}w` : "—";

  // ── Per-member category breakdown ──
  const byMemberCat = aggregateByMemberCategory(state.sprintA);

  // ── Per-member rows ──
  const memberRowsHtml = members.map(({ name, workedSecs, budgetSecs: bSecs, remainingSecs, status }) => {
    const pct     = bSecs > 0 ? Math.min(workedSecs / bSecs, 1) * 100 : 0;
    const overPct = bSecs > 0 && workedSecs > bSecs
      ? ((workedSecs - bSecs) / bSecs) * 100
      : 0;

    // Build stacked category segments proportional to filled bar area
    const catData = byMemberCat[name] || {};
    const allCats = [...CATEGORIES, ...(Object.keys(catData).filter(c => !CATEGORIES.includes(c) && c !== "_unknown"))];
    const unknownSecs = catData["_unknown"] || 0;
    const segHtml = [
      ...allCats.map(cat => {
        const secs = catData[cat] || 0;
        if (!secs) return "";
        const w = workedSecs > 0 ? (secs / workedSecs) * pct : 0;
        const color = CATEGORY_COLORS[cat] || CATEGORY_COLORS._unknown;
        return `<div class="cap-bar-segment" style="width:${w.toFixed(2)}%;background:${color}" title="${cat}: ${formatHours(secs)}"></div>`;
      }),
      unknownSecs ? (() => {
        const w = workedSecs > 0 ? (unknownSecs / workedSecs) * pct : 0;
        return `<div class="cap-bar-segment" style="width:${w.toFixed(2)}%;background:${CATEGORY_COLORS._unknown}" title="Uncategorised: ${formatHours(unknownSecs)}"></div>`;
      })() : "",
    ].join("");

    const remainLabel = status === "over"
      ? `+${formatHours(Math.abs(remainingSecs))} over`
      : status === "under"
        ? `${formatHours(remainingSecs)} left`
        : "exact";
    const badgeCls = `cap-badge cap-badge--${status}`;

    return `
      <div class="cap-row">
        <span class="cap-name" title="${_escAttr(name)}">${_escHtml(name)}</span>
        <div class="cap-bar-wrap">
          <div class="cap-bar-bg">
            ${segHtml}
            ${overPct > 0 ? `<div class="cap-bar-over" style="width:${Math.min(overPct, 40).toFixed(1)}%"></div>` : ""}
          </div>
          <span class="cap-bar-budget-marker" title="Budget: ${formatHours(bSecs)}"></span>
        </div>
        <span class="cap-hours">${formatHours(workedSecs)} / ${formatHours(bSecs)}</span>
        <span class="${badgeCls}">${remainLabel}</span>
      </div>`;
  }).join("");

  // ── Category totals ──
  const catTotals = aggregateByCategoryTotal(state.sprintA);
  const catCardsHtml = [...CATEGORIES, ...(Object.keys(catTotals).filter(c => !CATEGORIES.includes(c) && c !== "_unknown"))].map(cat => {
    const secs = catTotals[cat] || 0;
    if (!secs) return "";
    const color = CATEGORY_COLORS[cat] || CATEGORY_COLORS._unknown;
    return `
      <div class="stat-card">
        <div class="stat-label">
          <span class="cat-swatch" style="background:${color}"></span>${cat}
        </div>
        <div class="stat-value">${formatHours(secs)}</div>
      </div>`;
  }).join("") + (catTotals["_unknown"] ? `
      <div class="stat-card">
        <div class="stat-label">
          <span class="cat-swatch" style="background:${CATEGORY_COLORS._unknown}"></span>Uncategorised
        </div>
        <div class="stat-value">${formatHours(catTotals["_unknown"])}</div>
      </div>` : "");

  const totalRemainLabel = totalStatus === "over"
    ? `+${formatHours(Math.abs(totalRemaining))} over budget`
    : totalStatus === "under"
      ? `${formatHours(totalRemaining)} remaining`
      : "Exactly on budget";

  const isOverriding = state.sprintLengthWeeks !== null;
  const resetBtn = isOverriding
    ? `<button id="cap-reset-len" class="cap-settings-reset" title="Revert to auto-detected (${autoWeeks}w)">↺ auto</button>`
    : `<span class="cap-settings-hint">auto-detected</span>`;

  // ── Print-only table ──────────────────────────────────────────────────────
  const STATUS_BG  = { over: "#fee2e2", exact: "#dbeafe", under: "#dcfce7" };
  const STATUS_CLR = { over: "#dc2626", exact: "#1e40af", under: "#166534" };
  const sprintLabel = elSprintSelect.selectedOptions[0]?.text || "Sprint";

  const usedCatsSet = new Set();
  members.forEach(({ name }) => {
    const cd = byMemberCat[name] || {};
    CATEGORIES.forEach(c => { if (cd[c]) usedCatsSet.add(c); });
    Object.keys(cd).filter(c => !CATEGORIES.includes(c) && c !== "_unknown").forEach(c => usedCatsSet.add(c));
  });
  const usedCats   = [...usedCatsSet];
  const hasUnknown = members.some(({ name }) => !!(byMemberCat[name] || {})["_unknown"]);

  const catPrintHeadersHtml = usedCats.map(cat => {
    const clr = CATEGORY_COLORS[cat] || CATEGORY_COLORS._unknown;
    return `<th class="cap-pt-th cap-pt-th-num"><span class="cap-pt-swatch" style="background:${clr}"></span>${_escHtml(cat)}</th>`;
  }).join("") + (hasUnknown
    ? `<th class="cap-pt-th cap-pt-th-num"><span class="cap-pt-swatch" style="background:${CATEGORY_COLORS._unknown}"></span>Other</th>`
    : "");

  const printRowsHtml = members.map(({ name, workedSecs, budgetSecs: bSecs, remainingSecs, status }) => {
    const cd     = byMemberCat[name] || {};
    const pct    = bSecs > 0 ? Math.round((workedSecs / bSecs) * 100) : 0;
    const remLbl = status === "over"
      ? `+${formatHours(Math.abs(remainingSecs))} over`
      : status === "under" ? `${formatHours(remainingSecs)} left` : "On target";
    const catCells = usedCats.map(cat => {
      const secs = cd[cat] || 0;
      const clr  = CATEGORY_COLORS[cat] || CATEGORY_COLORS._unknown;
      return `<td class="cap-pt-cat" style="color:${clr}">${secs ? formatHours(secs) : '<span class="cap-pt-zero">—</span>'}</td>`;
    }).join("") + (hasUnknown
      ? `<td class="cap-pt-cat" style="color:${CATEGORY_COLORS._unknown}">${cd["_unknown"] ? formatHours(cd["_unknown"]) : '<span class="cap-pt-zero">—</span>'}</td>`
      : "");
    return `<tr class="cap-pt-row">
      <td class="cap-pt-name">${_escHtml(name)}</td>
      <td class="cap-pt-num">${formatHours(workedSecs)}</td>
      <td class="cap-pt-num">${formatHours(bSecs)}</td>
      <td class="cap-pt-num cap-pt-pct">${pct}%</td>
      ${catCells}
      <td class="cap-pt-status" style="background:${STATUS_BG[status]};color:${STATUS_CLR[status]}">${remLbl}</td>
    </tr>`;
  }).join("");

  const catTotalPrintCells = usedCats.map(cat => {
    const secs = catTotals[cat] || 0;
    const clr  = CATEGORY_COLORS[cat] || CATEGORY_COLORS._unknown;
    return `<td class="cap-pt-cat" style="color:${clr}">${secs ? formatHours(secs) : "—"}</td>`;
  }).join("") + (hasUnknown
    ? `<td class="cap-pt-cat" style="color:${CATEGORY_COLORS._unknown}">${catTotals["_unknown"] ? formatHours(catTotals["_unknown"]) : "—"}</td>`
    : "");
  const totalPct = totalBudgetSecs > 0 ? Math.round((totalWorkedSecs / totalBudgetSecs) * 100) : 0;

  el.innerHTML = `
    <div class="cap-settings">
      <label for="cap-sprint-len" class="cap-settings-label">Sprint length</label>
      <input type="number" id="cap-sprint-len" class="cap-settings-input"
             min="1" max="52" step="1" value="${weeks}" />
      <span class="cap-settings-unit">weeks</span>
      ${resetBtn}
    </div>

    <div class="card-grid">
      <div class="stat-card">
        <div class="stat-label">Sprint Length</div>
        <div class="stat-value">${weeksLabel}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Budget / Person</div>
        <div class="stat-value">${formatHours(budgetSecs)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Budget</div>
        <div class="stat-value">${formatHours(totalBudgetSecs)}</div>
      </div>
      <div class="stat-card stat-card--${totalStatus}">
        <div class="stat-label">Team Balance</div>
        <div class="stat-value">${totalRemainLabel}</div>
      </div>
    </div>

    <div class="chart-card">
      <div class="chart-card-header">
        <h3>Time by Category — Sprint Total</h3>
      </div>
      <div class="card-grid">
        ${catCardsHtml}
        <div class="stat-card stat-card--${totalStatus}">
          <div class="stat-label">Team Balance</div>
          <div class="stat-value">${totalRemainLabel}</div>
        </div>
      </div>
    </div>

    <div class="chart-card">
      <div class="chart-card-header">
        <h3>Cumulative Project Burn-down — ${PROJECT_WEEKS} weeks / ${PROJECT_BUDGET_HRS}h total</h3>
      </div>
      <div id="project-burn-content" style="min-height:60px">
        <p style="color:var(--text-muted);font-size:.875rem">Loading all sprint data…</p>
      </div>
    </div>

    <div class="chart-card">
      <div class="chart-card-header">
        <h3>Per-Member Capacity — All Sprints (8 h/week × ${PROJECT_WEEKS}w / 120h total)</h3>
      </div>
      <div id="project-cap-content" style="min-height:60px">
        <p style="color:var(--text-muted);font-size:.875rem">Loading all sprint data…</p>
      </div>
    </div>

    <div class="chart-card">
      <div class="chart-card-header">
        <h3>Per-Member Capacity (8 h/week × ${weeks}w budget)</h3>
      </div>
      <div class="cap-legend">
        ${CATEGORIES.map(c => `<span class="cap-legend-item" style="--cat-clr:${CATEGORY_COLORS[c]}">${c}</span>`).join("")}
        <span style="flex:1"></span>
        <span class="cap-legend-item cap-legend-item--under">Under budget</span>
        <span class="cap-legend-item cap-legend-item--over">Over budget</span>
        <span class="cap-legend-item cap-legend-item--exact">On target</span>
      </div>
      <div class="cap-rows">
        ${memberRowsHtml}
      </div>
    </div>

    <div class="cap-print-only">
      <div class="cap-print-header">
        <h2 class="cap-print-title">Per-Member Capacity — ${_escHtml(sprintLabel)}</h2>
        <p class="cap-print-meta">${weeks} week${weeks !== 1 ? "s" : ""} &nbsp;·&nbsp; Budget ${formatHours(budgetSecs)} / person &nbsp;·&nbsp; ${members.length} members</p>
      </div>
      <table class="cap-print-table">
        <thead>
          <tr>
            <th class="cap-pt-th">Member</th>
            <th class="cap-pt-th cap-pt-th-num">Worked</th>
            <th class="cap-pt-th cap-pt-th-num">Budget</th>
            <th class="cap-pt-th cap-pt-th-num">Used %</th>
            ${catPrintHeadersHtml}
            <th class="cap-pt-th cap-pt-th-status">Status</th>
          </tr>
        </thead>
        <tbody>
          ${printRowsHtml}
        </tbody>
        <tfoot>
          <tr class="cap-pt-totals-row">
            <td class="cap-pt-name">Team Total</td>
            <td class="cap-pt-num">${formatHours(totalWorkedSecs)}</td>
            <td class="cap-pt-num">${formatHours(totalBudgetSecs)}</td>
            <td class="cap-pt-num cap-pt-pct">${totalPct}%</td>
            ${catTotalPrintCells}
            <td class="cap-pt-status" style="background:${STATUS_BG[totalStatus]};color:${STATUS_CLR[totalStatus]}">${totalRemainLabel}</td>
          </tr>
        </tfoot>
      </table>
    </div>`;

  document.getElementById("cap-sprint-len").addEventListener("change", e => {
    const v = parseInt(e.target.value, 10);
    state.sprintLengthWeeks = v > 0 ? v : null;
    renderCapacity();
  });

  document.getElementById("cap-reset-len")?.addEventListener("click", () => {
    state.sprintLengthWeeks = null;
    renderCapacity();
  });

  _renderProjectBurnAsync();
  _renderProjectCapacityAsync();
}

/* ── View: Sprint Comparison ────────────────────────────────────────────────── */

function renderCompare() {
  const el = document.getElementById("compare-content");
  if (!el) return;

  if (charts["compare-bar"]) { charts["compare-bar"].destroy(); delete charts["compare-bar"]; }

  if (!state.compareMode || !state.sprintA || !state.sprintB) {
    el.innerHTML = `<p class="compare-placeholder">Enable compare mode and select two sprints to compare.</p>`;
    return;
  }

  const diff = diffSprints(state.sprintA, state.sprintB);

  // ── Velocity summary ──
  const deltaSecs   = diff.totalDelta;
  const deltaPct    = diff.totalDeltaPercent;
  const deltaSign   = deltaSecs > 0 ? "+" : "";
  const pctStr      = deltaPct === null ? "new" : `${deltaSecs >= 0 ? "+" : ""}${deltaPct}%`;
  const velClass    = deltaSecs > 0 ? "vel-up" : deltaSecs < 0 ? "vel-down" : "vel-zero";

  // ── Grouped bar chart: member × sprint ──
  const memberNames = Object.keys(diff.members).sort();
  const dataA = memberNames.map(m => +(diff.members[m].a / 3600).toFixed(2));
  const dataB = memberNames.map(m => +(diff.members[m].b / 3600).toFixed(2));

  // ── Delta cards ──
  const deltaCardsHtml = memberNames.map(m => {
    const { a, b, delta, deltaPercent } = diff.members[m];
    const sign = delta > 0 ? "+" : "";
    const pct  = deltaPercent === null ? "new" : `${delta >= 0 ? "+" : ""}${deltaPercent}%`;
    const cls  = delta > 0 ? "delta-card--up" : delta < 0 ? "delta-card--down" : "delta-card--zero";
    const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "–";
    return `
      <div class="delta-card ${cls}">
        <div class="delta-card__name">${_escHtml(m)}</div>
        <div class="delta-card__a">${formatHours(a)}</div>
        <div class="delta-card__arrow">${arrow}</div>
        <div class="delta-card__b">${formatHours(b)}</div>
        <div class="delta-card__delta">${sign}${formatHours(Math.abs(delta))} (${pct})</div>
      </div>`;
  }).join("");

  // ── Issue overlap table ──
  const overlapRowsHtml = diff.overlap.map(({ key, description, secondsA, secondsB }) => {
    const onlyInA = secondsB === 0;
    const onlyInB = secondsA === 0;
    const dSecs   = secondsB - secondsA;
    const dSign   = dSecs > 0 ? "+" : "";
    const badge   = onlyInA ? ' <span class="badge-dropped">(dropped)</span>'
                  : onlyInB ? ' <span class="badge-new">(new)</span>' : "";
    const cellA   = secondsA > 0 ? formatHours(secondsA) : "—";
    const cellB   = secondsB > 0 ? formatHours(secondsB) : "—";
    const cellD   = `${dSign}${formatHours(Math.abs(dSecs))}`;
    return `<tr>
      <td class="tbl-td">${_escHtml(key)}</td>
      <td class="tbl-td">${_escHtml(description)}${badge}</td>
      <td class="tbl-td">${cellA}</td>
      <td class="tbl-td">${cellB}</td>
      <td class="tbl-td">${cellD}</td>
    </tr>`;
  }).join("");

  el.innerHTML = `
    <div class="chart-card velocity-card ${velClass}">
      <h3>Velocity Summary</h3>
      <div class="velocity-row">
        <span>Sprint A: <strong>${formatHours(diff.totalA)}</strong></span>
        <span>Sprint B: <strong>${formatHours(diff.totalB)}</strong></span>
        <span class="velocity-delta">Δ ${deltaSign}${formatHours(Math.abs(deltaSecs))} (${pctStr})</span>
      </div>
    </div>

    <div class="chart-card">
      <div class="chart-card-header">
        <h3>Hours per Member</h3>
        <button class="btn-export-png" id="btn-export-compare">⬇ Export PNG</button>
      </div>
      <canvas id="canvas-compare-bar"></canvas>
    </div>

    <div class="chart-card">
      <h3>Member Delta</h3>
      <div class="delta-cards">${deltaCardsHtml}</div>
    </div>

    <div class="chart-card">
      <h3>Issue Overlap</h3>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr>
            <th class="tbl-th">Issue Key</th>
            <th class="tbl-th">Description</th>
            <th class="tbl-th">Sprint A</th>
            <th class="tbl-th">Sprint B</th>
            <th class="tbl-th">Δ</th>
          </tr></thead>
          <tbody>${overlapRowsHtml}</tbody>
        </table>
      </div>
    </div>`;

  charts["compare-bar"] = new Chart(
    document.getElementById("canvas-compare-bar"),
    {
      type: "bar",
      data: {
        labels: memberNames,
        datasets: [
          { label: "Sprint A", data: dataA, backgroundColor: _rgba("#7eb8f7", 0.45), borderColor: "#7eb8f7", borderWidth: 2 },
          { label: "Sprint B", data: dataB, backgroundColor: _rgba("#6dd9a8", 0.45), borderColor: "#6dd9a8", borderWidth: 2 },
        ],
      },
      options: {
        plugins: {
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.dataset.label}: ${formatHours(Math.round(ctx.parsed.y * 3600))}`,
            },
          },
        },
        scales: {
          y: { title: { display: true, text: "Hours" }, ticks: { callback: v => `${v}h` } },
        },
      },
    }
  );

  document.getElementById("btn-export-compare").addEventListener("click", () => {
    _exportPng(_buildCompareExportConfig, `compare_${_sprintSlug()}`);
  });
}

/* ── Boot ───────────────────────────────────────────────────────────────────── */
init();
