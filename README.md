# Time Tracker Dashboard

A zero-dependency, locally hosted web dashboard for visualizing Jira worklog exports. Drop in a CSV, get instant charts.

---

## Features

- **Team member breakdown** — see who invested how much time
- **Issue / story breakdown** — see where time was invested, grouped by status
- **Timeline view** — daily hours stacked by team member
- **Epic categorization** — group by Epic when the data is available
- **Capacity view** — per-member budget vs. actual with over/under indicators (8 h/person/week)
- **Raw data table** — searchable and filterable log of all entries
- **No install required** — open `index.html` in any browser, load your CSV, done

---

## Getting Started

### 1. Export your worklogs from Jira

Export a worklog report (e.g. from Tempo, ActivityTimeline, or the built-in Jira time tracking export) as a **CSV file**. The dashboard expects the following columns:

```
Last Updated, Time Spent, Time Spent (s), Team Member, Project, Issue Key,
Issue Type, Issue Description, Status, Worklog Comment, Components, Fix version, Team
```

> **Tip — Epic data:** If you want epic-based filtering, make sure your export includes an `Epic Link` or `Epic Name` column. If your export tool does not support this, you can provide a manual `epic-mapping.json` file (see [Epic Mapping](#epic-mapping) below).

### 2. Open the dashboard

No server or installation needed. Simply open `index.html` in your browser:

```bash
open index.html        # macOS
start index.html       # Windows
xdg-open index.html    # Linux
```

Or, if you prefer a local server (e.g. to avoid any browser file-access restrictions):

```bash
# Python 3
python3 -m http.server 8080
# then open http://localhost:8080
```

### 3. Load your CSV

- **Drag and drop** the CSV file onto the drop zone, or
- Click **"Choose file"** and select your export

The dashboard parses the file entirely in your browser — no data is sent anywhere.

---

## Epic Mapping

Because the standard Jira worklog export does not always include Epic information, you can provide a manual mapping file named `epic-mapping.json` in the same directory as `index.html`.

**Format:**

```json
{
  "SEP-7":  "Epic: Tooling & Setup",
  "SEP-8":  "Epic: Documentation",
  "SEP-9":  "Epic: Resource Planning",
  "SEP-11": "Epic: Project Management",
  "SEP-22": "Epic: Admin & Scrum"
}
```

When the dashboard detects this file (or when you load it via the optional second file input), the **"By Epic"** tab will become available.

---

## Views

| Tab | What it shows |
|---|---|
| **Overview** | Total hours, team size, date range, per-member summary cards |
| **By Member** | Donut + bar chart of hours per team member; click to drill down |
| **By Issue** | Horizontal bar chart of hours per story/task, colour-coded by status |
| **Timeline** | Daily stacked area chart showing when work happened |
| **By Epic** | Hours per epic + epic × member breakdown *(requires Epic data)* |
| **Data Table** | Filterable, sortable raw log table |
| **Capacity** | Per-member budget vs. actual hours with remaining/over indicators |

### Capacity view

The Capacity tab shows whether each team member is on track against an **8 h/week** budget. The budget is calculated automatically from the sprint's date range (first worklog date → last worklog date, inclusive):

```
budget_per_person = 8 h × (sprint_days / 7)
```

Each person gets a progress bar and a badge:

| Badge | Meaning |
|---|---|
| **X h left** (green) | Worked fewer hours than the budget |
| **+X h over** (red) | Worked more hours than the budget |
| **exact** (blue) | Worked exactly the budgeted hours |

The summary stat cards at the top show the overall team balance across all members.

---

## CSV Format Reference

| Column | Type | Description |
|---|---|---|
| `Last Updated` | date `dd/mm/yyyy` | Date of the worklog entry |
| `Time Spent` | string `Nh` | Human-readable duration (display only) |
| `Time Spent (s)` | integer | Duration in seconds — used for all calculations |
| `Team Member` | string | Full name of the person who logged work |
| `Project` | string | Jira project name |
| `Issue Key` | string | Jira issue identifier (e.g. `SEP-22`) |
| `Issue Type` | string | Story, Bug, Task, Sub-task, etc. |
| `Issue Description` | string | Issue title |
| `Status` | string | Current issue status |
| `Worklog Comment` | string | Optional note on the log entry |
| `Components` | string | Jira components *(often empty)* |
| `Fix version` | string | Jira fix version *(often empty)* |
| `Team` | string | Team name |

---

## Testing

The capacity logic (budget calculation, over/under detection) is covered by unit tests in `tests/test_capacity.js`. Run them with:

```bash
make test
# or directly:
node tests/test_capacity.js
```

No additional dependencies are required — the tests use Node.js's built-in `assert` module.

---

## Contributing / Extending

The dashboard is intentionally a single HTML file with no build step. To extend it:

1. Edit `index.html` directly
2. The data pipeline is: **CSV load → PapaParse → transform functions → Chart.js renders**
3. Each view is a separate `<section>` toggled by the nav tabs
4. Chart instances are stored in a top-level `charts` object so they can be destroyed/recreated on data reload

---

## Privacy

All processing happens locally in your browser. No data is uploaded, tracked, or stored outside your machine. The only external requests are CDN loads for Chart.js and PapaParse (loaded once on first open; can be replaced with local copies for fully offline use).
