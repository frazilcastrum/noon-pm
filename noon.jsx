import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";

/*
  Noon — a living case file for the projects you run and the people you trust.

  Design language: "Tactile Heritage" — a notebook, not a SaaS app.
  Oatmeal paper, ink structure, growth green reserved for stretch/success,
  saturated red/amber/green for the semantic traffic-light triad.
  Capture-first: the home screen is the notebook; parsing and reports are
  rule-based only (no AI calls). Journey-style creation flows underneath.

  Single-file React app. All persistence goes through window.storage
  (get / set / delete / list), single-user keys (shared: false).

  Storage layout (one key per related data cluster):
    noon:members            -> Member[]
    noon:logs               -> notebook entries (annotations append-only)
    noon:project:<id>       -> { project, assignments, checkIns, weekPlans }
*/

/* ============================== storage ============================== */

const MEMBERS_KEY = "noon:members";
const PROJECT_PREFIX = "noon:project:";
const LOGS_KEY = "noon:logs";

async function sGet(key) {
  try {
    const res = await window.storage.get(key, false);
    if (res == null) return null;
    const raw = typeof res === "string" ? res : res.value;
    if (raw == null) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function sSet(key, obj) {
  await window.storage.set(key, JSON.stringify(obj), false);
}

async function sDel(key) {
  try {
    await window.storage.delete(key, false);
  } catch (e) {
    /* already gone */
  }
}

async function sListKeys(prefix) {
  try {
    const res = await window.storage.list(prefix, false);
    const arr = Array.isArray(res)
      ? res
      : (res && (res.keys || res.items || res.results)) || [];
    return arr
      .map((k) => (typeof k === "string" ? k : k && k.key))
      .filter((k) => typeof k === "string" && k.startsWith(prefix));
  } catch (e) {
    return [];
  }
}

/* ============================== helpers ============================== */

function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function toISODate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function mondayOf(iso) {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toISODate(d);
}

function thisMonday() {
  return mondayOf(toISODate(new Date()));
}

function fmtWeek(iso) {
  const d = new Date(iso + "T00:00:00");
  return isNaN(d) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return isNaN(d)
    ? iso
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function clampPct(n) {
  const v = Math.round(Number(n));
  if (isNaN(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

function initials(name) {
  return (name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function firstName(name) {
  const f = (name || "").trim().split(/\s+/)[0];
  return f || "them";
}

const STATUSES = ["on track", "at risk", "blocked"];

const STATUS_META = {
  "on track": {
    label: "On track",
    phrase: "Moving as planned",
    desc: "steady week",
    color: "#1E9E63",
    tint: "#DFF3E8",
  },
  "at risk": {
    label: "Wobbling",
    phrase: "Wobbling a little",
    desc: "worth keeping an eye on",
    color: "#E39310",
    tint: "#FBEFD6",
  },
  blocked: {
    label: "Stuck",
    phrase: "Stuck — needs you",
    desc: "step in this week",
    color: "#CE3B2C",
    tint: "#FAE3DF",
  },
};

const NO_STATUS = { label: "No check-ins yet", color: "#C9C0B2", tint: "#EFE8DB" };

const RESP_CARDS = [
  { level: 1, title: "Close guidance", desc: "you review most of what ships" },
  { level: 2, title: "Guided", desc: "checks in before the big calls" },
  { level: 3, title: "Steady", desc: "runs the day-to-day with light support" },
  { level: 4, title: "Largely autonomous", desc: "they run it; you stay in the loop" },
  { level: 5, title: "Fully autonomous", desc: "you'd hand them the keys" },
];

const RESP_LABELS = {
  1: "Close guidance",
  2: "Guided",
  3: "Steady",
  4: "Largely autonomous",
  5: "Fully autonomous",
};

function expBucket(years) {
  const y = Number(years) || 0;
  if (y <= 2) return "Junior";
  if (y <= 5) return "Mid";
  return "Senior";
}

function latestCheckIn(checkIns, assignmentId) {
  let best = null;
  for (const c of checkIns) {
    if (c.assignmentId !== assignmentId) continue;
    if (!best || c.weekOf > best.weekOf) best = c;
  }
  return best;
}

/* Planned capacity for a given week: the week's override if the manager set
   one, otherwise the assignment's standing default. */
function plannedFor(bundle, assignmentId, weekOf) {
  const wp = (bundle.weekPlans || []).find(
    (p) => p.assignmentId === assignmentId && p.weekOf === weekOf
  );
  if (wp) return wp.planned;
  const a = bundle.assignments.find((x) => x.id === assignmentId);
  return a ? a.capacityAllocated : 0;
}

/* ---------- notebook logs (capture-first) ---------- */

const LOG_META = {
  core: { label: "Core", desc: "baseline delivery", color: "#5E564A", tint: "#EAE2D4" },
  stretch: { label: "Stretch", desc: "growth moment", color: "#0C8F58", tint: "#DFF6EA" },
  redline: { label: "Redline", desc: "capacity risk", color: "#CE3B2C", tint: "#FAE3DF" },
};

const REDLINE_WORDS = [
  "late night", "late nights", "overtime", "weekend", "stress", "stressed", "exhaust",
  "overload", "burn", "burnt", "burned out", "strain", "crunch", "tired", "sick",
  "12 hours", "dying", "drowning", "overwhelmed", "breaking point",
];
const STRETCH_WORDS = [
  "led ", "lead ", "leading", "independent", "ownership", "initiative", "under pressure",
  "ambiguity", "mentor", "organised", "organized", "growth", "stretch", "stepped up",
  "presented", "drove", "unprompted", "beyond", "impressed", "facilitated",
];

/* Rule-based capture parser — no AI, just honest keyword + name matching.
   Returns a suggestion the manager confirms or corrects before committing. */
function parseCapture(text, members, bundles) {
  const lower = text.toLowerCase();

  let memberId = null;
  for (const m of members) {
    const full = m.name.toLowerCase();
    const first = full.split(/\s+/)[0];
    if (lower.includes(full) || new RegExp("\\b" + first + "\\b", "i").test(text)) {
      memberId = m.id;
      break;
    }
  }

  let projectId = null;
  for (const b of bundles) {
    if (b.project.status !== "active") continue;
    if (lower.includes(b.project.name.toLowerCase())) {
      projectId = b.project.id;
      break;
    }
  }

  let type = "core";
  if (REDLINE_WORDS.some((w) => lower.includes(w))) type = "redline";
  else if (STRETCH_WORDS.some((w) => lower.includes(w))) type = "stretch";

  return { memberId, projectId, type };
}

/* Mine short skill-like phrases out of a pasted JD / kickoff doc. */
function extractSkills(text) {
  const found = [];
  const seen = new Set();
  for (const chunk of text.split(/[\n,;•·\-–—\/\(\)]+/)) {
    const t = chunk.trim().replace(/[.:]+$/, "");
    if (!t || t.length < 3 || t.length > 28) continue;
    const words = t.split(/\s+/);
    if (words.length > 3) continue;
    if (/^\d+$/.test(t)) continue;
    const key = t.toLowerCase();
    if (/^(and|or|the|with|for|of|to|a|an|in|on|at|is|are|our|you|we|will|must|have|has|be|as|per|etc|eg|e\.g)$/.test(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(t);
    if (found.length >= 14) break;
  }
  return found;
}

/* ============================== styles ============================== */

const CSS = `
.noon-root{min-height:100vh;background:#F3EDE2;color:#2B2B2B;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased;position:relative;}
.noon-root *{box-sizing:border-box;}
.noon-root h1,.noon-root h2,.noon-root h3,.noon-root h4{margin:0;line-height:1.3;}
.noon-root button{font-family:inherit;}
.paper-noise{position:fixed;inset:0;pointer-events:none;z-index:0;opacity:.5;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.028'/%3E%3C/svg%3E");}

.hdr{display:flex;align-items:center;max-width:980px;margin:0 auto;padding:22px 24px 6px;position:relative;z-index:1;}
.wordmark{font-size:22px;font-weight:800;letter-spacing:-0.5px;color:#2B2B2B;cursor:pointer;background:none;border:none;padding:0;}
.wm-dot{color:#0FA968;}
.nav{margin-left:auto;display:flex;gap:4px;flex-wrap:wrap;}
.nav button{border:none;background:none;font-size:13.5px;font-weight:600;color:#9C9284;padding:6px 13px;border-radius:99px;cursor:pointer;transition:all .15s ease;}
.nav button:hover{color:#2B2B2B;}
.nav button.on{color:#F6F1E7;background:#2B2B2B;font-weight:700;}

.container{max-width:980px;margin:0 auto;padding:14px 24px 90px;position:relative;z-index:1;}
.page-title{font-size:25px;font-weight:800;letter-spacing:-0.4px;margin-top:20px;}
.page-sub{color:#9C9284;font-size:14.5px;margin:3px 0 22px;}

.card{background:#FBF8F1;border:1px solid #D8D1C7;border-radius:14px;padding:20px 22px;box-shadow:0 1px 2px rgba(80,70,50,0.05),0 3px 10px rgba(80,70,50,0.04);}
.card+.card{margin-top:16px;}
.card h3{font-size:16.5px;font-weight:700;margin-bottom:2px;}
.card .card-sub{color:#9C9284;font-size:13.5px;margin-bottom:14px;}

.btn{background:#2B2B2B;color:#F6F1E7;border:none;border-radius:99px;padding:10px 24px;font-size:14px;font-weight:700;cursor:pointer;transition:background .15s ease,transform .15s ease;}
.btn:hover{background:#1D1B18;transform:translateY(-1px);}
.btn:active{transform:translateY(0);}
.btn:disabled{background:#C9C0B2;cursor:default;transform:none;}
.btn-green{background:#0FA968;color:#fff;border:none;border-radius:99px;padding:10px 24px;font-size:14px;font-weight:700;cursor:pointer;transition:background .15s ease,transform .15s ease;}
.btn-green:hover{background:#0B8A55;transform:translateY(-1px);}
.btn-green:disabled{background:#BFD9CB;cursor:default;transform:none;}
.btn2{background:#FBF8F1;color:#2B2B2B;border:1.5px solid #C9C0B2;border-radius:99px;padding:9px 20px;font-size:14px;font-weight:600;cursor:pointer;transition:border-color .15s ease;}
.btn2:hover{border-color:#2B2B2B;}
.btn-txt{background:none;border:none;font-size:13.5px;font-weight:600;color:#9C9284;cursor:pointer;padding:4px 6px;border-radius:8px;}
.btn-txt:hover{color:#2B2B2B;}
.btn-danger{background:none;border:none;font-size:13.5px;color:#B8AE9D;cursor:pointer;padding:4px 6px;}
.btn-danger:hover{color:#B5544D;}
.btn-danger.armed{color:#B5544D;font-weight:700;}

.inp,.sel,.ta{width:100%;border:1.5px solid #D8D1C7;border-radius:10px;padding:10px 14px;font:inherit;font-size:14.5px;color:#2B2B2B;background:#FDFBF6;transition:border-color .15s ease,box-shadow .15s ease;}
.inp:focus,.sel:focus,.ta:focus{outline:none;border-color:#0FA968;box-shadow:0 0 0 3px rgba(15,169,104,0.14);}
.inp::placeholder,.ta::placeholder{color:#B8AE9D;}
.ta{resize:vertical;min-height:76px;}
.inp.mini{width:76px;padding:6px 10px;border-radius:8px;font-size:13.5px;text-align:center;}
.field{margin-bottom:16px;}
.field>label{display:block;font-size:11.5px;font-weight:700;color:#9C9284;text-transform:uppercase;letter-spacing:0.07em;margin:0 0 6px 4px;}
.frow{display:flex;gap:14px;}
.frow>.field{flex:1;}
.label{font-size:11.5px;font-weight:800;color:#9C9284;text-transform:uppercase;letter-spacing:0.08em;}

.dot{display:inline-block;width:9px;height:9px;border-radius:50%;flex:none;}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;padding:3px 12px;border-radius:99px;white-space:nowrap;}
.tagrow{display:flex;flex-wrap:wrap;gap:7px;}
.tag{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;padding:3px 12px;border-radius:99px;background:#EAE2D4;color:#5E564A;}
.tag.stretch{background:#DFF6EA;color:#0C8F58;}
.tag .tag-x{background:none;border:none;cursor:pointer;font-size:13px;line-height:1;padding:0;color:inherit;opacity:0.5;}
.tag .tag-x:hover{opacity:1;}
.tag-none{font-size:13px;color:#B8AE9D;font-style:italic;}

.av{width:32px;height:32px;border-radius:50%;background:#E7DCC9;color:#6A5D48;display:inline-flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:800;flex:none;}
.av-stack{display:flex;}
.av-stack .av{border:2.5px solid #FBF8F1;margin-left:-9px;}
.av-stack .av:first-child{margin-left:0;}
.av-wrap{position:relative;display:inline-flex;margin-left:-9px;}
.av-stack .av-wrap:first-child{margin-left:0;}
.av-wrap .av{margin-left:0;border:2.5px solid #FBF8F1;}
.av-dot{position:absolute;bottom:-1px;right:-1px;width:10px;height:10px;border-radius:50%;border:2px solid #FBF8F1;}

.tabs{display:flex;gap:5px;margin:18px 0 20px;flex-wrap:wrap;}
.tabs button{background:none;border:none;font-size:13.5px;font-weight:600;color:#9C9284;padding:7px 16px;cursor:pointer;border-radius:99px;transition:all .15s ease;}
.tabs button:hover{color:#2B2B2B;}
.tabs button.on{color:#F6F1E7;background:#2B2B2B;font-weight:700;}

.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
@media(max-width:720px){.grid2{grid-template-columns:1fr;}.frow{flex-direction:column;gap:0;}}

.proj-card{cursor:pointer;transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease;}
.proj-card:hover{transform:translateY(-2px);border-color:#C9C0B2;box-shadow:0 6px 18px rgba(80,70,50,0.1);}
.proj-card h3{font-size:16.5px;}
.proj-desc{color:#6A6357;font-size:14px;margin:6px 0 14px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.proj-foot{display:flex;align-items:center;gap:10px;}
.proj-meta{margin-left:auto;font-size:12.5px;color:#B8AE9D;text-align:right;}
.row{display:flex;align-items:center;gap:12px;}

.hero{background:#EDE5D4;border-color:#D8D1C7;text-align:center;padding:48px 40px;}
.hero h3{font-size:23px;font-weight:800;letter-spacing:-0.4px;margin-bottom:8px;}
.hero p{color:#8A8071;font-size:15px;max-width:460px;margin:0 auto 22px;}

.team-row{display:flex;align-items:center;gap:14px;padding:14px 0;border-top:1px solid #EAE2D4;}
.team-row:first-of-type{border-top:none;}
.team-who{min-width:0;flex:1;}
.team-who .nm{font-weight:700;font-size:14.5px;}
.team-who .rl{font-size:12.5px;color:#9C9284;}
.num{width:78px;text-align:center;}
.cap-suffix{font-size:13px;color:#9C9284;margin-left:6px;}

.glance{display:flex;flex-wrap:wrap;gap:10px;}
.glance-chip{display:flex;align-items:center;gap:10px;background:#F6F1E7;border:1px solid #E3DACA;border-radius:12px;padding:9px 15px;}
.glance-chip .gc-name{font-weight:700;font-size:13.5px;line-height:1.35;}
.glance-chip .gc-sub{font-size:12px;color:#9C9284;line-height:1.35;}

.sgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:6px 0 16px;}
.scard{background:#FDFBF6;border:1.5px solid #D8D1C7;border-radius:12px;padding:12px 14px;text-align:center;cursor:pointer;transition:all .16s ease;}
.scard:hover{border-color:#C9C0B2;}
.scard.sel{border-color:#0FA968;background:#FBF8F1;box-shadow:0 4px 12px rgba(15,169,104,0.12);transform:translateY(-2px);}
.scard h5{margin:6px 0 2px;font-size:13.5px;font-weight:700;}
.scard p{margin:0;font-size:11.5px;color:#B8AE9D;line-height:1.4;}
@media(max-width:640px){.sgrid{grid-template-columns:1fr;}}

.ci-hist{margin-top:16px;border-top:1px solid #EAE2D4;padding-top:12px;}
.ci-hist-row{display:flex;align-items:baseline;gap:9px;font-size:13.5px;padding:3px 0;color:#6A6357;}
.ci-hist-row .whn{color:#B8AE9D;font-size:12.5px;white-space:nowrap;min-width:88px;}

.wk{padding:16px 0;border-top:1px solid #EAE2D4;}
.wk:first-of-type{border-top:none;padding-top:4px;}
.wk h4{font-size:12.5px;font-weight:800;color:#9C9284;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:8px;}
.wk-entry{display:flex;align-items:baseline;gap:10px;padding:4px 0;font-size:14px;}
.wk-entry .who{font-weight:700;white-space:nowrap;}
.wk-entry .cap{color:#B8AE9D;font-size:12.5px;white-space:nowrap;}
.wk-entry .txt{color:#5E564A;font-family:Georgia,'Times New Roman',serif;}

.trust{display:flex;flex-direction:column;gap:13px;margin-top:14px;}
.trust-sec .label{display:block;margin-bottom:6px;}
.trust-line{font-size:14px;}
.trust-sub{font-size:12.5px;color:#9C9284;}
.resp-dots{display:flex;gap:4px;align-items:center;margin:4px 0 3px;}
.resp-dots i{width:16px;height:7px;border-radius:4px;background:#E3DACA;}
.resp-dots i.f{background:#0FA968;}
.mini-label{font-size:12px;color:#9C9284;font-weight:700;margin-right:6px;}

.alloc-bar{position:relative;display:flex;height:6px;border-radius:3px;background:#E3DACA;margin:9px 0 7px;}
.alloc-bar i{display:block;height:100%;}
.alloc-bar .ab-base{border-radius:3px 0 0 3px;background:#2B2B2B;}
.alloc-bar .ab-base.only{border-radius:3px;}
.alloc-bar .ab-over{background:#9E2B1E;border-radius:0 3px 3px 0;}
.alloc-bar .ab-tick{position:absolute;top:-3px;bottom:-3px;width:2px;background:#F3EDE2;border-radius:1px;}
.alloc-note{font-size:13px;color:#9C9284;}
.alloc-over{color:#B5544D;font-weight:700;}
.member-card h3{font-size:15.5px;}
.stat-row{display:flex;gap:14px;flex-wrap:wrap;font-size:13.5px;color:#5E564A;margin-top:8px;}
.stat-row b{font-weight:700;}
.subtle-list{font-size:13px;color:#9C9284;margin-top:6px;}
.quote{font-size:13.5px;color:#6A6357;font-style:italic;font-family:Georgia,'Times New Roman',serif;margin-top:8px;}

.empty{padding:38px 30px;text-align:center;}
.empty h3{font-size:17px;margin-bottom:6px;}
.empty p{color:#9C9284;font-size:14px;max-width:460px;margin:0 auto 18px;}
.section-head{display:flex;align-items:baseline;margin:26px 0 13px;}
.section-head h2{font-size:17px;font-weight:800;letter-spacing:-0.2px;}
.section-head .btn2,.section-head .btn,.section-head .viewtoggle{margin-left:auto;}
.back{background:none;border:none;font-size:13.5px;font-weight:600;color:#B8AE9D;cursor:pointer;padding:0;margin-top:20px;}
.back:hover{color:#2B2B2B;}
.saved-note{font-size:13px;color:#0B7A4B;font-weight:700;margin-right:auto;animation:fadeUp .25s ease;}
.modal-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:20px;align-items:center;}
.pct-warn{display:block;font-size:11.5px;color:#B5544D;font-weight:600;margin-top:4px;animation:fadeUp .2s ease;}

/* ---------- journey overlay ---------- */
.jov{position:fixed;inset:0;z-index:60;background:linear-gradient(170deg,#F6F1E7 0%,#EDE5D4 100%);overflow:auto;animation:jovIn .25s ease;}
.jov-in{max-width:740px;margin:0 auto;padding:24px 24px 64px;min-height:100%;display:flex;flex-direction:column;}
.jov-top{display:flex;align-items:center;margin-bottom:10px;}
.jov-eyebrow{font-size:12px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:#B8AE9D;}
.jov-x{margin-left:auto;background:#FBF8F1;border:1.5px solid #C9C0B2;width:36px;height:36px;border-radius:50%;font-size:17px;line-height:1;color:#9C9284;cursor:pointer;transition:all .15s ease;}
.jov-x:hover{color:#2B2B2B;border-color:#2B2B2B;}
.path{display:flex;align-items:flex-start;justify-content:center;margin:14px 0 6px;}
.wp{display:flex;flex-direction:column;align-items:center;gap:7px;width:104px;background:none;border:none;padding:0;cursor:default;}
.wp .node{width:14px;height:14px;border-radius:50%;background:#D8D1C7;transition:all .2s ease;}
.wp.done{cursor:pointer;}
.wp.done .node{background:#2B2B2B;}
.wp.now .node{background:#0FA968;box-shadow:0 0 0 6px rgba(15,169,104,0.16);}
.wp .wlbl{font-size:11.5px;font-weight:700;color:#B8AE9D;}
.wp.now .wlbl{color:#0B7A4B;}
.wp.done .wlbl{color:#6A6357;}
.seg{height:3px;width:58px;background:#D8D1C7;border-radius:2px;margin-top:6px;flex:none;}
.seg.done{background:#2B2B2B;}
.jbody{flex:1;animation:stepIn .3s cubic-bezier(.22,.9,.35,1.08);}
.jq{text-align:center;font-size:25px;font-weight:800;letter-spacing:-0.5px;margin:26px 0 8px;}
.jsub{text-align:center;font-size:14.5px;color:#9C9284;margin:0 auto 26px;max-width:460px;}
.jfield{max-width:460px;margin:0 auto 16px;}
.jfield>label{display:block;font-size:12px;font-weight:700;color:#9C9284;margin:0 0 6px 6px;}
.jfield .inp,.jfield .ta{font-size:16px;padding:12px 16px;}
.jrow{display:flex;gap:14px;max-width:460px;margin:0 auto 16px;}
.jrow .jfield{flex:1;margin:0;}
.jfoot{display:flex;align-items:center;justify-content:center;gap:18px;margin-top:34px;}
.skip{background:none;border:none;color:#9C9284;font-size:13.5px;font-weight:600;cursor:pointer;padding:6px;}
.skip:hover{color:#0B7A4B;}
.jsteplbl{text-align:center;font-size:12.5px;color:#B8AE9D;margin-top:16px;}

.rgrid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;max-width:660px;margin:0 auto;}
@media(max-width:680px){.rgrid{grid-template-columns:repeat(2,1fr);}}
.ccard{background:#FBF8F1;border:1.5px solid #D8D1C7;border-radius:12px;padding:14px 10px;text-align:center;cursor:pointer;transition:all .16s ease;}
.ccard:hover{border-color:#C9C0B2;}
.ccard.sel{border-color:#0FA968;box-shadow:0 4px 14px rgba(15,169,104,0.14);transform:translateY(-2px);}
.ccard h4{font-size:13px;font-weight:700;line-height:1.3;}
.ccard p{font-size:11px;color:#B8AE9D;margin:4px 0 0;line-height:1.4;}
.ccard .ic{width:24px;height:24px;border-radius:8px;margin:0 auto 9px;background:#E3DACA;transition:all .16s ease;}
.ccard.sel .ic{background:#0FA968;}

.yrsrow{display:flex;align-items:center;justify-content:center;gap:12px;margin-top:26px;font-size:14.5px;color:#6A6357;flex-wrap:wrap;}
.yrsrow .bucket{font-weight:700;color:#0B7A4B;}

.capchips{display:flex;flex-wrap:wrap;gap:8px;}
.chip-btn{background:#FBF8F1;border:1.5px solid #D8D1C7;border-radius:99px;padding:6px 14px;font-size:13px;font-weight:600;color:#6A6357;cursor:pointer;transition:all .15s ease;}
.chip-btn b{font-weight:800;color:#2B2B2B;}
.chip-btn:hover{border-color:#C9C0B2;}
.chip-btn.on{border-color:#0FA968;background:#E2F5EB;color:#0B7A4B;}
.chip-btn.on b{color:#0B7A4B;}
.capwrap{display:flex;flex-direction:column;gap:10px;align-items:center;}
.capcustom{font-size:13px;color:#9C9284;display:flex;align-items:center;gap:7px;}

.pgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:620px;margin:0 auto;}
@media(max-width:640px){.pgrid{grid-template-columns:1fr;}}
.pcard{background:#FBF8F1;border:1.5px solid #D8D1C7;border-radius:12px;padding:13px 16px;cursor:pointer;transition:all .16s ease;text-align:left;}
.pcard:hover{border-color:#C9C0B2;}
.pcard.sel{border-color:#0FA968;box-shadow:0 4px 12px rgba(15,169,104,0.12);}
.pcard .pnm{font-weight:700;font-size:14px;}
.pcard .prl{font-size:12.5px;color:#9C9284;}
.pcard .ptick{margin-left:auto;width:22px;height:22px;border-radius:50%;background:#0FA968;color:#fff;font-size:12px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;flex:none;}
.pcard .pcaps{margin-top:11px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;animation:fadeUp .2s ease;}
.pcard .pcaps .chip-btn{padding:4px 11px;font-size:12px;}

/* ---------- field notes / notebook rows ---------- */
.fnote{display:flex;align-items:baseline;gap:7px;font-size:13px;color:#5E564A;padding:3px 0;}
.fnote .fn-date{color:#B8AE9D;font-size:12px;white-space:nowrap;}
.fnote .fn-x{background:none;border:none;color:#C9C0B2;font-size:13px;cursor:pointer;padding:0 3px;line-height:1;}
.fnote .fn-x:hover{color:#B5544D;}

.logrow{padding:12px 0;border-top:1px solid #EAE2D4;}
.logrow:first-of-type{border-top:none;}
.logrow .lg-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:3px;}
.logrow .lg-who{font-weight:700;font-size:13.5px;}
.logrow .lg-date{font-size:12px;color:#B8AE9D;}
.logrow .lg-tag{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:800;letter-spacing:0.02em;padding:2px 10px;border-radius:99px;border:1px solid rgba(43,43,43,0.08);}
.logrow .lg-txt{font-family:Georgia,'Times New Roman',serif;font-size:14.5px;color:#3D372E;line-height:1.55;}
.logrow .lg-ann{margin:6px 0 0 14px;padding-left:12px;border-left:2px solid #E3DACA;font-size:13px;color:#6A6357;font-family:Georgia,'Times New Roman',serif;}
.logrow .lg-ann .fn-date{margin-right:6px;}
.logrow .lg-actions{display:flex;gap:10px;margin-top:5px;}
.logrow .lg-actions button{background:none;border:none;font-size:12px;font-weight:600;color:#B8AE9D;cursor:pointer;padding:0;}
.logrow .lg-actions button:hover{color:#2B2B2B;}
.logrow .lg-annin{margin-top:7px;}

/* ---------- capture (home) ---------- */
.cap-card{background:#FBF8F1;border:1px solid #D8D1C7;border-radius:14px;padding:20px 22px;box-shadow:0 1px 2px rgba(80,70,50,0.05),0 3px 10px rgba(80,70,50,0.04);}
.cap-ta{width:100%;border:none;background:transparent;font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.7;color:#2B2B2B;resize:vertical;min-height:84px;padding:2px;}
.cap-ta:focus{outline:none;}
.cap-ta::placeholder{color:#B8AE9D;font-style:italic;}
.cap-rule{height:1px;background:#E3DACA;margin:10px 0 14px;}
.cap-group{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:9px;}
.cap-group-label{font-size:11px;font-weight:800;color:#B8AE9D;text-transform:uppercase;letter-spacing:0.08em;width:56px;flex:none;}
.cap-chip{background:#F6F1E7;border:1.5px solid transparent;border-radius:99px;padding:3px 12px;font-size:12.5px;font-weight:600;color:#6A6357;cursor:pointer;transition:all .13s ease;}
.cap-chip:hover{border-color:#C9C0B2;}
.cap-chip.on{border-color:#2B2B2B;background:#2B2B2B;color:#F6F1E7;}
.cap-chip.on.t-stretch{background:#0C8F58;border-color:#0C8F58;color:#fff;}
.cap-chip.on.t-redline{background:#CE3B2C;border-color:#CE3B2C;color:#fff;}
.cap-foot{display:flex;align-items:center;gap:12px;margin-top:14px;}
.cap-hint{font-size:12.5px;color:#B8AE9D;flex:1;}
.mic-btn{display:inline-flex;align-items:center;gap:8px;background:#FBF8F1;border:1.5px solid #C9C0B2;border-radius:99px;padding:8px 16px;font-size:13px;font-weight:700;color:#5E564A;cursor:pointer;transition:all .15s ease;}
.mic-btn:hover{border-color:#2B2B2B;color:#2B2B2B;}
.mic-btn.rec{background:#FAE3DF;border-color:#CE3B2C;color:#CE3B2C;}
.mic-btn .mic-dot{width:9px;height:9px;border-radius:50%;background:#9C9284;flex:none;}
.mic-btn.rec .mic-dot{background:#CE3B2C;animation:pulse-dot 1.2s ease-in-out infinite;}
@keyframes pulse-dot{0%,100%{opacity:1;transform:scale(1);}50%{opacity:0.45;transform:scale(0.75);}}
.alert-row{display:flex;align-items:baseline;gap:10px;padding:8px 0;font-size:14px;border-top:1px solid #EAE2D4;}
.alert-row:first-of-type{border-top:none;padding-top:2px;}
.alert-row .al-txt{color:#5E564A;flex:1;}
.alert-row .al-link{background:none;border:none;font-size:12.5px;font-weight:700;color:#9C9284;cursor:pointer;padding:0;white-space:nowrap;}
.alert-row .al-link:hover{color:#2B2B2B;}
.linkgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:16px;}
@media(max-width:720px){.linkgrid{grid-template-columns:1fr 1fr;}}
.linkcard{background:#FBF8F1;border:1px solid #D8D1C7;border-radius:14px;padding:16px 18px;cursor:pointer;text-align:left;transition:all .16s ease;}
.linkcard:hover{transform:translateY(-2px);border-color:#2B2B2B;}
.linkcard .lc-num{font-size:22px;font-weight:800;letter-spacing:-0.5px;display:block;}
.linkcard .lc-name{font-size:13.5px;font-weight:700;display:block;margin-top:2px;}
.linkcard .lc-sub{font-size:11.5px;color:#9C9284;display:block;}

/* ---------- this week ---------- */
.tw-week{display:flex;align-items:center;gap:10px;margin:0 0 20px;flex-wrap:wrap;}
.tw-week .inp{max-width:170px;}
.wknav{background:#FBF8F1;border:1.5px solid #C9C0B2;width:34px;height:34px;border-radius:50%;font-size:15px;color:#9C9284;cursor:pointer;transition:all .15s ease;}
.wknav:hover{color:#2B2B2B;border-color:#2B2B2B;}
.tw-total{margin-left:auto;font-size:13.5px;color:#6A6357;}
.tw-total b{color:#2B2B2B;}
.tw-total .over{color:#B5544D;font-weight:700;}
.tw-proj{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid #EAE2D4;}
.tw-proj .tw-pname{flex:1;min-width:0;font-weight:600;font-size:14px;background:none;border:none;color:#2B2B2B;text-align:left;cursor:pointer;padding:0;}
.tw-proj .tw-pname:hover{color:#0B7A4B;}
.tw-proj .tw-sub{font-size:12px;color:#9C9284;}

/* ---------- timeline ---------- */
.viewtoggle{display:inline-flex;gap:3px;background:#EDE5D4;border-radius:99px;padding:3px;}
.viewtoggle button{background:none;border:none;font-size:12.5px;font-weight:700;color:#9C9284;padding:4px 14px;border-radius:99px;cursor:pointer;}
.viewtoggle button.on{background:#2B2B2B;color:#F6F1E7;}
.tl-wrap{overflow-x:auto;padding-bottom:6px;}
.tl-grid{min-width:640px;}
.tl-headrow,.tl-row{display:flex;align-items:center;}
.tl-name{width:150px;flex:none;font-size:13px;font-weight:700;padding:8px 10px 8px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.tl-name.dim{color:#B8AE9D;font-weight:600;}
.tl-cell{width:36px;flex:none;display:flex;align-items:center;justify-content:center;height:34px;position:relative;}
.tl-cell .tl-track{position:absolute;left:0;right:0;top:50%;height:8px;transform:translateY(-50%);background:#EAE2D4;}
.tl-cell .tl-track.start{border-radius:4px 0 0 4px;left:4px;}
.tl-cell .tl-track.end{border-radius:0 4px 4px 0;right:4px;}
.tl-cell .dot{position:relative;z-index:1;}
.tl-hd{width:36px;flex:none;font-size:9.5px;color:#B8AE9D;text-align:center;font-weight:700;padding-bottom:4px;white-space:nowrap;}
.tl-cell.now{background:rgba(15,169,104,0.07);border-radius:6px;}
.tl-legend{display:flex;gap:16px;margin-top:12px;font-size:12px;color:#9C9284;align-items:center;flex-wrap:wrap;}

/* ---------- reports ---------- */
.rep-pick{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;}
.rep-out{width:100%;border:1.5px solid #D8D1C7;border-radius:12px;background:#FDFBF6;font-family:Georgia,'Times New Roman',serif;font-size:14px;line-height:1.65;color:#2B2B2B;padding:16px 18px;min-height:340px;resize:vertical;}
.rep-out:focus{outline:none;border-color:#0FA968;box-shadow:0 0 0 3px rgba(15,169,104,0.12);}
.rep-note{font-size:12.5px;color:#9C9284;margin-top:8px;}

/* ---------- JD mining ---------- */
.jd-toggle{display:block;margin:2px auto 0;background:none;border:none;font-size:13px;font-weight:600;color:#9C9284;cursor:pointer;text-decoration:underline;text-underline-offset:3px;}
.jd-toggle:hover{color:#0B7A4B;}
.jd-suggest{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px;justify-content:center;}

/* ---------- vitals bar ---------- */
.vitals{background:#2B2B2B;position:relative;z-index:1;margin-top:10px;}
.vitals-in{max-width:980px;margin:0 auto;padding:7px 16px;display:flex;gap:8px;overflow-x:auto;}
.vital{display:flex;align-items:center;gap:8px;background:rgba(246,241,231,0.09);border:1.5px solid rgba(246,241,231,0.28);border-radius:99px;padding:6px 14px;cursor:pointer;white-space:nowrap;transition:all .15s ease;box-shadow:0 1px 3px rgba(0,0,0,0.25);}
.vital:hover{background:rgba(246,241,231,0.18);border-color:rgba(246,241,231,0.55);transform:translateY(-1px);}
.vital:active{transform:translateY(0);}
.vital .vt-label{font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:rgba(246,241,231,0.55);}
.vital .vt-value{font-size:13px;font-weight:800;color:#F6F1E7;}
.vital .vt-go{font-size:14px;font-weight:800;color:rgba(246,241,231,0.5);margin-left:2px;transition:transform .15s ease,color .15s ease;}
.vital:hover .vt-go{color:#F6F1E7;transform:translateX(2px);}
.vt-row{display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid #EAE2D4;}
.vt-row:first-of-type{border-top:none;}
.vt-row .vt-who{flex:1;min-width:0;}
.vt-row .vt-nm{font-weight:700;font-size:14px;}
.vt-row .vt-rl{font-size:12px;color:#9C9284;}
.vt-band{font-size:12.5px;color:#9C9284;margin-top:2px;}
.vt-banner{background:#FAE3DF;border:1.5px solid rgba(206,59,44,0.35);border-radius:12px;padding:12px 16px;margin-bottom:14px;}
.vt-banner .vb-title{font-size:12px;font-weight:800;letter-spacing:0.07em;text-transform:uppercase;color:#CE3B2C;}
.vt-banner .vb-sub{font-size:13px;color:#8A453C;line-height:1.5;margin-top:2px;}
.vt-gauge-labels{display:flex;justify-content:space-between;font-size:11px;color:#9C9284;font-weight:600;margin-top:2px;}
.load-pill{display:inline-block;font-size:12px;font-weight:800;padding:2px 10px;border-radius:8px;white-space:nowrap;}
.pcat{display:inline-flex;align-items:center;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;padding:2px 10px;border-radius:6px;background:#DFF6EA;color:#0C8F58;border:1px solid rgba(12,143,88,0.3);white-space:nowrap;}
.pc-needs{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin:2px 0 4px;}
.pc-team{margin-top:10px;border-top:1px solid #EAE2D4;padding-top:9px;display:flex;flex-direction:column;gap:5px;}
.pc-person{display:flex;align-items:center;gap:8px;font-size:13px;}
.pc-person .pc-nm{font-weight:700;}
.pc-person .pc-status{color:#9C9284;font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}

@keyframes jovIn{from{opacity:0;}to{opacity:1;}}
@keyframes stepIn{from{opacity:0;transform:translateX(26px);}to{opacity:1;transform:none;}}
@keyframes fadeUp{from{opacity:0;transform:translateY(5px);}to{opacity:1;transform:none;}}
@media (prefers-reduced-motion: reduce){
  .noon-root *,.jov,.jbody{animation:none !important;transition:none !important;}
}

/* ---------- mobile ---------- */
@media(max-width:640px){
  .hdr{padding:16px 16px 4px;flex-wrap:wrap;gap:6px;}
  .nav{margin-left:auto;}
  .nav button{font-size:12px;padding:5px 10px;}
  .container{padding:10px 16px 80px;}
  .page-title{font-size:22px;}
  .card{padding:16px 16px;}
  .cap-ta{min-height:110px;font-size:16px;}
  .cap-group-label{width:100%;}
  .team-row{flex-wrap:wrap;}
  .btn,.btn-green,.btn2{padding:11px 22px;}
  .linkcard .lc-num{font-size:19px;}
}
`;

/* ============================== atoms ============================== */

function Dot({ color }) {
  return <span className="dot" style={{ background: color }} />;
}

function StatusPill({ status }) {
  const m = status ? STATUS_META[status] : NO_STATUS;
  return (
    <span className="pill" style={{ background: m.tint, color: m.color }}>
      <Dot color={m.color} /> {m.label}
    </span>
  );
}

function Avatar({ name }) {
  return <span className="av">{initials(name)}</span>;
}

function ConfirmBtn({ label, confirmLabel, onConfirm, className }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={(className || "btn-danger") + (armed ? " armed" : "")}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
    >
      {armed ? confirmLabel || "Click again to confirm" : label}
    </button>
  );
}

function TagInput({ id, value, onChange, placeholder, variant }) {
  const [text, setText] = useState("");
  const commit = () => {
    const t = text.trim().replace(/,+$/, "").trim();
    if (t && !value.some((v) => v.toLowerCase() === t.toLowerCase())) {
      onChange([...value, t]);
    }
    setText("");
  };
  return (
    <div>
      {value.length > 0 && (
        <div className="tagrow" style={{ marginBottom: 8 }}>
          {value.map((t) => (
            <span key={t} className={"tag" + (variant === "stretch" ? " stretch" : "")}>
              {t}
              <button
                type="button"
                className="tag-x"
                aria-label={"Remove " + t}
                onClick={() => onChange(value.filter((x) => x !== t))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        id={id}
        className="inp"
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}

function TagList({ tags, variant, none }) {
  if (!tags || tags.length === 0) return <span className="tag-none">{none}</span>;
  return (
    <span className="tagrow">
      {tags.map((t) => (
        <span key={t} className={"tag" + (variant === "stretch" ? " stretch" : "")}>
          {t}
        </span>
      ))}
    </span>
  );
}

/* Percent input: local state, commits on blur. Caps a single project at
   100% — but says so out loud instead of silently rewriting the number. */
function PctInput({ id, value, onCommit, mini }) {
  const [v, setV] = useState(String(value));
  const [warn, setWarn] = useState(false);
  useEffect(() => setV(String(value)), [value]);
  return (
    <span style={{ display: "inline-block" }}>
      <input
        id={id}
        className={"inp num" + (mini ? " mini" : "")}
        type="number"
        min={0}
        max={100}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const over = Number(v) > 100;
          const n = clampPct(v);
          setV(String(n));
          if (over) {
            setWarn(true);
            setTimeout(() => setWarn(false), 3500);
          } else setWarn(false);
          if (n !== value) onCommit(n);
        }}
      />
      {warn && (
        <span className="pct-warn">
          one project maxes at 100% — overload shows on their total
        </span>
      )}
    </span>
  );
}

/* Load-colored allocation bar: green when healthy, amber when loaded, red
   past 100% — the overflow draws beyond the tick, never capped. */
function loadColor(total) {
  return total > 100 ? "#CE3B2C" : total > 75 ? "#E39310" : "#1E9E63";
}
function loadTint(total) {
  return total > 100 ? "#FAE3DF" : total > 75 ? "#FBEFD6" : "#DFF3E8";
}
function AllocBar({ total }) {
  const scale = Math.max(total, 100);
  const base = Math.min(total, 100);
  return (
    <div className="alloc-bar">
      <i
        className={"ab-base" + (total <= 100 ? " only" : "")}
        style={{ width: (base / scale) * 100 + "%", background: loadColor(total) }}
      />
      {total > 100 && <i className="ab-over" style={{ width: ((total - 100) / scale) * 100 + "%" }} />}
      {total > 100 && <span className="ab-tick" style={{ left: (100 / scale) * 100 + "%" }} />}
    </div>
  );
}

function BlurTextarea({ id, value, onCommit, placeholder }) {
  const [v, setV] = useState(value || "");
  useEffect(() => setV(value || ""), [value]);
  return (
    <textarea
      id={id}
      className="ta"
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (v !== (value || "")) onCommit(v);
      }}
    />
  );
}

/* One-line quick capture for out-of-project field notes. */
function QuickNote({ id, onAdd }) {
  const [text, setText] = useState("");
  const commit = () => {
    const t = text.trim();
    if (t) onAdd(t);
    setText("");
  };
  return (
    <input
      id={id}
      className="inp"
      style={{ marginTop: 6 }}
      value={text}
      placeholder="Noticed something? Jot it — press Enter"
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

function BlurText({ id, value, onCommit, placeholder }) {
  const [v, setV] = useState(value || "");
  useEffect(() => setV(value || ""), [value]);
  return (
    <input
      id={id}
      className="inp"
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (v !== (value || "")) onCommit(v);
      }}
    />
  );
}

const CAP_OPTS = [
  [25, "a slice"],
  [50, "half their week"],
  [75, "most of it"],
  [100, "all in"],
];

function CapChips({ value, onChange, id }) {
  const [warn, setWarn] = useState(false);
  const set = (raw) => {
    if (Number(raw) > 100) {
      setWarn(true);
      setTimeout(() => setWarn(false), 3500);
    }
    onChange(clampPct(raw));
  };
  return (
    <div className="capwrap">
      <div className="capchips">
        {CAP_OPTS.map(([v, l]) => (
          <button
            key={v}
            type="button"
            className={"chip-btn" + (value === v ? " on" : "")}
            onClick={() => onChange(v)}
          >
            <b>{v}%</b> — {l}
          </button>
        ))}
      </div>
      <span className="capcustom">
        or exactly
        <input
          id={id}
          className="inp mini"
          type="number"
          min={0}
          max={100}
          value={value}
          onChange={(e) => set(e.target.value)}
        />
        % of their week
      </span>
      {warn && <span className="pct-warn">one project maxes at 100% — overload shows on their total</span>}
    </div>
  );
}

/* ============================ journey shell ============================ */

function Journey({ eyebrow, waypoints, step, maxVisited, onStepClick, onClose, children, footer, steplbl }) {
  return (
    <div className="jov">
      <div className="jov-in">
        <div className="jov-top">
          <span className="jov-eyebrow">{eyebrow}</span>
          <button className="jov-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {waypoints && waypoints.length > 1 && (
          <div className="path">
            {waypoints.map((w, i) => (
              <React.Fragment key={w}>
                {i > 0 && <div className={"seg" + (i <= step ? " done" : "")} />}
                <button
                  type="button"
                  className={"wp" + (i === step ? " now" : i <= maxVisited ? " done" : "")}
                  onClick={() => {
                    if (i <= maxVisited && i !== step) onStepClick(i);
                  }}
                >
                  <span className="node" />
                  <span className="wlbl">{w}</span>
                </button>
              </React.Fragment>
            ))}
          </div>
        )}
        <div className="jbody" key={step}>
          {children}
        </div>
        <div className="jfoot">{footer}</div>
        {steplbl && <div className="jsteplbl">{steplbl}</div>}
      </div>
    </div>
  );
}

/* ============================ member journey ============================ */

function MemberJourney({ member, onSave, onClose }) {
  const editing = !!(member && member.id);
  const [step, setStep] = useState(0);
  const [maxVisited, setMaxVisited] = useState(editing ? 2 : 0);
  const [name, setName] = useState(member ? member.name : "");
  const [role, setRole] = useState(member ? member.role || "" : "");
  const [years, setYears] = useState(member ? String(member.yearsExperience) : "3");
  const [resp, setResp] = useState(member ? member.responsibilityLevel : 3);
  const [core, setCore] = useState(member ? member.coreCompetencies || [] : []);
  const [stretch, setStretch] = useState(member ? member.stretchCompetencies || [] : []);
  const [jdOpen, setJdOpen] = useState(false);
  const [jd, setJd] = useState("");
  const jdSkills = useMemo(() => (jd.trim() ? extractSkills(jd) : []), [jd]);

  const first = firstName(name);

  const save = () =>
    onSave({
      ...(member || {}),
      name: name.trim(),
      role: role.trim(),
      yearsExperience: Math.max(0, Number(years) || 0),
      responsibilityLevel: Math.max(1, Math.min(5, Number(resp) || 3)),
      coreCompetencies: core,
      stretchCompetencies: stretch,
    });

  const goto = (i) => {
    setStep(i);
    setMaxVisited((m) => Math.max(m, i));
  };
  const next = () => (step < 2 ? goto(step + 1) : save());

  const stepWords = ["who they are", "what they're strong at", "how much you hand them"];
  const counts = ["one", "two", "three"];

  return (
    <Journey
      eyebrow={editing ? "The roster · " + name : "New to the roster"}
      waypoints={["Who", "Strengths", "Trust"]}
      step={step}
      maxVisited={maxVisited}
      onStepClick={goto}
      onClose={onClose}
      steplbl={counts[step] + " of three — " + stepWords[step]}
      footer={
        <React.Fragment>
          {step > 0 && (
            <button className="skip" onClick={() => setStep(step - 1)}>
              ← back
            </button>
          )}
          {step < 2 &&
            (editing ? (
              <button className="skip" onClick={save}>
                save now
              </button>
            ) : (
              <button className="skip" onClick={next}>
                decide later
              </button>
            ))}
          <button className="btn" disabled={!name.trim()} onClick={next}>
            {step < 2 ? "Next →" : editing ? "Save changes ✓" : "Add " + first + " ✓"}
          </button>
        </React.Fragment>
      }
    >
      {step === 0 && (
        <React.Fragment>
          <h2 className="jq">{editing ? "About " + first : "Who's joining your roster?"}</h2>
          <p className="jsub">Just their name and what they do — everything else can come later.</p>
          <div className="jfield">
            <label htmlFor="m-name">Their name</label>
            <input
              id="m-name"
              className="inp"
              value={name}
              autoFocus={!editing}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
            />
          </div>
          <div className="jfield">
            <label htmlFor="m-role">What they do</label>
            <input
              id="m-role"
              className="inp"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. Service designer"
            />
          </div>
        </React.Fragment>
      )}

      {step === 1 && (
        <React.Fragment>
          <h2 className="jq">What is {first} strong at?</h2>
          <p className="jsub">
            Core is what you'd stake a deadline on. Stretch is where they're growing — the
            promotion-track stuff.
          </p>
          <div className="jfield">
            <label htmlFor="m-core">Core — solid ground</label>
            <TagInput
              id="m-core"
              value={core}
              onChange={setCore}
              placeholder="Type a skill, press Enter…"
            />
          </div>
          <div className="jfield">
            <label htmlFor="m-stretch">Stretch — reaching for</label>
            <TagInput
              id="m-stretch"
              value={stretch}
              onChange={setStretch}
              variant="stretch"
              placeholder="Type a skill, press Enter…"
            />
          </div>
          <button type="button" className="jd-toggle" onClick={() => setJdOpen(!jdOpen)}>
            {jdOpen ? "hide the JD miner" : "…or paste their JD and mine it for skills"}
          </button>
          {jdOpen && (
            <div className="jfield" style={{ marginTop: 12 }}>
              <textarea
                id="m-jd"
                className="ta"
                value={jd}
                onChange={(e) => setJd(e.target.value)}
                placeholder="Paste the job description or role doc here…"
              />
              {jdSkills.length > 0 && (
                <React.Fragment>
                  <div className="jd-suggest">
                    {jdSkills.map((s) => {
                      const inCore = core.some((c) => c.toLowerCase() === s.toLowerCase());
                      return (
                        <button
                          key={s}
                          type="button"
                          className={"chip-btn" + (inCore ? " on" : "")}
                          onClick={() =>
                            inCore
                              ? setCore(core.filter((c) => c.toLowerCase() !== s.toLowerCase()))
                              : setCore([...core, s])
                          }
                        >
                          {s}
                        </button>
                      );
                    })}
                  </div>
                  <p className="jsub" style={{ margin: "10px 0 0", fontSize: 12.5 }}>
                    Tap a phrase to add it to Core — you can retag anything to Stretch later.
                  </p>
                </React.Fragment>
              )}
            </div>
          )}
        </React.Fragment>
      )}

      {step === 2 && (
        <React.Fragment>
          <h2 className="jq">How much can you hand {first}?</h2>
          <p className="jsub">Your gut read is fine — noon adjusts as the weeks come in.</p>
          <div className="rgrid">
            {RESP_CARDS.map((c) => (
              <div
                key={c.level}
                className={"ccard" + (resp === c.level ? " sel" : "")}
                onClick={() => setResp(c.level)}
              >
                <div className="ic" />
                <h4>{c.title}</h4>
                <p>{c.desc}</p>
              </div>
            ))}
          </div>
          <div className="yrsrow">
            <span>And how long have they been at it?</span>
            <input
              id="m-exp"
              className="inp mini"
              type="number"
              min={0}
              max={60}
              value={years}
              onChange={(e) => setYears(e.target.value)}
            />
            <span>
              years — reads as <span className="bucket">{expBucket(years)}</span>
            </span>
          </div>
        </React.Fragment>
      )}
    </Journey>
  );
}

/* ============================ project journey ============================ */

function PeoplePicker({ people, selections, onToggle, onSetCap }) {
  const [warnId, setWarnId] = useState(null);
  const set = (id, raw) => {
    if (Number(raw) > 100) {
      setWarnId(id);
      setTimeout(() => setWarnId((w) => (w === id ? null : w)), 3500);
    }
    onSetCap(id, clampPct(raw));
  };
  return (
    <div className="pgrid">
      {people.map((m) => {
        const sel = selections[m.id] != null;
        return (
          <div key={m.id} className={"pcard" + (sel ? " sel" : "")} onClick={() => onToggle(m.id)}>
            <div className="row">
              <Avatar name={m.name} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="pnm">{m.name}</div>
                <div className="prl">{m.role || "—"}</div>
              </div>
              {sel && <span className="ptick">✓</span>}
            </div>
            {sel && (
              <div className="pcaps" onClick={(e) => e.stopPropagation()}>
                {CAP_OPTS.map(([v]) => (
                  <button
                    key={v}
                    type="button"
                    className={"chip-btn" + (selections[m.id] === v ? " on" : "")}
                    onClick={() => onSetCap(m.id, v)}
                  >
                    {v}%
                  </button>
                ))}
                <input
                  className="inp mini"
                  type="number"
                  min={0}
                  max={100}
                  value={selections[m.id]}
                  onChange={(e) => set(m.id, e.target.value)}
                />
                {warnId === m.id && (
                  <span className="pct-warn">one project maxes at 100%</span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ProjectJourney({ members, onCreate, onClose }) {
  const [step, setStep] = useState(0);
  const [maxVisited, setMaxVisited] = useState(0);
  const [name, setName] = useState("");
  const [cat, setCat] = useState("");
  const [desc, setDesc] = useState("");
  const [req, setReq] = useState("");
  const [start, setStart] = useState(toISODate(new Date()));
  const [selections, setSelections] = useState({});

  const goto = (i) => {
    setStep(i);
    setMaxVisited((m) => Math.max(m, i));
  };
  const create = () =>
    onCreate(
      { name, category: cat, description: desc, requirements: req, startDate: start },
      selections
    );
  const next = () => (step < 2 ? goto(step + 1) : create());

  const nSel = Object.keys(selections).length;
  const stepWords = ["the idea", "the shape of it", "the people"];
  const counts = ["one", "two", "three"];

  return (
    <Journey
      eyebrow="A new case file"
      waypoints={["Idea", "Shape", "People"]}
      step={step}
      maxVisited={maxVisited}
      onStepClick={goto}
      onClose={onClose}
      steplbl={counts[step] + " of three — " + stepWords[step]}
      footer={
        <React.Fragment>
          {step > 0 && (
            <button className="skip" onClick={() => setStep(step - 1)}>
              ← back
            </button>
          )}
          {step === 1 && (
            <button className="skip" onClick={next}>
              decide later
            </button>
          )}
          {step === 2 && nSel === 0 && (
            <button className="skip" onClick={create}>
              add people later
            </button>
          )}
          <button className="btn" disabled={!name.trim()} onClick={next}>
            {step < 2
              ? "Next →"
              : nSel > 0
              ? "Start the case file · " + nSel + (nSel === 1 ? " person ✓" : " people ✓")
              : "Start the case file ✓"}
          </button>
        </React.Fragment>
      }
    >
      {step === 0 && (
        <React.Fragment>
          <h2 className="jq">What are we calling this one?</h2>
          <p className="jsub">A name is enough to open the file. You can shape it in a moment.</p>
          <div className="jfield">
            <label htmlFor="p-name">Project name</label>
            <input
              id="p-name"
              className="inp"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Q3 service redesign"
            />
          </div>
          <div className="jrow">
            <div className="jfield">
              <label htmlFor="p-cat">What kind of work? (optional)</label>
              <input
                id="p-cat"
                className="inp"
                value={cat}
                onChange={(e) => setCat(e.target.value)}
                placeholder="e.g. Strategy & Ops"
              />
            </div>
            <div className="jfield" style={{ maxWidth: 200 }}>
              <label htmlFor="p-start">When it kicks off</label>
              <input
                id="p-start"
                className="inp"
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
          </div>
        </React.Fragment>
      )}

      {step === 1 && (
        <React.Fragment>
          <h2 className="jq">What is {name.trim() || "it"}, really?</h2>
          <p className="jsub">Two honest sentences beat a brief nobody reads.</p>
          <div className="jfield">
            <label htmlFor="p-desc">In a sentence or two — what is it?</label>
            <textarea
              id="p-desc"
              className="ta"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="The elevator version…"
            />
          </div>
          <div className="jfield">
            <label htmlFor="p-req">What does it need to succeed?</label>
            <textarea
              id="p-req"
              className="ta"
              value={req}
              onChange={(e) => setReq(e.target.value)}
              placeholder="Skills, deliverables, constraints, deadlines…"
            />
          </div>
          <input
            type="file"
            id="p-doc"
            accept=".txt,.md,text/plain,text/markdown"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files && e.target.files[0];
              if (!f) return;
              const r = new FileReader();
              r.onload = () =>
                setReq((prev) => (prev ? prev + "\n\n" : "") + String(r.result).slice(0, 4000));
              r.readAsText(f);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="jd-toggle"
            onClick={() => document.getElementById("p-doc").click()}
          >
            …or upload the kickoff doc (.txt / .md) — it drops straight into the brief
          </button>
        </React.Fragment>
      )}

      {step === 2 && (
        <React.Fragment>
          <h2 className="jq">Who's on it from day one?</h2>
          <p className="jsub">
            Tap to add someone and give them a slice of their week. This can change any time.
          </p>
          {members.length === 0 ? (
            <p className="jsub" style={{ marginTop: 10 }}>
              Your roster is empty — no problem. Start the file now and add people as they
              join.
            </p>
          ) : (
            <PeoplePicker
              people={members}
              selections={selections}
              onToggle={(id) =>
                setSelections((s) => {
                  const n = { ...s };
                  if (n[id] != null) delete n[id];
                  else n[id] = 50;
                  return n;
                })
              }
              onSetCap={(id, v) => setSelections((s) => ({ ...s, [id]: v }))}
            />
          )}
        </React.Fragment>
      )}
    </Journey>
  );
}

/* ============================ assign journey ============================ */

function AssignJourney({ bundle, members, membersById, preselect, onAssign, onNewPerson, onClose }) {
  const assignedIds = bundle.assignments.map((a) => a.memberId);
  const available = members.filter((m) => !assignedIds.includes(m.id));
  const [selections, setSelections] = useState(() =>
    preselect && available.some((m) => m.id === preselect) ? { [preselect]: 50 } : {}
  );
  const nSel = Object.keys(selections).length;

  return (
    <Journey
      eyebrow={"The case file · " + bundle.project.name}
      onClose={onClose}
      footer={
        <React.Fragment>
          <button className="skip" onClick={onNewPerson}>
            + someone new
          </button>
          <button className="btn2" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={nSel === 0} onClick={() => onAssign(selections)}>
            {nSel === 0
              ? "Add to the project"
              : "Add " + nSel + (nSel === 1 ? " person ✓" : " people ✓")}
          </button>
        </React.Fragment>
      }
    >
      <h2 className="jq">Who's joining {bundle.project.name}?</h2>
      <p className="jsub">
        Tap to add someone and give them a slice of their week.
        {bundle.assignments.length > 0 &&
          " Already on it: " +
            bundle.assignments
              .map((a) => {
                const m = membersById[a.memberId];
                return (m ? m.name : "?") + " (" + a.capacityAllocated + "%)";
              })
              .join(", ") +
            "."}
      </p>
      {available.length === 0 ? (
        <p className="jsub" style={{ marginTop: 10 }}>
          {members.length === 0
            ? "Your roster is empty — start with someone new below."
            : "Everyone on your roster is already on this project. Add someone new below."}
        </p>
      ) : (
        <PeoplePicker
          people={available}
          selections={selections}
          onToggle={(id) =>
            setSelections((s) => {
              const n = { ...s };
              if (n[id] != null) delete n[id];
              else n[id] = 50;
              return n;
            })
          }
          onSetCap={(id, v) => setSelections((s) => ({ ...s, [id]: v }))}
        />
      )}
    </Journey>
  );
}

/* ============================ trust profile ============================ */

function TrustCard({ member }) {
  return (
    <div className="trust">
      <div className="trust-sec">
        <span className="label">Competencies</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div>
            <span className="mini-label">Core</span>
            <TagList tags={member.coreCompetencies} none="none noted yet" />
          </div>
          <div>
            <span className="mini-label">Stretch</span>
            <TagList tags={member.stretchCompetencies} variant="stretch" none="none noted yet" />
          </div>
        </div>
      </div>
      <div className="trust-sec">
        <span className="label">Experience</span>
        <div className="trust-line">
          {expBucket(member.yearsExperience)}
          <span className="trust-sub">
            {" "}
            · {Number(member.yearsExperience) || 0}{" "}
            {Number(member.yearsExperience) === 1 ? "year" : "years"}
          </span>
        </div>
      </div>
      <div className="trust-sec">
        <span className="label">Responsibility</span>
        <div
          className="resp-dots"
          aria-label={"Responsibility level " + member.responsibilityLevel + " of 5"}
        >
          {[1, 2, 3, 4, 5].map((i) => (
            <i key={i} className={i <= member.responsibilityLevel ? "f" : ""} />
          ))}
        </div>
        <div className="trust-sub">{RESP_LABELS[member.responsibilityLevel] || ""}</div>
      </div>
    </div>
  );
}

/* ============================ notebook log row ============================ */

function LogRow({ log, membersById, projectsById, onAnnotate, onDelete, showWho }) {
  const [annOpen, setAnnOpen] = useState(false);
  const [annText, setAnnText] = useState("");
  const meta = LOG_META[log.type] || LOG_META.core;
  const m = log.memberId ? membersById[log.memberId] : null;
  const p = log.projectId ? projectsById[log.projectId] : null;
  return (
    <div className="logrow">
      <div className="lg-meta">
        {showWho !== false && <span className="lg-who">{m ? m.name : "General"}</span>}
        <span className="lg-tag" style={{ background: meta.tint, color: meta.color }}>
          <Dot color={meta.color} /> {meta.label}
        </span>
        <span className="lg-date">{p ? p.name : "general"} · {fmtDate(log.date)}</span>
      </div>
      <div className="lg-txt">{log.text}</div>
      {(log.annotations || []).map((a) => (
        <div className="lg-ann" key={a.id}>
          <span className="fn-date">{fmtWeek(a.date)}</span>
          {a.text}
        </div>
      ))}
      <div className="lg-actions">
        <button type="button" onClick={() => setAnnOpen(!annOpen)}>
          {annOpen ? "cancel" : "+ add context"}
        </button>
        <ConfirmBtn label="delete" confirmLabel="really delete?" onConfirm={() => onDelete(log.id)} />
      </div>
      {annOpen && (
        <div className="lg-annin">
          <input
            className="inp"
            value={annText}
            placeholder="Add context — this appends underneath, never overwrites. Press Enter."
            autoFocus
            onChange={(e) => setAnnText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && annText.trim()) {
                onAnnotate(log.id, annText);
                setAnnText("");
                setAnnOpen(false);
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

/* ============================== home ============================== */

function HomePage({ members, bundles, logs, membersById, projectsById, onAddLog, onAnnotate, onDeleteLog, go }) {
  const [text, setText] = useState("");
  const [over, setOver] = useState({});
  const [flash, setFlash] = useState("");
  const [recording, setRecording] = useState(false);
  const recRef = useRef(null);

  /* Voice capture via the browser's built-in speech recognition — no cloud
     service. The button only appears where the API exists; typing is always
     the fallback. */
  const SR =
    typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);
  const toggleRec = () => {
    if (recording) {
      if (recRef.current) recRef.current.stop();
      return;
    }
    try {
      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = false;
      rec.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
      rec.onresult = (e) => {
        let t = "";
        for (let i = e.resultIndex; i < e.results.length; i++)
          if (e.results[i].isFinal) t += e.results[i][0].transcript;
        if (t.trim()) setText((prev) => (prev ? prev.trim() + " " : "") + t.trim());
      };
      rec.onend = () => setRecording(false);
      rec.onerror = () => setRecording(false);
      recRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      setRecording(false);
    }
  };
  useEffect(() => () => {
    if (recRef.current) recRef.current.stop();
  }, []);

  const suggestion = useMemo(
    () => (text.trim() ? parseCapture(text, members, bundles) : { memberId: null, projectId: null, type: "core" }),
    [text, members, bundles]
  );
  const eff = {
    memberId: over.memberId !== undefined ? over.memberId : suggestion.memberId,
    projectId: over.projectId !== undefined ? over.projectId : suggestion.projectId,
    type: over.type !== undefined ? over.type : suggestion.type,
  };

  const activeBundles = bundles.filter((b) => b.project.status === "active");

  const commit = () => {
    if (!text.trim()) return;
    onAddLog({ memberId: eff.memberId, projectId: eff.projectId, type: eff.type, text });
    const who = eff.memberId && membersById[eff.memberId];
    setText("");
    setOver({});
    // Show what this page just fed — the payoff for logging diligently.
    setFlash(
      who
        ? "Filed ✓ → " + firstName(who.name) + "'s review pack · your next 1:1 · the team brief"
        : "Filed ✓ → the team brief"
    );
    setTimeout(() => setFlash(""), 3200);
  };

  /* alerts: recent redlines, over-committed people, stuck projects */
  const cut = new Date();
  cut.setDate(cut.getDate() - 14);
  const cutoff = toISODate(cut);
  const alerts = [];
  for (const l of logs) {
    if (l.type === "redline" && l.date >= cutoff) {
      const who = l.memberId && membersById[l.memberId] ? membersById[l.memberId].name : "Someone";
      alerts.push({
        color: LOG_META.redline.color,
        text: who + " — redline: “" + l.text + "”",
        page: { name: "roster" },
      });
    }
  }
  for (const m of members) {
    let total = 0;
    let n = 0;
    for (const b of activeBundles)
      for (const a of b.assignments)
        if (a.memberId === m.id) {
          total += Number(a.capacityAllocated) || 0;
          n++;
        }
    if (total > 100)
      alerts.push({
        color: LOG_META.redline.color,
        text: m.name + " is committed at " + total + "% across " + n + " projects — stretched thin",
        page: { name: "week" },
      });
  }
  for (const b of activeBundles)
    for (const a of b.assignments) {
      const latest = latestCheckIn(b.checkIns, a.id);
      if (latest && latest.progressStatus === "blocked") {
        const who = membersById[a.memberId];
        alerts.push({
          color: STATUS_META.blocked.color,
          text: (who ? who.name : "Someone") + " is stuck on " + b.project.name,
          page: { name: "project", id: b.project.id, tab: "progression" },
        });
      }
    }

  const peopleOnActive = new Set();
  for (const b of activeBundles) for (const a of b.assignments) peopleOnActive.add(a.memberId);

  return (
    <div>
      <h1 className="page-title">The notebook</h1>
      <p className="page-sub">Jot what you noticed — noon files it. That's the whole habit.</p>

      <div className="cap-card">
        <textarea
          id="cap-text"
          className="cap-ta"
          value={text}
          placeholder="What did you notice? e.g. “Aisha ran the pricing workshop unprompted — handled the CFO's pushback well.”"
          onChange={(e) => setText(e.target.value)}
        />
        <div className="cap-rule" />
        <div className="cap-group">
          <span className="cap-group-label">Who</span>
          {members.map((m) => (
            <button
              key={m.id}
              type="button"
              className={"cap-chip" + (eff.memberId === m.id ? " on" : "")}
              onClick={() => setOver({ ...over, memberId: eff.memberId === m.id ? null : m.id })}
            >
              {firstName(m.name)}
            </button>
          ))}
          <button
            type="button"
            className={"cap-chip" + (eff.memberId == null ? " on" : "")}
            onClick={() => setOver({ ...over, memberId: null })}
          >
            no one specific
          </button>
        </div>
        <div className="cap-group">
          <span className="cap-group-label">Where</span>
          {activeBundles.map((b) => (
            <button
              key={b.project.id}
              type="button"
              className={"cap-chip" + (eff.projectId === b.project.id ? " on" : "")}
              onClick={() =>
                setOver({ ...over, projectId: eff.projectId === b.project.id ? null : b.project.id })
              }
            >
              {b.project.name}
            </button>
          ))}
          <button
            type="button"
            className={"cap-chip" + (eff.projectId == null ? " on" : "")}
            onClick={() => setOver({ ...over, projectId: null })}
          >
            general
          </button>
        </div>
        <div className="cap-group">
          <span className="cap-group-label">Read</span>
          {Object.keys(LOG_META).map((t) => (
            <button
              key={t}
              type="button"
              className={"cap-chip" + (eff.type === t ? " on t-" + t : "")}
              onClick={() => setOver({ ...over, type: t })}
            >
              {LOG_META[t].label} · {LOG_META[t].desc}
            </button>
          ))}
        </div>
        <div className="cap-foot">
          <span className="cap-hint">
            {flash
              ? ""
              : text.trim()
              ? "noon read the tags from your words — tap any to correct before filing."
              : "plain words are enough — tags get read automatically."}
            {flash && <span className="saved-note">{flash}</span>}
          </span>
          {SR && (
            <button
              type="button"
              id="cap-mic"
              className={"mic-btn" + (recording ? " rec" : "")}
              onClick={toggleRec}
            >
              <span className="mic-dot" />
              {recording ? "Listening — tap to stop" : "Voice note"}
            </button>
          )}
          <button id="cap-log" className="btn-green" disabled={!text.trim()} onClick={commit}>
            Log it
          </button>
        </div>
      </div>

      {alerts.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Worth your attention</h3>
          <div className="card-sub">The notes and numbers that shouldn't wait.</div>
          {alerts.slice(0, 5).map((al, i) => (
            <div className="alert-row" key={i}>
              <Dot color={al.color} />
              <span className="al-txt">{al.text}</span>
              <button className="al-link" onClick={() => go(al.page)}>
                view →
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="linkgrid">
        {[
          { num: activeBundles.length, name: "Projects", sub: "case files & timeline", page: { name: "dashboard" } },
          { num: peopleOnActive.size, name: "This week", sub: "plan the load", page: { name: "week" } },
          { num: members.length, name: "People", sub: "trust profiles", page: { name: "roster" } },
          {
            num: 3,
            name: "Reports",
            sub: logs.length
              ? "built from " + logs.length + " filed page" + (logs.length === 1 ? "" : "s")
              : "review-ready drafts",
            page: { name: "reports" },
          },
        ].map((c) => (
          <button key={c.name} type="button" className="linkcard" onClick={() => go(c.page)}>
            <span className="lc-num">{c.num}</span>
            <span className="lc-name">{c.name}</span>
            <span className="lc-sub">{c.sub}</span>
          </button>
        ))}
      </div>

      {logs.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <h3>Recent pages</h3>
              <div className="card-sub" style={{ marginBottom: 0 }}>
                {logs.length} filed · {logs.filter((l) => l.type === "stretch").length} stretch ·{" "}
                {logs.filter((l) => l.type === "redline").length} redline — every page feeds
                Reports.
              </div>
            </div>
            <button className="btn2" onClick={() => go({ name: "reports" })}>
              See what they build →
            </button>
          </div>
          {logs.slice(0, 6).map((l) => (
            <LogRow
              key={l.id}
              log={l}
              membersById={membersById}
              projectsById={projectsById}
              onAnnotate={onAnnotate}
              onDelete={onDeleteLog}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================== reports ============================== */

function buildReport(kind, memberId, members, bundles, logs) {
  const today = fmtDate(toISODate(new Date()));
  const active = bundles.filter((b) => b.project.status === "active");
  const L = [];

  const logsFor = (mid) => logs.filter((l) => l.memberId === mid);
  const quoteLog = (l) => "“" + l.text + "” (" + fmtWeek(l.date) + ")";

  if (kind === "brief") {
    L.push("TEAM BRIEF — " + today);
    L.push("Assembled by noon from your notebook. Every line is editable — make it yours.");
    L.push("");
    L.push("CAPACITY");
    for (const m of members) {
      let total = 0;
      const names = [];
      for (const b of active)
        for (const a of b.assignments)
          if (a.memberId === m.id) {
            total += Number(a.capacityAllocated) || 0;
            names.push(b.project.name + " " + a.capacityAllocated + "%");
          }
      if (total > 100) L.push("- " + m.name + " is committed at " + total + "% (" + names.join(", ") + ") — stretched thin.");
      else if (total > 0) L.push("- " + m.name + ": " + total + "% committed (" + names.join(", ") + ").");
    }
    const reds = logs.filter((l) => l.type === "redline").slice(0, 4);
    if (reds.length) {
      L.push("- Redline notes on file:");
      for (const l of reds) {
        const who = l.memberId && members.find((m) => m.id === l.memberId);
        L.push("    · " + (who ? who.name + ": " : "") + quoteLog(l));
      }
    }
    L.push("");
    L.push("GROWTH");
    let anyGrowth = false;
    for (const m of members) {
      const st = logsFor(m.id).filter((l) => l.type === "stretch");
      if (st.length) {
        anyGrowth = true;
        L.push("- " + m.name + ": " + st.length + " stretch moment" + (st.length === 1 ? "" : "s") + " — latest: " + quoteLog(st[0]));
      }
    }
    if (!anyGrowth) L.push("- No stretch moments filed yet — the notebook fills this in as you jot.");
    L.push("");
    L.push("DELIVERY");
    for (const b of active) {
      const weeks = new Set(b.checkIns.map((c) => c.weekOf));
      const cnt = { "on track": 0, "at risk": 0, blocked: 0 };
      let last = "";
      for (const c of b.checkIns) {
        if (cnt[c.progressStatus] != null) cnt[c.progressStatus]++;
        if (c.weekOf > last) last = c.weekOf;
      }
      L.push(
        "- " + b.project.name + ": " +
          (weeks.size === 0
            ? "no weeks logged yet."
            : cnt["on track"] + " on track / " + cnt["at risk"] + " wobbling / " + cnt.blocked + " stuck across " + weeks.size + " logged week" + (weeks.size === 1 ? "" : "s") + "; last check-in wk of " + fmtWeek(last) + ".")
      );
      if (b.project.retrospective) L.push("    Your read: " + b.project.retrospective);
    }
    L.push("");
    L.push("THE ASK");
    L.push("- [Write your ask — headcount, deadline relief, the promotion case.]");
    return L.join("\n");
  }

  const m = members.find((x) => x.id === memberId);
  if (!m) return "Add someone to your roster first — reports build from their notebook.";
  const mLogs = logsFor(m.id);
  const byType = (t) => mLogs.filter((l) => l.type === t);

  if (kind === "pack") {
    L.push("REVIEW PACK — " + m.name + (m.role ? " (" + m.role + ")" : "") + " — " + today);
    L.push("Everything you filed this year, in one place. The narrative is yours to write.");
    L.push("");
    L.push("PROFILE");
    L.push("- Experience: " + expBucket(m.yearsExperience) + " · " + (Number(m.yearsExperience) || 0) + " years");
    L.push("- Ownership: " + (RESP_LABELS[m.responsibilityLevel] || "—") + " (" + m.responsibilityLevel + "/5)");
    L.push("- Core: " + ((m.coreCompetencies || []).join(", ") || "none noted") + "  ·  Stretch: " + ((m.stretchCompetencies || []).join(", ") || "none noted"));
    L.push("");
    L.push("ON PROJECTS");
    let onAny = false;
    for (const b of bundles) {
      const a = b.assignments.find((x) => x.memberId === m.id);
      if (!a) continue;
      onAny = true;
      const cis = b.checkIns.filter((c) => c.assignmentId === a.id);
      const cnt = { "on track": 0, "at risk": 0, blocked: 0 };
      let sum = 0;
      for (const c of cis) {
        if (cnt[c.progressStatus] != null) cnt[c.progressStatus]++;
        sum += Number(c.capacityActual) || 0;
      }
      let line =
        "- " + b.project.name + (b.project.status !== "active" ? " (wrapped)" : "") + ": planned " + a.capacityAllocated + "%";
      if (cis.length) line += ", actually gave ~" + Math.round(sum / cis.length) + "%, " + cis.length + " check-ins (" + cnt["on track"] + " on track / " + cnt["at risk"] + " wobbling / " + cnt.blocked + " stuck)";
      L.push(line + ".");
      if (a.performanceSummary) L.push("    Your one-liner: “" + a.performanceSummary + "”");
    }
    if (!onAny) L.push("- Not on any project yet.");
    for (const t of ["core", "stretch", "redline"]) {
      const list = byType(t);
      L.push("");
      L.push("NOTEBOOK — " + LOG_META[t].label.toUpperCase() + " (" + list.length + ")");
      if (!list.length) L.push("- nothing filed");
      for (const l of list) L.push("- " + quoteLog(l));
    }
    L.push("");
    L.push("YOUR NARRATIVE");
    L.push("- [Write the story these facts support.]");
    return L.join("\n");
  }

  /* 1:1 talking points */
  const first = firstName(m.name);
  L.push("1:1 TALKING POINTS — " + first + " — " + today);
  L.push("Three zones, built from your own notes. Say it in your voice.");
  L.push("");
  L.push("ZONE 1 — ANCHOR THE WINS");
  const cores = byType("core").slice(0, 3);
  if (cores.length) for (const l of cores) L.push("- " + quoteLog(l));
  else L.push("- Nothing filed yet — open with a genuine recent win.");
  L.push("- Ask: “Which of these felt smoothest? What made it work?”");
  L.push("");
  L.push("ZONE 2 — NAME THE STRETCH");
  const sts = byType("stretch").slice(0, 3);
  if (sts.length) for (const l of sts) L.push("- " + quoteLog(l));
  else L.push("- No stretch moments filed — worth hunting for one together.");
  L.push("- Ask: “Where do you want more rope? What would you take on next?”");
  L.push("");
  L.push("ZONE 3 — CHECK THE REDLINE");
  const reds2 = byType("redline").slice(0, 3);
  if (reds2.length) for (const l of reds2) L.push("- " + quoteLog(l));
  else L.push("- Nothing on file — still worth asking how the load actually feels.");
  L.push("- Frame it as a workload problem you own together — not their stamina problem.");
  L.push("- Ask: “What should we drop or hand off to make next week saner?”");
  return L.join("\n");
}

function ReportsPage({ members, bundles, logs }) {
  const KINDS = [
    ["brief", "Justify upward"],
    ["pack", "Review pack"],
    ["oneone", "1:1 talking points"],
  ];
  const [kind, setKind] = useState("brief");
  const [memberId, setMemberId] = useState(members[0] ? members[0].id : "");
  const [draft, setDraft] = useState(null);
  const [copied, setCopied] = useState(false);

  const generated = useMemo(
    () => buildReport(kind, memberId, members, bundles, logs),
    [kind, memberId, members, bundles, logs]
  );
  const value = draft != null ? draft : generated;

  const copy = () => {
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done, () => {
        const el = document.getElementById("rep-out");
        el.select();
        document.execCommand("copy");
        done();
      });
    } else {
      const el = document.getElementById("rep-out");
      el.select();
      document.execCommand("copy");
      done();
    }
  };

  return (
    <div>
      <h1 className="page-title">Reports</h1>
      <p className="page-sub">
        Assembled from your notebook, never invented — the words stay yours to edit.
      </p>

      <div className="rep-pick">
        {KINDS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={"chip-btn" + (kind === k ? " on" : "")}
            onClick={() => {
              setKind(k);
              setDraft(null);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {kind !== "brief" && (
        <div className="rep-pick">
          {members.map((m) => (
            <button
              key={m.id}
              type="button"
              className={"cap-chip" + (memberId === m.id ? " on" : "")}
              onClick={() => {
                setMemberId(m.id);
                setDraft(null);
              }}
            >
              {m.name}
            </button>
          ))}
        </div>
      )}

      <textarea
        id="rep-out"
        className="rep-out"
        value={value}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="modal-actions" style={{ marginTop: 12 }}>
        {copied && <span className="saved-note">Copied ✓</span>}
        {draft != null && (
          <button className="btn2" onClick={() => setDraft(null)}>
            Rebuild from notebook
          </button>
        )}
        <button className="btn" onClick={copy}>
          Copy text
        </button>
      </div>
      <p className="rep-note">
        Edit freely right here — noon assembles the facts, you write the story.
      </p>
    </div>
  );
}

/* ============================== timeline ============================== */

function ProjectTimeline({ bundles, onOpen }) {
  const tm = thisMonday();
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(tm + "T00:00:00");
    d.setDate(d.getDate() - 7 * i);
    weeks.push(toISODate(d));
  }
  const rows = [...bundles].sort((a, b) =>
    a.project.status === b.project.status ? 0 : a.project.status === "active" ? -1 : 1
  );
  const worstFor = (b, wk) => {
    let worst = null;
    const rank = { blocked: 3, "at risk": 2, "on track": 1 };
    for (const c of b.checkIns)
      if (c.weekOf === wk && (!worst || rank[c.progressStatus] > rank[worst])) worst = c.progressStatus;
    return worst;
  };
  const lastWeekOf = (b) => {
    let last = mondayOf(b.project.startDate || tm);
    for (const c of b.checkIns) if (c.weekOf > last) last = c.weekOf;
    return last;
  };

  return (
    <div className="card">
      <div className="tl-wrap">
        <div className="tl-grid">
          <div className="tl-headrow">
            <div className="tl-name" />
            {weeks.map((w) => (
              <div key={w} className="tl-hd">
                {fmtWeek(w)}
              </div>
            ))}
          </div>
          {rows.map((b) => {
            const startWk = mondayOf(b.project.startDate || tm);
            const endWk = b.project.status === "active" ? tm : lastWeekOf(b);
            return (
              <div className="tl-row" key={b.project.id}>
                <button
                  type="button"
                  className={"tl-name btn-txt" + (b.project.status !== "active" ? " dim" : "")}
                  style={{ textAlign: "left", padding: "8px 10px 8px 0" }}
                  onClick={() => onOpen(b.project.id, "progression")}
                >
                  {b.project.name}
                </button>
                {weeks.map((w) => {
                  const inRange = w >= startWk && w <= endWk;
                  const worst = inRange ? worstFor(b, w) : null;
                  return (
                    <div key={w} className={"tl-cell" + (w === tm ? " now" : "")}>
                      {inRange && (
                        <span
                          className={
                            "tl-track" + (w === startWk ? " start" : "") + (w === endWk ? " end" : "")
                          }
                        />
                      )}
                      {worst && <Dot color={STATUS_META[worst].color} />}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <div className="tl-legend">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <Dot color={STATUS_META["on track"].color} /> on track
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <Dot color={STATUS_META["at risk"].color} /> wobbling
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <Dot color={STATUS_META.blocked.color} /> stuck
        </span>
        <span>· current week highlighted · worst status shown per week</span>
      </div>
    </div>
  );
}

/* ============================== vitals ============================== */

function computeVitals(members, bundles, logs) {
  const active = bundles.filter((b) => b.project.status === "active");
  const perMember = [];
  for (const m of members) {
    let total = 0;
    const items = [];
    for (const b of active)
      for (const a of b.assignments)
        if (a.memberId === m.id) {
          total += Number(a.capacityAllocated) || 0;
          items.push({ bundle: b, assignment: a });
        }
    if (items.length) perMember.push({ member: m, total, items });
  }
  const avg = perMember.length
    ? Math.round(perMember.reduce((s, r) => s + r.total, 0) / perMember.length)
    : 0;

  const cut = new Date();
  cut.setDate(cut.getDate() - 14);
  const cutoff = toISODate(cut);
  const redLogs = logs.filter((l) => l.type === "redline" && l.date >= cutoff);
  const redPeople = new Set(redLogs.map((l) => l.memberId).filter(Boolean));
  for (const r of perMember) if (r.total > 100) redPeople.add(r.member.id);

  const cut30 = new Date();
  cut30.setDate(cut30.getDate() - 30);
  const stretchLogs = logs.filter((l) => l.type === "stretch" && l.date >= toISODate(cut30));

  return { avg, perMember, redLogs, redCount: redPeople.size, stretchLogs };
}

function VitalsBar({ members, bundles, logs, onOpen }) {
  const v = computeVitals(members, bundles, logs);
  const loadColor =
    v.perMember.length === 0
      ? "#9C9284"
      : v.avg > 95
      ? LOG_META.redline.color
      : v.avg > 75
      ? STATUS_META["at risk"].color
      : STATUS_META["on track"].color;
  return (
    <div className="vitals">
      <div className="vitals-in">
        <button className="vital" id="vital-load" onClick={() => onOpen("load")}>
          <Dot color={loadColor} />
          <span className="vt-label">Team load</span>
          <span className="vt-value">{v.perMember.length ? v.avg + "% avg" : "—"}</span>
          <span className="vt-go">›</span>
        </button>
        <button className="vital" id="vital-redline" onClick={() => onOpen("redline")}>
          <Dot color={v.redCount > 0 ? LOG_META.redline.color : STATUS_META["on track"].color} />
          <span className="vt-label">Redline</span>
          <span className="vt-value">
            {v.redCount > 0 ? v.redCount + (v.redCount === 1 ? " person" : " people") : "clear"}
          </span>
          <span className="vt-go">›</span>
        </button>
        <button className="vital" id="vital-stretch" onClick={() => onOpen("stretch")}>
          <Dot color="#0FA968" />
          <span className="vt-label">Stretch</span>
          <span className="vt-value">
            {v.stretchLogs.length} moment{v.stretchLogs.length === 1 ? "" : "s"}
          </span>
          <span className="vt-go">›</span>
        </button>
      </div>
    </div>
  );
}

function VitalsOverlay({
  tab,
  onTab,
  onClose,
  members,
  bundles,
  logs,
  membersById,
  projectsById,
  onAnnotate,
  onDeleteLog,
  go,
}) {
  const v = computeVitals(members, bundles, logs);
  const over = v.perMember.filter((r) => r.total > 100);
  const TABS = [
    ["load", "Team load (" + (v.perMember.length ? v.avg + "%" : "—") + ")", "#E39310"],
    ["redline", "Redline (" + v.redCount + ")", "#CE3B2C"],
    ["stretch", "Stretch (" + v.stretchLogs.length + ")", "#0C8F58"],
  ];
  return (
    <div className="jov">
      <div className="jov-in">
        <div className="jov-top">
          <span className="jov-eyebrow">Team health</span>
          <button className="jov-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <h2 className="jq" style={{ marginTop: 12 }}>
          The vitals
        </h2>
        <p className="jsub">What the chips are counting — and who's behind the numbers.</p>
        <div className="tabs" style={{ justifyContent: "center", margin: "0 0 18px" }}>
          {TABS.map(([k, label, c]) => (
            <button
              key={k}
              className={tab === k ? "on" : ""}
              style={tab === k ? { background: c, color: "#fff" } : null}
              onClick={() => onTab(k)}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }}>
          {tab === "load" && (
            <React.Fragment>
              {v.perMember.length > 0 && (
                <div className="card" style={{ marginBottom: 14 }}>
                  <div className="row" style={{ alignItems: "baseline" }}>
                    <div style={{ flex: 1 }}>
                      <h3>Overall team load</h3>
                      <div className="card-sub" style={{ marginBottom: 0 }}>
                        Average standing commitment across everyone on active projects.
                      </div>
                    </div>
                    <span
                      className="load-pill"
                      style={{
                        background: loadTint(v.avg),
                        color: loadColor(v.avg),
                        fontSize: 17,
                        padding: "5px 16px",
                      }}
                    >
                      {v.avg}% avg
                    </span>
                  </div>
                  <AllocBar total={v.avg} />
                  <div className="vt-gauge-labels">
                    <span style={{ color: "#1E9E63" }}>healthy ≤75%</span>
                    <span style={{ color: "#E39310" }}>loaded 76–100%</span>
                    <span style={{ color: "#CE3B2C" }}>overloaded &gt;100%</span>
                  </div>
                  {v.avg > 75 && (
                    <p style={{ fontSize: 13, color: "#8A6A28", margin: "10px 0 0", fontWeight: 600 }}>
                      Caution — the team is heavily loaded. Think twice before adding stretch
                      targets this week.
                    </p>
                  )}
                </div>
              )}
              <div className="card">
                {v.perMember.length === 0 ? (
                  <p style={{ color: "#9C9284", fontSize: 14, margin: 0 }}>
                    No one is on an active project yet — the load picture starts there.
                  </p>
                ) : (
                  v.perMember.map((r) => (
                    <div className="vt-row" key={r.member.id} style={{ alignItems: "flex-start" }}>
                      <Avatar name={r.member.name} />
                      <div className="vt-who">
                        <div className="row" style={{ gap: 8 }}>
                          <span className="vt-nm">{r.member.name}</span>
                          <span
                            className="load-pill"
                            style={{ background: loadTint(r.total), color: loadColor(r.total) }}
                          >
                            {r.total}%
                          </span>
                        </div>
                        <AllocBar total={r.total} />
                        <div className="vt-band">
                          {r.items
                            .map(
                              (it) =>
                                it.bundle.project.name + " " + it.assignment.capacityAllocated + "%"
                            )
                            .join(" · ")}
                        </div>
                      </div>
                      <button className="btn2" onClick={() => go({ name: "week" })}>
                        This week →
                      </button>
                    </div>
                  ))
                )}
              </div>
            </React.Fragment>
          )}

          {tab === "redline" && (
            <div className="card">
              {v.redCount === 0 && v.redLogs.length === 0 ? (
                <p style={{ color: "#9C9284", fontSize: 14, margin: 0 }}>
                  No one's in the red — as it should be.
                </p>
              ) : (
                <React.Fragment>
                  <div className="vt-banner">
                    <div className="vb-title">Intervention recommended</div>
                    <div className="vb-sub">
                      {v.redCount} {v.redCount === 1 ? "person is" : "people are"} beyond a safe
                      working load. Redlines cost you quality first and people second — rebalance
                      before they do.
                    </div>
                  </div>
                  {over.map((r) => (
                    <div className="vt-row" key={r.member.id}>
                      <Dot color={LOG_META.redline.color} />
                      <div className="vt-who">
                        <div className="vt-nm">{r.member.name}</div>
                        <div className="vt-rl">
                          committed across {r.items.length} project
                          {r.items.length === 1 ? "" : "s"} — stretched thin
                        </div>
                      </div>
                      <span
                        className="load-pill"
                        style={{ background: "#FAE3DF", color: "#CE3B2C" }}
                      >
                        {r.total}%
                      </span>
                      <button className="btn2" onClick={() => go({ name: "week" })}>
                        Rebalance →
                      </button>
                    </div>
                  ))}
                  {v.redLogs.map((l) => (
                    <LogRow
                      key={l.id}
                      log={l}
                      membersById={membersById}
                      projectsById={projectsById}
                      onAnnotate={onAnnotate}
                      onDelete={onDeleteLog}
                    />
                  ))}
                </React.Fragment>
              )}
            </div>
          )}

          {tab === "stretch" && (
            <div className="card">
              {v.stretchLogs.length === 0 ? (
                <p style={{ color: "#9C9284", fontSize: 14, margin: 0 }}>
                  None filed in the last 30 days — worth hunting for one together.
                </p>
              ) : (
                v.stretchLogs.map((l) => (
                  <LogRow
                    key={l.id}
                    log={l}
                    membersById={membersById}
                    projectsById={projectsById}
                    onAnnotate={onAnnotate}
                    onDelete={onDeleteLog}
                  />
                ))
              )}
              {v.stretchLogs.length > 0 && (
                <p className="rep-note" style={{ marginTop: 10 }}>
                  This is the promotion-case evidence writing itself — it feeds the Reports page.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="jfoot">
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================== dashboard ============================== */

function Dashboard({ bundles, members, membersById, onOpen, onNewProject, onNewMember }) {
  const [view, setView] = useState("list");
  const active = bundles.filter((b) => b.project.status === "active");
  const wrapped = bundles.filter((b) => b.project.status !== "active");
  const nothingYet = bundles.length === 0 && members.length === 0;

  return (
    <div>
      <h1 className="page-title">Projects</h1>
      <p className="page-sub">Every case file, at a glance.</p>

      {nothingYet ? (
        <div className="card hero">
          <h3>Every project tells a story.</h3>
          <p>
            noon keeps the case file — who's on it, how much of their week it gets, and how
            it's really going. A few honest questions now, a written-for-you wrap-up in
            December.
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <button className="btn" onClick={onNewProject}>
              Start your first project →
            </button>
            <button className="btn2" onClick={onNewMember}>
              Meet the roster first
            </button>
          </div>
        </div>
      ) : (
        <React.Fragment>
          <div className="section-head" style={{ marginTop: 0, gap: 12 }}>
            <h2>{view === "timeline" ? "Timeline" : "Active"}</h2>
            <span className="viewtoggle" style={{ marginLeft: "auto" }}>
              <button className={view === "list" ? "on" : ""} onClick={() => setView("list")}>
                Cards
              </button>
              <button className={view === "timeline" ? "on" : ""} onClick={() => setView("timeline")}>
                Timeline
              </button>
            </span>
            <button className="btn" style={{ marginLeft: 12 }} onClick={onNewProject}>
              New project
            </button>
          </div>

          {view === "timeline" ? (
            <ProjectTimeline bundles={bundles} onOpen={onOpen} />
          ) : (
            <React.Fragment>
              {active.length === 0 ? (
                <div className="card empty">
                  <p style={{ marginBottom: 0 }}>Nothing active right now — a quiet moment.</p>
                </div>
              ) : (
                <div className="grid2">
                  {active.map((b) => (
                    <ProjectCard key={b.project.id} bundle={b} membersById={membersById} onOpen={onOpen} />
                  ))}
                </div>
              )}

              {wrapped.length > 0 && (
                <React.Fragment>
                  <div className="section-head">
                    <h2>Wrapped up</h2>
                  </div>
                  <div className="grid2">
                    {wrapped.map((b) => (
                      <ProjectCard
                        key={b.project.id}
                        bundle={b}
                        membersById={membersById}
                        onOpen={onOpen}
                        wrapped
                      />
                    ))}
                  </div>
                </React.Fragment>
              )}
            </React.Fragment>
          )}
        </React.Fragment>
      )}
    </div>
  );
}

function ProjectCard({ bundle, membersById, onOpen, wrapped }) {
  const { project, assignments, checkIns } = bundle;
  const lastWeek = checkIns.reduce((acc, c) => (c.weekOf > acc ? c.weekOf : acc), "");
  // Skills the project needs, mined from the requirements text — no extra
  // data entry, the card enriches itself.
  const needs = project.requirements ? extractSkills(project.requirements).slice(0, 4) : [];
  return (
    <div
      className="card proj-card"
      style={wrapped ? { opacity: 0.82 } : null}
      onClick={() => onOpen(project.id, wrapped ? "wrapup" : "progression")}
    >
      <div className="row" style={{ alignItems: "baseline", gap: 10 }}>
        <h3 style={{ flex: 1, minWidth: 0 }}>{project.name}</h3>
        {project.category && <span className="pcat">{project.category}</span>}
        {wrapped && (
          <span className="pill" style={{ background: "#EAE2D4", color: "#9C9284" }}>
            Wrapped up
          </span>
        )}
      </div>
      <p className="proj-desc">{project.description || "No description yet."}</p>
      {needs.length > 0 && (
        <div className="pc-needs">
          <span className="mini-label">Needs</span>
          {needs.map((s) => (
            <span key={s} className="tag">
              {s}
            </span>
          ))}
        </div>
      )}
      <div className="pc-team">
        {assignments.length === 0 && <span className="tag-none">no one on it yet</span>}
        {assignments.slice(0, 4).map((a) => {
          const m = membersById[a.memberId];
          const latest = latestCheckIn(checkIns, a.id);
          const meta = latest ? STATUS_META[latest.progressStatus] : NO_STATUS;
          return (
            <div className="pc-person" key={a.id}>
              <Dot color={meta.color} />
              <span className="pc-nm">{m ? m.name : "?"}</span>
              <span className="pc-status">
                {m && m.role ? m.role + " · " : ""}
                {latest ? meta.label.toLowerCase() : "no check-ins yet"}
              </span>
            </div>
          );
        })}
        {assignments.length > 4 && (
          <span className="trust-sub">+ {assignments.length - 4} more</span>
        )}
        <span className="proj-meta" style={{ marginLeft: 0, textAlign: "left", marginTop: 3 }}>
          {lastWeek ? "last check-in · wk of " + fmtWeek(lastWeek) : "no check-ins yet"}
        </span>
      </div>
    </div>
  );
}

/* ============================== roster ============================== */

function Roster({ members, bundles, logs, membersById, projectsById, onNewMember, onEditMember, onDeleteMember, onAddLog, onAnnotate, onDeleteLog }) {
  const activeBundles = bundles.filter((b) => b.project.status === "active");
  const cut = new Date();
  cut.setDate(cut.getDate() - 14);
  const cutoff = toISODate(cut);

  const allocFor = (memberId) => {
    const rows = [];
    for (const b of activeBundles) {
      for (const a of b.assignments) {
        if (a.memberId === memberId) rows.push({ project: b.project, capacity: a.capacityAllocated });
      }
    }
    return rows;
  };

  return (
    <div>
      <h1 className="page-title">People</h1>
      <p className="page-sub">Everyone you manage, across every project.</p>

      <div className="section-head" style={{ marginTop: 0 }}>
        <h2>
          {members.length === 0
            ? "No one here yet"
            : members.length + (members.length === 1 ? " person" : " people")}
        </h2>
        <button className="btn" onClick={onNewMember}>
          New person
        </button>
      </div>

      {members.length === 0 ? (
        <div className="card empty">
          <p style={{ marginBottom: 0 }}>
            Add the people you manage — what they're strong at, how long they've been at it,
            and how much you trust them to run with. Projects draw from this roster.
          </p>
        </div>
      ) : (
        <div className="grid2">
          {members.map((m) => {
            const rows = allocFor(m.id);
            const total = rows.reduce((s, r) => s + (Number(r.capacity) || 0), 0);
            const mLogs = logs.filter((l) => l.memberId === m.id);
            const hasRedline = mLogs.some((l) => l.type === "redline" && l.date >= cutoff);
            return (
              <div className="card member-card" key={m.id}>
                <div className="row">
                  <Avatar name={m.name} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h3>{m.name}</h3>
                    <div className="trust-sub">{m.role || "—"}</div>
                  </div>
                  {hasRedline && (
                    <span className="pill" style={{ background: LOG_META.redline.tint, color: LOG_META.redline.color }}>
                      <Dot color={LOG_META.redline.color} /> redline
                    </span>
                  )}
                  <button className="btn-txt" onClick={() => onEditMember(m)}>
                    Edit
                  </button>
                  <ConfirmBtn
                    label="Delete"
                    confirmLabel="Really delete?"
                    onConfirm={() => onDeleteMember(m.id)}
                  />
                </div>

                <TrustCard member={m} />

                <div style={{ marginTop: 15 }}>
                  <span className="label">Allocation</span>
                  <AllocBar total={total} />
                  <div className="alloc-note">
                    {rows.length === 0 ? (
                      "Not on any active project — room to breathe."
                    ) : (
                      <React.Fragment>
                        <b style={{ color: total > 100 ? "#B5544D" : "#2B2B2B" }}>{total}%</b> of
                        their week is spoken for
                        {total > 100 && <span className="alloc-over"> · stretched thin</span>}
                        {total > 0 && total < 50 && " · room for more"}
                      </React.Fragment>
                    )}
                  </div>
                  {rows.length > 0 && (
                    <div className="subtle-list">
                      {rows.map((r, i) => (
                        <div key={i}>
                          {r.project.name} · {r.capacity}%
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ marginTop: 14 }}>
                  <span className="label">Notebook</span>
                  {mLogs.slice(0, 2).map((l) => (
                    <LogRow
                      key={l.id}
                      log={l}
                      membersById={membersById}
                      projectsById={projectsById}
                      onAnnotate={onAnnotate}
                      onDelete={onDeleteLog}
                      showWho={false}
                    />
                  ))}
                  {mLogs.length > 2 && (
                    <div className="trust-sub">+ {mLogs.length - 2} earlier — full record in Reports</div>
                  )}
                  <QuickNote
                    id={"note-" + m.id}
                    onAdd={(t) => {
                      const s = parseCapture(t, [], bundles);
                      onAddLog({ memberId: m.id, projectId: s.projectId, type: s.type, text: t });
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================ this week ============================ */

function ThisWeek({ bundles, members, onSetPlan, onOpen }) {
  const [week, setWeek] = useState(thisMonday());
  const norm = mondayOf(week);
  const shift = (days) => {
    const d = new Date(norm + "T00:00:00");
    d.setDate(d.getDate() + days);
    setWeek(toISODate(d));
  };

  const active = bundles.filter((b) => b.project.status === "active");
  const rows = members
    .map((m) => {
      const items = [];
      for (const b of active)
        for (const a of b.assignments)
          if (a.memberId === m.id)
            items.push({
              bundle: b,
              assignment: a,
              planned: plannedFor(b, a.id, norm),
              checkIn: b.checkIns.find((c) => c.assignmentId === a.id && c.weekOf === norm),
            });
      return {
        member: m,
        items,
        total: items.reduce((s, i) => s + (Number(i.planned) || 0), 0),
      };
    })
    .filter((r) => r.items.length > 0);

  return (
    <div>
      <h1 className="page-title">This week</h1>
      <p className="page-sub">
        The whole week's load in one place — shape it top-down before the projects pull.
      </p>

      <div className="tw-week">
        <button className="wknav" onClick={() => shift(-7)} aria-label="Previous week">
          ‹
        </button>
        <input
          id="tw-week"
          className="inp"
          type="date"
          value={week}
          onChange={(e) => setWeek(e.target.value)}
        />
        <button className="wknav" onClick={() => shift(7)} aria-label="Next week">
          ›
        </button>
        <span className="trust-sub">week of {fmtDate(norm)}</span>
      </div>

      {rows.length === 0 ? (
        <div className="card empty">
          <p style={{ marginBottom: 0 }}>
            No one is on an active project yet — add people from a project's Onboarding tab,
            and their week shows up here.
          </p>
        </div>
      ) : (
        rows.map(({ member: m, items, total }) => (
          <div className="card" key={m.id}>
            <div className="row">
              <Avatar name={m.name} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <h3>{m.name}</h3>
                <div className="trust-sub">{m.role || "—"}</div>
              </div>
              <span className="tw-total">
                planned <b className={total > 100 ? "over" : ""}>{total}%</b>
                {total > 100 && <span className="over"> · stretched thin</span>}
              </span>
            </div>
            <AllocBar total={total} />
            {items.map((it) => {
              const meta = it.checkIn ? STATUS_META[it.checkIn.progressStatus] : NO_STATUS;
              return (
                <div className="tw-proj" key={it.assignment.id}>
                  <Dot color={meta.color} />
                  <button
                    className="tw-pname"
                    onClick={() => onOpen(it.bundle.project.id, "progression")}
                  >
                    {it.bundle.project.name}
                  </button>
                  <PctInput
                    id={"twp-" + it.assignment.id}
                    value={it.planned}
                    onCommit={(n) => onSetPlan(it.bundle.project.id, it.assignment.id, norm, n)}
                  />
                  <span className="tw-sub">
                    % this week
                    {it.planned !== it.assignment.capacityAllocated
                      ? " · usually " + it.assignment.capacityAllocated + "%"
                      : ""}
                  </span>
                </div>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}

/* ============================ project view ============================ */

function ProjectView(props) {
  const { bundle, tab } = props;
  const { project } = bundle;
  return (
    <div>
      <button className="back" onClick={props.onBack}>
        ← All projects
      </button>
      <div className="row" style={{ marginTop: 8, alignItems: "baseline", gap: 14 }}>
        <h1 className="page-title" style={{ marginTop: 0 }}>
          {project.name}
        </h1>
        {project.category && <span className="pcat">{project.category}</span>}
        <span
          className="pill"
          style={
            project.status === "active"
              ? { background: STATUS_META["on track"].tint, color: STATUS_META["on track"].color }
              : { background: "#EAE2D4", color: "#9C9284" }
          }
        >
          {project.status === "active" ? "Active" : "Wrapped up"}
        </span>
      </div>
      <p className="page-sub" style={{ marginBottom: 0 }}>
        Started {fmtDate(project.startDate)} · {bundle.assignments.length}{" "}
        {bundle.assignments.length === 1 ? "person" : "people"} ·{" "}
        {bundle.checkIns.length} check-in{bundle.checkIns.length === 1 ? "" : "s"}
      </p>

      <div className="tabs">
        {[
          ["onboarding", "Onboarding"],
          ["progression", "Progression"],
          ["wrapup", "Wrap-up"],
        ].map(([key, label]) => (
          <button key={key} className={tab === key ? "on" : ""} onClick={() => props.onTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "onboarding" && <OnboardingTab {...props} />}
      {tab === "progression" && <ProgressionTab {...props} />}
      {tab === "wrapup" && <WrapUpTab {...props} />}
    </div>
  );
}

/* ---------- onboarding tab ---------- */

function OnboardingTab({
  bundle,
  membersById,
  onUpdateProject,
  onOpenAssign,
  onEditMember,
  onUpdateAssignment,
  onRemoveAssignment,
  onDeleteProject,
}) {
  const { project, assignments } = bundle;
  const [draft, setDraft] = useState({
    name: project.name,
    category: project.category || "",
    description: project.description || "",
    requirements: project.requirements || "",
    startDate: project.startDate || "",
    status: project.status,
  });
  const [savedFlash, setSavedFlash] = useState(false);

  const dirty =
    draft.name !== project.name ||
    draft.category !== (project.category || "") ||
    draft.description !== (project.description || "") ||
    draft.requirements !== (project.requirements || "") ||
    draft.startDate !== (project.startDate || "") ||
    draft.status !== project.status;

  const save = () => {
    if (!draft.name.trim()) return;
    onUpdateProject(project.id, { ...draft, name: draft.name.trim() });
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1800);
  };

  const set = (k) => (e) => setDraft({ ...draft, [k]: e.target.value });

  return (
    <div>
      <div className="card">
        <h3>The case file</h3>
        <div className="card-sub">What this is, and what it needs.</div>
        <div className="frow">
          <div className="field">
            <label htmlFor="p-name">Name</label>
            <input id="p-name" className="inp" value={draft.name} onChange={set("name")} />
          </div>
          <div className="field" style={{ maxWidth: 200 }}>
            <label htmlFor="p-cat">Kind of work</label>
            <input
              id="p-cat"
              className="inp"
              value={draft.category}
              onChange={set("category")}
              placeholder="e.g. Strategy & Ops"
            />
          </div>
          <div className="field" style={{ maxWidth: 190 }}>
            <label htmlFor="p-start">Kicked off</label>
            <input
              id="p-start"
              className="inp"
              type="date"
              value={draft.startDate}
              onChange={set("startDate")}
            />
          </div>
          <div className="field" style={{ maxWidth: 190 }}>
            <label htmlFor="p-status">Status</label>
            <select id="p-status" className="sel" value={draft.status} onChange={set("status")}>
              <option value="active">Active</option>
              <option value="wrapped up">Wrapped up</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="p-desc">What is it?</label>
          <textarea
            id="p-desc"
            className="ta"
            value={draft.description}
            onChange={set("description")}
            placeholder="One or two sentences on what this project is."
          />
        </div>
        <div className="field">
          <label htmlFor="p-req">What does it need to succeed?</label>
          <textarea
            id="p-req"
            className="ta"
            value={draft.requirements}
            onChange={set("requirements")}
            placeholder="Skills, deliverables, constraints, deadlines…"
          />
        </div>
        <div className="modal-actions" style={{ marginTop: 4 }}>
          {savedFlash && <span className="saved-note">Saved ✓</span>}
          <button className="btn" onClick={save} disabled={!dirty || !draft.name.trim()}>
            Save changes
          </button>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 4 }}>
          <div style={{ flex: 1 }}>
            <h3>The team</h3>
            <div className="card-sub" style={{ marginBottom: 0 }}>
              Who's on this, and how much of their week it gets.
            </div>
          </div>
          <button className="btn2" onClick={onOpenAssign}>
            Add people
          </button>
        </div>

        {assignments.length === 0 ? (
          <p style={{ color: "#9C9284", fontSize: 14, margin: "14px 0 4px" }}>
            No one on this yet. Add people to start the weekly rhythm.
          </p>
        ) : (
          assignments.map((a) => {
            const m = membersById[a.memberId];
            if (!m) return null;
            return (
              <div className="team-row" key={a.id}>
                <Avatar name={m.name} />
                <div className="team-who">
                  <div className="nm">{m.name}</div>
                  <div className="rl">{m.role || "—"}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center" }}>
                  <PctInput
                    id={"cap-" + a.id}
                    value={a.capacityAllocated}
                    onCommit={(n) => onUpdateAssignment(a.id, { capacityAllocated: n })}
                  />
                  <span className="cap-suffix">% of a typical week</span>
                </div>
                <div style={{ flex: 1.2, minWidth: 120 }}>
                  <BlurText
                    id={"anotes-" + a.id}
                    value={a.notes}
                    placeholder="Their role on this one…"
                    onCommit={(v) => onUpdateAssignment(a.id, { notes: v })}
                  />
                </div>
                <button className="btn-txt" onClick={() => onEditMember(m)}>
                  Profile
                </button>
                <ConfirmBtn
                  label="Remove"
                  confirmLabel="Remove + their check-ins?"
                  onConfirm={() => onRemoveAssignment(a.id)}
                />
              </div>
            );
          })
        )}
      </div>

      <div style={{ marginTop: 22, textAlign: "right" }}>
        <ConfirmBtn
          label="Delete this project"
          confirmLabel="Delete the file and all its check-ins?"
          onConfirm={onDeleteProject}
        />
      </div>
    </div>
  );
}

/* ---------- progression tab ---------- */

function ProgressionTab({ bundle, membersById, onSaveCheckIn, onTab }) {
  const { assignments, checkIns } = bundle;

  if (assignments.length === 0) {
    return (
      <div className="card empty">
        <h3>No one to check in with yet</h3>
        <p>Add people to this project first — then this becomes your weekly rhythm.</p>
        <button className="btn2" onClick={() => onTab("onboarding")}>
          Go to Onboarding
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <h3>At a glance</h3>
        <div className="card-sub">Where everyone stands, as of their last check-in.</div>
        <div className="glance">
          {assignments.map((a) => {
            const m = membersById[a.memberId];
            const latest = latestCheckIn(checkIns, a.id);
            const meta = latest ? STATUS_META[latest.progressStatus] : NO_STATUS;
            return (
              <div className="glance-chip" key={a.id}>
                <Dot color={meta.color} />
                <div>
                  <div className="gc-name">{m ? m.name : "?"}</div>
                  <div className="gc-sub">
                    {latest ? meta.label + " · wk of " + fmtWeek(latest.weekOf) : "No check-ins yet"}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {assignments.map((a) => {
        const m = membersById[a.memberId];
        if (!m) return null;
        const history = checkIns
          .filter((c) => c.assignmentId === a.id)
          .sort((x, y) => (x.weekOf < y.weekOf ? 1 : -1));
        return (
          <CheckInCard
            key={a.id}
            assignment={a}
            member={m}
            history={history}
            getPlanned={(wk) => plannedFor(bundle, a.id, wk)}
            onSave={onSaveCheckIn}
          />
        );
      })}
    </div>
  );
}

function CheckInCard({ assignment, member, history, getPlanned, onSave }) {
  const [week, setWeek] = useState(thisMonday());
  const [status, setStatus] = useState("on track");
  const [actual, setActual] = useState(() => String(getPlanned(thisMonday())));
  const [note, setNote] = useState("");
  const [flash, setFlash] = useState(false);

  const first = firstName(member.name);
  const normWeek = mondayOf(week);
  const existing = history.find((c) => c.weekOf === normWeek);
  const planned = getPlanned(normWeek);

  // Pre-fill only when the chosen week already has a logged check-in, so
  // saving edits it rather than silently overwriting. Switching to an empty
  // week keeps whatever is typed — a wrong date should never eat the entry.
  useEffect(() => {
    const ex = history.find((c) => c.weekOf === mondayOf(week));
    if (ex) {
      setStatus(ex.progressStatus);
      setActual(String(ex.capacityActual));
      setNote(ex.note || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [week]);

  const save = () => {
    onSave({
      assignmentId: assignment.id,
      weekOf: normWeek,
      progressStatus: status,
      capacityActual: clampPct(actual),
      note: note.trim(),
    });
    setFlash(true);
    setTimeout(() => setFlash(false), 1800);
  };

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 14 }}>
        <Avatar name={member.name} />
        <div style={{ flex: 1 }}>
          <h3>{member.name}</h3>
          <div className="trust-sub">
            {member.role || "—"} · {assignment.capacityAllocated}% of their week
            {assignment.notes ? " · " + assignment.notes : ""}
          </div>
        </div>
        <StatusPill status={history[0] ? history[0].progressStatus : null} />
      </div>

      <div className="label" style={{ display: "block", marginBottom: 8 }}>
        How did {first}'s week go?
      </div>
      <div className="sgrid">
        {STATUSES.map((s) => {
          const meta = STATUS_META[s];
          return (
            <div
              key={s}
              className={"scard" + (status === s ? " sel" : "")}
              onClick={() => setStatus(s)}
            >
              <Dot color={meta.color} />
              <h5>{meta.phrase}</h5>
              <p>{meta.desc}</p>
            </div>
          );
        })}
      </div>

      <div className="frow">
        <div className="field" style={{ maxWidth: 175 }}>
          <label htmlFor={"ci-w-" + assignment.id}>Week of</label>
          <input
            id={"ci-w-" + assignment.id}
            className="inp"
            type="date"
            value={week}
            onChange={(e) => setWeek(e.target.value)}
          />
        </div>
        <div className="field" style={{ maxWidth: 200 }}>
          <label htmlFor={"ci-c-" + assignment.id}>Week actually spent</label>
          <div style={{ display: "flex", alignItems: "center" }}>
            <input
              id={"ci-c-" + assignment.id}
              className="inp num"
              type="number"
              min={0}
              max={100}
              value={actual}
              onChange={(e) => setActual(e.target.value)}
            />
            <span className="cap-suffix">
              % vs {planned}% planned{planned !== assignment.capacityAllocated ? " this week" : ""}
            </span>
          </div>
        </div>
        <div className="field" style={{ flex: 2 }}>
          <label htmlFor={"ci-n-" + assignment.id}>What happened</label>
          <input
            id={"ci-n-" + assignment.id}
            className="inp"
            value={note}
            placeholder="One honest sentence is plenty…"
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>
      <div className="modal-actions" style={{ marginTop: 0 }}>
        {flash && <span className="saved-note">Logged ✓</span>}
        <button className="btn" onClick={save}>
          {existing ? "Update week of " + fmtWeek(normWeek) + " ✓" : "Log the week ✓"}
        </button>
      </div>

      {history.length > 0 && (
        <div className="ci-hist">
          {history.slice(0, 3).map((c) => (
            <div className="ci-hist-row" key={c.id}>
              <Dot color={STATUS_META[c.progressStatus].color} />
              <span className="whn">wk of {fmtWeek(c.weekOf)}</span>
              <span>
                {c.capacityActual}%{c.note ? " — " + c.note : ""}
              </span>
            </div>
          ))}
          {history.length > 3 && (
            <div className="trust-sub" style={{ marginTop: 4 }}>
              + {history.length - 3} earlier — full history in Wrap-up
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- wrap-up tab ---------- */

function WrapUpTab({ bundle, membersById, projectsById, logs, onAnnotate, onDeleteLog, onUpdateProject, onUpdateAssignment }) {
  const { project, assignments, checkIns } = bundle;
  const projLogs = (logs || []).filter((l) => l.projectId === project.id);

  const weeks = useMemo(() => {
    const map = {};
    for (const c of checkIns) (map[c.weekOf] = map[c.weekOf] || []).push(c);
    return Object.keys(map)
      .sort()
      .reverse()
      .map((w) => ({
        weekOf: w,
        entries: map[w].sort((a, b) => {
          const ma = membersById[(assignments.find((x) => x.id === a.assignmentId) || {}).memberId];
          const mb = membersById[(assignments.find((x) => x.id === b.assignmentId) || {}).memberId];
          return ((ma && ma.name) || "").localeCompare((mb && mb.name) || "");
        }),
      }));
  }, [checkIns, assignments, membersById]);

  const counts = { "on track": 0, "at risk": 0, blocked: 0 };
  for (const c of checkIns) if (counts[c.progressStatus] != null) counts[c.progressStatus]++;

  const assignmentById = {};
  for (const a of assignments) assignmentById[a.id] = a;

  return (
    <div>
      <div className="card">
        <div className="row" style={{ alignItems: "flex-start" }}>
          <div style={{ flex: 1 }}>
            <h3>Summary</h3>
            <div className="card-sub" style={{ marginBottom: 8 }}>
              The material for a year-end review — every week logged, and where each person
              stands.
            </div>
            <p style={{ margin: 0, fontSize: 14.5 }}>
              <b>{project.name}</b> started {fmtDate(project.startDate)} with{" "}
              {assignments.length} {assignments.length === 1 ? "person" : "people"} on it.{" "}
              {checkIns.length === 0 ? (
                "No weeks have been logged yet."
              ) : (
                <React.Fragment>
                  Across <b>{weeks.length}</b> logged {weeks.length === 1 ? "week" : "weeks"}:{" "}
                  <span style={{ color: STATUS_META["on track"].color }}>
                    {counts["on track"]} on track
                  </span>
                  {", "}
                  <span style={{ color: STATUS_META["at risk"].color }}>
                    {counts["at risk"]} wobbling
                  </span>
                  {", "}
                  <span style={{ color: STATUS_META.blocked.color }}>
                    {counts.blocked} stuck
                  </span>
                  .
                </React.Fragment>
              )}
            </p>
            {project.requirements && <p className="quote">Brief: {project.requirements}</p>}
            <div className="field" style={{ marginTop: 16, marginBottom: 0 }}>
              <label htmlFor="p-retro">How did this project go? — your assessment</label>
              <BlurTextarea
                id="p-retro"
                value={project.retrospective}
                placeholder="Your words, saved for December — what worked, what didn't, what you'd do differently…"
                onCommit={(v) => onUpdateProject(project.id, { retrospective: v })}
              />
            </div>
          </div>
          {project.status === "active" ? (
            <button
              className="btn2"
              onClick={() => onUpdateProject(project.id, { status: "wrapped up" })}
            >
              Mark wrapped up
            </button>
          ) : (
            <button
              className="btn2"
              onClick={() => onUpdateProject(project.id, { status: "active" })}
            >
              Reopen
            </button>
          )}
        </div>
      </div>

      <div className="section-head">
        <h2>People on this project</h2>
      </div>
      {assignments.length === 0 ? (
        <div className="card empty">
          <p style={{ marginBottom: 0 }}>No one was assigned to this project.</p>
        </div>
      ) : (
        <div className="grid2">
          {assignments.map((a) => {
            const m = membersById[a.memberId];
            if (!m) return null;
            const cis = checkIns
              .filter((c) => c.assignmentId === a.id)
              .sort((x, y) => (x.weekOf < y.weekOf ? 1 : -1));
            const cnt = { "on track": 0, "at risk": 0, blocked: 0 };
            for (const c of cis) if (cnt[c.progressStatus] != null) cnt[c.progressStatus]++;
            const avg =
              cis.length > 0
                ? Math.round(
                    cis.reduce((s, c) => s + (Number(c.capacityActual) || 0), 0) / cis.length
                  )
                : null;
            const lastNoted = cis.find((c) => c.note);
            return (
              <div className="card" key={a.id}>
                <div className="row">
                  <Avatar name={m.name} />
                  <div style={{ flex: 1 }}>
                    <h3>{m.name}</h3>
                    <div className="trust-sub">
                      {m.role || "—"}
                      {a.notes ? " · " + a.notes : ""}
                    </div>
                  </div>
                </div>
                <TrustCard member={m} />
                <div style={{ marginTop: 15 }}>
                  <span className="label">On this project</span>
                  <div className="stat-row">
                    <span>
                      planned <b>{a.capacityAllocated}%</b>
                    </span>
                    {avg != null && (
                      <span>
                        actually gave <b>~{avg}%</b>
                      </span>
                    )}
                    <span>
                      <b>{cis.length}</b> check-in{cis.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  {cis.length > 0 && (
                    <div className="stat-row" style={{ marginTop: 4 }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                        <Dot color={STATUS_META["on track"].color} /> {cnt["on track"]}
                      </span>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                        <Dot color={STATUS_META["at risk"].color} /> {cnt["at risk"]}
                      </span>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                        <Dot color={STATUS_META.blocked.color} /> {cnt.blocked}
                      </span>
                    </div>
                  )}
                  {lastNoted && <p className="quote">"{lastNoted.note}"</p>}
                </div>
                <div style={{ marginTop: 12 }}>
                  <span className="label">Their year in one line</span>
                  <div style={{ marginTop: 6 }}>
                    <BlurText
                      id={"perf-" + a.id}
                      value={a.performanceSummary}
                      placeholder={"One line on how " + firstName(m.name) + " performed here…"}
                      onCommit={(v) => onUpdateAssignment(a.id, { performanceSummary: v })}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {projLogs.length > 0 && (
        <React.Fragment>
          <div className="section-head">
            <h2>Notebook entries</h2>
          </div>
          <div className="card">
            {projLogs.map((l) => (
              <LogRow
                key={l.id}
                log={l}
                membersById={membersById}
                projectsById={projectsById || {}}
                onAnnotate={onAnnotate}
                onDelete={onDeleteLog}
              />
            ))}
          </div>
        </React.Fragment>
      )}

      <div className="section-head">
        <h2>Week by week</h2>
      </div>
      <div className="card">
        {weeks.length === 0 ? (
          <p style={{ color: "#9C9284", fontSize: 14, margin: 0 }}>
            Nothing logged yet — the wrap-up writes itself from weekly check-ins.
          </p>
        ) : (
          weeks.map((w) => (
            <div className="wk" key={w.weekOf}>
              <h4>Week of {fmtDate(w.weekOf)}</h4>
              {w.entries.map((c) => {
                const a = assignmentById[c.assignmentId];
                const m = a ? membersById[a.memberId] : null;
                const meta = STATUS_META[c.progressStatus];
                return (
                  <div className="wk-entry" key={c.id}>
                    <Dot color={meta.color} />
                    <span className="who">{m ? m.name : "?"}</span>
                    <span className="cap">{c.capacityActual}%</span>
                    <span className="txt">{c.note || meta.phrase}</span>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ============================== app ============================== */

function App() {
  const [ready, setReady] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const [members, setMembers] = useState([]);
  const [bundles, setBundles] = useState([]);
  const [logs, setLogs] = useState([]);
  const [page, setPage] = useState({ name: "home" });
  const [modal, setModal] = useState(null);
  const [vitals, setVitals] = useState(null);

  /* ---- load everything once ---- */
  useEffect(() => {
    (async () => {
      if (typeof window === "undefined" || !window.storage) {
        setStorageOk(false);
        setReady(true);
        return;
      }
      try {
        const m = await sGet(MEMBERS_KEY);
        const keys = await sListKeys(PROJECT_PREFIX);
        const loaded = [];
        for (const k of keys) {
          const b = await sGet(k);
          if (b && b.project && b.project.id) {
            loaded.push({
              project: b.project,
              assignments: Array.isArray(b.assignments) ? b.assignments : [],
              checkIns: Array.isArray(b.checkIns) ? b.checkIns : [],
              weekPlans: Array.isArray(b.weekPlans) ? b.weekPlans : [],
            });
          }
        }
        loaded.sort((a, b) => (a.project.startDate || "").localeCompare(b.project.startDate || ""));

        let mem = Array.isArray(m) ? m : [];
        let logsData = await sGet(LOGS_KEY);
        logsData = Array.isArray(logsData) ? logsData : [];

        // One-time migration: fold legacy per-member field notes into the
        // notebook log stream, then strip them from the member records.
        const hadLegacy = mem.some((mm) => mm.fieldNotes && mm.fieldNotes.length);
        if (hadLegacy) {
          for (const mm of mem) {
            for (const n of mm.fieldNotes || []) {
              if (!logsData.some((l) => l.id === n.id)) {
                logsData.push({
                  id: n.id,
                  memberId: mm.id,
                  projectId: null,
                  type: "core",
                  text: n.text,
                  date: n.date,
                  annotations: [],
                });
              }
            }
          }
          mem = mem.map((mm) => {
            const c = { ...mm };
            delete c.fieldNotes;
            return c;
          });
          sSet(LOGS_KEY, logsData).catch(() => {});
          sSet(MEMBERS_KEY, mem).catch(() => {});
        }
        logsData.sort((a, b) => (a.date < b.date ? 1 : -1));

        setMembers(mem);
        setBundles(loaded);
        setLogs(logsData);
      } catch (e) {
        console.error("Noon: failed to load data", e);
      }
      setReady(true);
    })();
  }, []);

  const membersById = useMemo(() => {
    const map = {};
    for (const m of members) map[m.id] = m;
    return map;
  }, [members]);

  const projectsById = useMemo(() => {
    const map = {};
    for (const b of bundles) map[b.project.id] = b.project;
    return map;
  }, [bundles]);

  /* ---- persistence ---- */
  const persistMembers = useCallback((list) => {
    setMembers(list);
    sSet(MEMBERS_KEY, list).catch((e) => console.error("Noon: save failed", e));
  }, []);

  const persistBundle = useCallback((bundle) => {
    setBundles((prev) => {
      const i = prev.findIndex((b) => b.project.id === bundle.project.id);
      if (i === -1) return [...prev, bundle];
      const next = prev.slice();
      next[i] = bundle;
      return next;
    });
    sSet(PROJECT_PREFIX + bundle.project.id, bundle).catch((e) =>
      console.error("Noon: save failed", e)
    );
  }, []);

  /* ---- mutations ---- */
  const createProject = (fields, selections) => {
    const projectId = uid();
    const assignments = Object.entries(selections || {}).map(([memberId, cap]) => ({
      id: uid(),
      projectId,
      memberId,
      capacityAllocated: clampPct(cap),
      notes: "",
    }));
    const bundle = {
      project: {
        id: projectId,
        name: fields.name.trim(),
        category: (fields.category || "").trim(),
        description: fields.description || "",
        requirements: fields.requirements || "",
        status: "active",
        startDate: fields.startDate || toISODate(new Date()),
      },
      assignments,
      checkIns: [],
    };
    persistBundle(bundle);
    setModal(null);
    setPage({ name: "project", id: projectId, tab: "onboarding" });
  };

  const updateProject = (projectId, patch) => {
    const b = bundles.find((x) => x.project.id === projectId);
    if (b) persistBundle({ ...b, project: { ...b.project, ...patch } });
  };

  const deleteProject = (projectId) => {
    setBundles((prev) => prev.filter((b) => b.project.id !== projectId));
    sDel(PROJECT_PREFIX + projectId);
    setPage({ name: "dashboard" });
  };

  const saveMember = (m) => {
    const isNew = !m.id;
    const member = isNew ? { ...m, id: uid() } : m;
    persistMembers(
      isNew ? [...members, member] : members.map((x) => (x.id === member.id ? member : x))
    );
    if (modal && modal.returnTo === "assign") {
      setModal({ type: "assign", projectId: modal.projectId, preselect: member.id });
    } else {
      setModal(null);
    }
  };

  const deleteMember = (memberId) => {
    persistMembers(members.filter((m) => m.id !== memberId));
    persistLogs(logs.filter((l) => l.memberId !== memberId));
    for (const b of bundles) {
      const dropped = b.assignments.filter((a) => a.memberId === memberId).map((a) => a.id);
      if (dropped.length === 0) continue;
      persistBundle({
        ...b,
        assignments: b.assignments.filter((a) => a.memberId !== memberId),
        checkIns: b.checkIns.filter((c) => !dropped.includes(c.assignmentId)),
        weekPlans: (b.weekPlans || []).filter((p) => !dropped.includes(p.assignmentId)),
      });
    }
  };

  const addAssignments = (projectId, selections) => {
    const b = bundles.find((x) => x.project.id === projectId);
    if (!b) return;
    const existing = new Set(b.assignments.map((a) => a.memberId));
    const add = Object.entries(selections)
      .filter(([memberId]) => !existing.has(memberId))
      .map(([memberId, cap]) => ({
        id: uid(),
        projectId,
        memberId,
        capacityAllocated: clampPct(cap),
        notes: "",
      }));
    if (add.length) persistBundle({ ...b, assignments: [...b.assignments, ...add] });
  };

  const updateAssignment = (projectId, assignmentId, patch) => {
    const b = bundles.find((x) => x.project.id === projectId);
    if (!b) return;
    persistBundle({
      ...b,
      assignments: b.assignments.map((a) => (a.id === assignmentId ? { ...a, ...patch } : a)),
    });
  };

  const removeAssignment = (projectId, assignmentId) => {
    const b = bundles.find((x) => x.project.id === projectId);
    if (!b) return;
    persistBundle({
      ...b,
      assignments: b.assignments.filter((a) => a.id !== assignmentId),
      checkIns: b.checkIns.filter((c) => c.assignmentId !== assignmentId),
      weekPlans: (b.weekPlans || []).filter((p) => p.assignmentId !== assignmentId),
    });
  };

  const setWeekPlan = (projectId, assignmentId, weekOf, planned) => {
    const b = bundles.find((x) => x.project.id === projectId);
    if (!b) return;
    const weekPlans = (b.weekPlans || []).filter(
      (p) => !(p.assignmentId === assignmentId && p.weekOf === weekOf)
    );
    weekPlans.push({ id: uid(), assignmentId, weekOf, planned: clampPct(planned) });
    persistBundle({ ...b, weekPlans });
  };

  const persistLogs = useCallback((list) => {
    setLogs(list);
    sSet(LOGS_KEY, list).catch((e) => console.error("Noon: save failed", e));
  }, []);

  const addLog = ({ memberId, projectId, type, text }) => {
    persistLogs([
      {
        id: uid(),
        memberId: memberId || null,
        projectId: projectId || null,
        type: type || "core",
        text: text.trim(),
        date: toISODate(new Date()),
        annotations: [],
      },
      ...logs,
    ]);
  };

  const annotateLog = (logId, text) => {
    persistLogs(
      logs.map((l) =>
        l.id === logId
          ? {
              ...l,
              annotations: [
                ...(l.annotations || []),
                { id: uid(), date: toISODate(new Date()), text: text.trim() },
              ],
            }
          : l
      )
    );
  };

  const deleteLog = (logId) => persistLogs(logs.filter((l) => l.id !== logId));

  const saveCheckIn = (projectId, data) => {
    const b = bundles.find((x) => x.project.id === projectId);
    if (!b) return;
    const existing = b.checkIns.find(
      (c) => c.assignmentId === data.assignmentId && c.weekOf === data.weekOf
    );
    const checkIns = existing
      ? b.checkIns.map((c) => (c.id === existing.id ? { ...c, ...data } : c))
      : [...b.checkIns, { id: uid(), ...data }];
    persistBundle({ ...b, checkIns });
  };

  /* ---- render ---- */
  if (!ready) {
    return (
      <div className="noon-root">
        <style>{CSS}</style>
        <div
          className="container"
          style={{ paddingTop: 80, textAlign: "center", color: "#9C9284" }}
        >
          Opening your case files…
        </div>
      </div>
    );
  }

  if (!storageOk) {
    return (
      <div className="noon-root">
        <style>{CSS}</style>
        <div className="container">
          <div className="card empty" style={{ marginTop: 60 }}>
            <h3>Storage unavailable</h3>
            <p style={{ marginBottom: 0 }}>
              Noon needs the window.storage API to keep your data between visits, and it
              isn't available in this environment.
            </p>
          </div>
        </div>
      </div>
    );
  }

  let content;
  if (page.name === "home") {
    content = (
      <HomePage
        members={members}
        bundles={bundles}
        logs={logs}
        membersById={membersById}
        projectsById={projectsById}
        onAddLog={addLog}
        onAnnotate={annotateLog}
        onDeleteLog={deleteLog}
        go={(p) => setPage(p)}
      />
    );
  } else if (page.name === "reports") {
    content = <ReportsPage members={members} bundles={bundles} logs={logs} />;
  } else if (page.name === "roster") {
    content = (
      <Roster
        members={members}
        bundles={bundles}
        logs={logs}
        membersById={membersById}
        projectsById={projectsById}
        onNewMember={() => setModal({ type: "member" })}
        onEditMember={(m) => setModal({ type: "member", member: m })}
        onDeleteMember={deleteMember}
        onAddLog={addLog}
        onAnnotate={annotateLog}
        onDeleteLog={deleteLog}
      />
    );
  } else if (page.name === "week") {
    content = (
      <ThisWeek
        bundles={bundles}
        members={members}
        onSetPlan={setWeekPlan}
        onOpen={(id, tab) => setPage({ name: "project", id, tab })}
      />
    );
  } else if (page.name === "project") {
    const bundle = bundles.find((b) => b.project.id === page.id);
    content = bundle ? (
      <ProjectView
        bundle={bundle}
        membersById={membersById}
        projectsById={projectsById}
        logs={logs}
        onAnnotate={annotateLog}
        onDeleteLog={deleteLog}
        tab={page.tab || "onboarding"}
        onTab={(tab) => setPage({ ...page, tab })}
        onBack={() => setPage({ name: "dashboard" })}
        onUpdateProject={updateProject}
        onDeleteProject={() => deleteProject(page.id)}
        onOpenAssign={() => setModal({ type: "assign", projectId: page.id })}
        onEditMember={(m) => setModal({ type: "member", member: m })}
        onUpdateAssignment={(aid, patch) => updateAssignment(page.id, aid, patch)}
        onRemoveAssignment={(aid) => removeAssignment(page.id, aid)}
        onSaveCheckIn={(data) => saveCheckIn(page.id, data)}
      />
    ) : (
      <Dashboard
        bundles={bundles}
        members={members}
        membersById={membersById}
        onOpen={(id, tab) => setPage({ name: "project", id, tab })}
        onNewProject={() => setModal({ type: "project" })}
        onNewMember={() => setModal({ type: "member" })}
      />
    );
  } else {
    content = (
      <Dashboard
        bundles={bundles}
        members={members}
        membersById={membersById}
        onOpen={(id, tab) => setPage({ name: "project", id, tab })}
        onNewProject={() => setModal({ type: "project" })}
        onNewMember={() => setModal({ type: "member" })}
      />
    );
  }

  const assignBundle =
    modal && modal.type === "assign" ? bundles.find((b) => b.project.id === modal.projectId) : null;

  return (
    <div className="noon-root">
      <style>{CSS}</style>
      <div className="paper-noise" aria-hidden="true" />
      <header className="hdr">
        <button className="wordmark" onClick={() => setPage({ name: "home" })}>
          noon<span className="wm-dot">.</span>
        </button>
        <nav className="nav">
          <button
            className={page.name === "home" ? "on" : ""}
            onClick={() => setPage({ name: "home" })}
          >
            Notebook
          </button>
          <button
            className={page.name === "dashboard" || page.name === "project" ? "on" : ""}
            onClick={() => setPage({ name: "dashboard" })}
          >
            Projects
          </button>
          <button
            className={page.name === "week" ? "on" : ""}
            onClick={() => setPage({ name: "week" })}
          >
            This week
          </button>
          <button
            className={page.name === "roster" ? "on" : ""}
            onClick={() => setPage({ name: "roster" })}
          >
            People
          </button>
          <button
            className={page.name === "reports" ? "on" : ""}
            onClick={() => setPage({ name: "reports" })}
          >
            Reports
          </button>
        </nav>
      </header>

      <VitalsBar members={members} bundles={bundles} logs={logs} onOpen={(t) => setVitals(t)} />

      <main className="container">{content}</main>

      {vitals && (
        <VitalsOverlay
          tab={vitals}
          onTab={(t) => setVitals(t)}
          onClose={() => setVitals(null)}
          members={members}
          bundles={bundles}
          logs={logs}
          membersById={membersById}
          projectsById={projectsById}
          onAnnotate={annotateLog}
          onDeleteLog={deleteLog}
          go={(p) => {
            setPage(p);
            setVitals(null);
          }}
        />
      )}

      {modal && modal.type === "project" && (
        <ProjectJourney members={members} onCreate={createProject} onClose={() => setModal(null)} />
      )}
      {modal && modal.type === "member" && (
        <MemberJourney
          member={modal.member}
          onSave={saveMember}
          onClose={() =>
            modal.returnTo === "assign"
              ? setModal({ type: "assign", projectId: modal.projectId })
              : setModal(null)
          }
        />
      )}
      {modal && modal.type === "assign" && assignBundle && (
        <AssignJourney
          bundle={assignBundle}
          members={members}
          membersById={membersById}
          preselect={modal.preselect}
          onAssign={(selections) => {
            addAssignments(modal.projectId, selections);
            setModal(null);
          }}
          onNewPerson={() =>
            setModal({ type: "member", returnTo: "assign", projectId: modal.projectId })
          }
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

export default App;
