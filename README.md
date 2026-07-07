# Noon

A resource-management tool for a middle manager running fluid, multi-member
projects — a living case file. Define projects and team member attributes,
track weekly capacity and progress against them, and get a rolled-up wrap-up
view to write year-end reviews from.

## Files

| File | What it is |
| --- | --- |
| `noon.jsx` | **The deliverable.** Single-file React app (functional components + hooks). All persistence via `window.storage` (get/set/delete/list), single-user keys. Paste this into an environment that provides `window.storage` — e.g. a claude.ai artifact. |
| `index.html` | Dev harness only. Shims `window.storage` (backed by localStorage — the app itself never touches localStorage) and compiles the JSX in-browser so the app can be run and tested locally. |
| `.claude/launch.json` | Preview server config (`python -m http.server 8123`). |

## Run locally

```
python -m http.server 8123
```

then open http://localhost:8123 (requires internet for the React/Babel CDN
scripts used by the harness).

## Storage layout

One key per related data cluster, to minimize storage calls:

- `noon:members` — array of all team members (each may carry `fieldNotes`: dated out-of-project observations)
- `noon:project:<id>` — `{ project, assignments, checkIns, weekPlans }` for one project.
  `weekPlans` holds per-week planned-capacity overrides (set from the This week page);
  `project.retrospective` and `assignment.performanceSummary` hold the manager-written
  wrap-up assessments.

## Design language — "Guided Path"

Creation flows are conversational journeys, not forms: named waypoints
(Who → Strengths → Trust / Idea → Shape → People), one question per screen,
big tappable choice cards instead of dropdowns and sliders, and a
"decide later" on every optional step. Statuses use human language —
*Moving as planned / Wobbling a little / Stuck — needs you*. Warm sunrise
gradient accent, pill buttons, rounded geometry, springy-but-subtle motion
(respects `prefers-reduced-motion`). See `directions.html` for the design
direction sampler this was chosen from (Option B).

## Structure

- **Dashboard** — active projects with member avatars, each carrying their own traffic-light badge; wrapped-up projects below.
- **This week** — top-down weekly planning: everyone's total load for a chosen week with an overload-aware bar, and per-project planned % editable in place (stored as weekly overrides of the standing allocation).
- **People (roster)** — trust profile per member (Core/Stretch competencies, experience bucket, responsibility 1–5) plus aggregate allocation across active projects, with over-allocation flagged.
- **Project view** — three stages as tabs:
  - *Onboarding*: edit project attributes; assign people with capacity % and notes.
  - *Progression*: weekly check-in per assignment (status, actual vs. allocated capacity, note) + at-a-glance strip.
  - *Wrap-up*: rolled-up summary — status counts, per-member trust profile + engagement stats, week-by-week timeline. The material for a year-end review; the manager writes the narrative themselves.
