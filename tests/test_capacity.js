/**
 * Unit tests for the capacity-related logic extracted from app.js.
 *
 * Run with:  node tests/test_capacity.js
 * Requires:  Node.js >= 14  (uses built-in assert, no extra deps)
 */

"use strict";

const assert = require("assert/strict");

/* ── Helpers copied verbatim from app.js ───────────────────────────────────── */

function parseDate(ddmmyyyy) {
  const [dd, mm, yyyy] = ddmmyyyy.split("/");
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function aggregateByMember(rows) {
  const result = {};
  for (const row of rows) {
    const m = row["Team Member"];
    if (!m) continue;
    result[m] = (result[m] || 0) + row["Time Spent (s)"];
  }
  return result;
}

function sprintWeeks(rows) {
  const weeks = new Set();
  for (const row of rows) {
    const raw = row["Last Updated"];
    if (!raw) continue;
    const d      = new Date(parseDate(raw) + "T00:00:00Z");
    const dow    = d.getUTCDay();
    const offset = dow === 0 ? -6 : 1 - dow;
    const mon    = new Date(d.getTime() + offset * 86_400_000);
    weeks.add(mon.toISOString().slice(0, 10));
  }
  return weeks.size;
}

function computeCapacity(rows, hoursPerWeek = 8) {
  const weeks      = sprintWeeks(rows);
  const budgetSecs = hoursPerWeek * weeks * 3600;
  const byMember   = aggregateByMember(rows);

  const members = Object.entries(byMember).map(([name, workedSecs]) => {
    const remainingSecs = budgetSecs - workedSecs;
    const status = remainingSecs > 0 ? "under" : remainingSecs < 0 ? "over" : "exact";
    return { name, workedSecs, budgetSecs, remainingSecs, status };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return { weeks, budgetSecs, members };
}

/* ── Test helpers ───────────────────────────────────────────────────────────── */

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

/* ── Fixtures ───────────────────────────────────────────────────────────────── */

// 7 calendar days (Mon 12 Jan – Sun 18 Jan 2026) → exactly 1 week
const SPRINT_1W = [
  { "Last Updated": "12/01/2026", "Team Member": "Alice", "Time Spent (s)": 3600  },  // 1h
  { "Last Updated": "14/01/2026", "Team Member": "Alice", "Time Spent (s)": 7200  },  // 2h
  { "Last Updated": "16/01/2026", "Team Member": "Bob",   "Time Spent (s)": 28800 },  // 8h (exactly on budget)
  { "Last Updated": "18/01/2026", "Team Member": "Bob",   "Time Spent (s)": 0     },  // 0h extra row
];

// 14 calendar days (Mon 12 Jan – Sun 25 Jan 2026) → exactly 2 weeks
const SPRINT_2W = [
  { "Last Updated": "12/01/2026", "Team Member": "Alice", "Time Spent (s)": 3600  },
  { "Last Updated": "25/01/2026", "Team Member": "Alice", "Time Spent (s)": 3600  },
];

/* ── Tests: parseDate ───────────────────────────────────────────────────────── */

console.log("\nparseDate");

test("converts DD/MM/YYYY to ISO", () => {
  assert.equal(parseDate("12/01/2026"), "2026-01-12");
  assert.equal(parseDate("01/02/2026"), "2026-02-01");
  assert.equal(parseDate("31/12/2025"), "2025-12-31");
});

test("pads single-digit day and month", () => {
  assert.equal(parseDate("01/01/2026"), "2026-01-01");
});

/* ── Tests: aggregateByMember ───────────────────────────────────────────────── */

console.log("\naggregateByMember");

test("sums seconds per member", () => {
  const result = aggregateByMember(SPRINT_1W);
  assert.equal(result["Alice"], 10800);   // 1h + 2h = 3h
  assert.equal(result["Bob"],   28800);   // 8h
});

test("ignores rows with no Team Member", () => {
  const rows = [
    { "Last Updated": "12/01/2026", "Team Member": "",    "Time Spent (s)": 9999 },
    { "Last Updated": "12/01/2026", "Team Member": "Eve", "Time Spent (s)": 3600 },
  ];
  const result = aggregateByMember(rows);
  assert.equal(Object.keys(result).length, 1);
  assert.equal(result["Eve"], 3600);
});

test("returns empty object for empty rows", () => {
  assert.deepEqual(aggregateByMember([]), {});
});

/* ── Tests: sprintWeeks ─────────────────────────────────────────────────────── */

console.log("\nsprintWeeks");

test("returns 0 for empty rows", () => {
  assert.equal(sprintWeeks([]), 0);
});

test("single day = 1 week", () => {
  const rows = [{ "Last Updated": "12/01/2026", "Team Member": "Alice", "Time Spent (s)": 3600 }];
  assert.equal(sprintWeeks(rows), 1);
});

test("7-day sprint = exactly 1 week (Jan 12–18)", () => {
  assert.equal(sprintWeeks(SPRINT_1W), 1);
});

test("14-day sprint = exactly 2 weeks (Jan 12–25)", () => {
  assert.equal(sprintWeeks(SPRINT_2W), 2);
});

test("two dates in the same Mon-Sun week count as 1 week", () => {
  // Jan 12 (Mon) and Jan 18 (Sun) are both in the same ISO week
  const rows = [
    { "Last Updated": "18/01/2026", "Team Member": "Alice", "Time Spent (s)": 0 },
    { "Last Updated": "12/01/2026", "Team Member": "Alice", "Time Spent (s)": 0 },
  ];
  assert.equal(sprintWeeks(rows), 1);
});

/* ── Tests: computeCapacity ─────────────────────────────────────────────────── */

console.log("\ncomputeCapacity");

test("returns correct week count and budget", () => {
  const { weeks, budgetSecs } = computeCapacity(SPRINT_1W);
  assert.equal(weeks, 1);
  assert.equal(budgetSecs, 8 * 3600);   // 8h in seconds
});

test("marks member under budget when worked < budget", () => {
  const { members } = computeCapacity(SPRINT_1W);
  const alice = members.find(m => m.name === "Alice");
  assert.ok(alice, "Alice should be in members");
  assert.equal(alice.status, "under");
  assert.equal(alice.workedSecs, 10800);        // 3h worked
  assert.equal(alice.remainingSecs, 28800 - 10800);  // 5h remaining
});

test("marks member exactly on budget", () => {
  const { members } = computeCapacity(SPRINT_1W);
  const bob = members.find(m => m.name === "Bob");
  assert.ok(bob, "Bob should be in members");
  assert.equal(bob.status, "exact");
  assert.equal(bob.remainingSecs, 0);
});

test("marks member over budget when worked > budget", () => {
  const rows = [
    { "Last Updated": "12/01/2026", "Team Member": "Carol", "Time Spent (s)": 50400 },  // 14h in 1 week
    { "Last Updated": "18/01/2026", "Team Member": "Carol", "Time Spent (s)": 0     },
  ];
  const { members } = computeCapacity(rows);
  const carol = members.find(m => m.name === "Carol");
  assert.ok(carol, "Carol should be in members");
  assert.equal(carol.status, "over");
  assert.ok(carol.remainingSecs < 0, "remainingSecs should be negative when over");
});

test("respects custom hoursPerWeek", () => {
  const rows = [
    { "Last Updated": "12/01/2026", "Team Member": "Dave", "Time Spent (s)": 36000 },  // 10h
    { "Last Updated": "18/01/2026", "Team Member": "Dave", "Time Spent (s)": 0 },
  ];
  // Budget = 10h/week × 1 week → worked exactly matches
  const { members } = computeCapacity(rows, 10);
  const dave = members.find(m => m.name === "Dave");
  assert.equal(dave.status, "exact");
});

test("members list is sorted alphabetically", () => {
  const { members } = computeCapacity(SPRINT_1W);
  const names = members.map(m => m.name);
  assert.deepEqual(names, [...names].sort());
});

test("returns empty members list for empty rows", () => {
  const result = computeCapacity([]);
  assert.equal(result.weeks, 0);
  assert.deepEqual(result.members, []);
});

test("2-week sprint doubles the per-person budget", () => {
  const { budgetSecs } = computeCapacity(SPRINT_2W);
  assert.equal(budgetSecs, 16 * 3600);   // 8h × 2 weeks
});

/* ── Summary ────────────────────────────────────────────────────────────────── */

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
