import React, { useState, useEffect, useMemo, useCallback } from "react";

/*
  Noon — a living case file for the projects you run and the people you trust.

  Design language: "Guided Path" — one honest question at a time.
  Creation flows are conversational journeys (waypoints, big tappable choices,
  a "decide later" on every step). Warm sunrise gradient, pill buttons,
  rounded geometry, springy-but-subtle motion.

  Single-file React app. All persistence goes through window.storage
  (get / set / delete / list), single-user keys (shared: false).

  Storage layout (one key per related data cluster):
    noon:members            -> Member[]
    noon:project:<id>       -> { project, assignments, checkIns }
*/

/* ============================== storage ============================== */

const MEMBERS_KEY = "noon:members";
const PROJECT_PREFIX = "noon:project:";

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
    color: "#3D8B63",
    tint: "#EAF3EE",
  },
  "at risk": {
    label: "Wobbling",
    phrase: "Wobbling a little",
    desc: "worth keeping an eye on",
    color: "#D9971E",
    tint: "#FBF3DF",
  },
  blocked: {
    label: "Stuck",
    phrase: "Stuck — needs you",
    desc: "step in this week",
    color: "#C0564F",
    tint: "#F9ECEB",
  },
};

const NO_STATUS = { label: "No check-ins yet", color: "#D8CDBC", tint: "#F8F3EA" };

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

/* ============================== styles ============================== */

const CSS = `
.noon-root{min-height:100vh;background:#FFF9F3;color:#33302B;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased;}
.noon-root *{box-sizing:border-box;}
.noon-root h1,.noon-root h2,.noon-root h3,.noon-root h4{margin:0;line-height:1.3;}
.noon-root button{font-family:inherit;}

.hdr{display:flex;align-items:center;max-width:980px;margin:0 auto;padding:24px 24px 6px;}
.wordmark{font-size:22px;font-weight:800;letter-spacing:-0.5px;color:#33302B;cursor:pointer;background:none;border:none;padding:0;}
.wm-dot{background:linear-gradient(135deg,#FF7A1A,#FFB25C);-webkit-background-clip:text;background-clip:text;color:transparent;}
.nav{margin-left:auto;display:flex;gap:6px;}
.nav button{border:none;background:none;font-size:14px;font-weight:600;color:#A0937F;padding:7px 16px;border-radius:99px;cursor:pointer;transition:all .15s ease;}
.nav button:hover{color:#E8590C;}
.nav button.on{color:#E8590C;background:#FFEFDD;font-weight:700;}

.container{max-width:980px;margin:0 auto;padding:14px 24px 90px;}
.page-title{font-size:26px;font-weight:800;letter-spacing:-0.4px;margin-top:22px;}
.page-sub{color:#A0937F;font-size:14.5px;margin:3px 0 24px;}

.card{background:#fff;border:1.5px solid #F6EBDC;border-radius:20px;padding:22px 24px;box-shadow:0 4px 16px rgba(214,152,88,0.07);}
.card+.card{margin-top:18px;}
.card h3{font-size:16.5px;font-weight:700;margin-bottom:2px;}
.card .card-sub{color:#A0937F;font-size:13.5px;margin-bottom:14px;}

.btn{background:linear-gradient(135deg,#FF7A1A,#FF9A42);color:#fff;border:none;border-radius:99px;padding:10px 24px;font-size:14.5px;font-weight:700;cursor:pointer;box-shadow:0 6px 16px rgba(232,89,12,0.24);transition:transform .16s ease,box-shadow .16s ease;}
.btn:hover{transform:translateY(-1px);box-shadow:0 9px 22px rgba(232,89,12,0.3);}
.btn:active{transform:translateY(0);}
.btn:disabled{background:#F2E2CE;box-shadow:none;transform:none;cursor:default;}
.btn2{background:#fff;color:#33302B;border:1.5px solid #F0E2CF;border-radius:99px;padding:9px 20px;font-size:14px;font-weight:600;cursor:pointer;transition:border-color .15s ease,transform .15s ease;}
.btn2:hover{border-color:#FFB25C;transform:translateY(-1px);}
.btn-txt{background:none;border:none;font-size:13.5px;font-weight:600;color:#B4A88F;cursor:pointer;padding:4px 6px;border-radius:8px;}
.btn-txt:hover{color:#E8590C;}
.btn-danger{background:none;border:none;font-size:13.5px;color:#C6BBA8;cursor:pointer;padding:4px 6px;}
.btn-danger:hover{color:#C0564F;}
.btn-danger.armed{color:#C0564F;font-weight:700;}

.inp,.sel,.ta{width:100%;border:2px solid #F3E8D9;border-radius:14px;padding:11px 15px;font:inherit;font-size:14.5px;color:#33302B;background:#fff;transition:border-color .15s ease,box-shadow .15s ease;}
.inp:focus,.sel:focus,.ta:focus{outline:none;border-color:#FF8A3D;box-shadow:0 0 0 4px rgba(255,138,61,0.13);}
.inp::placeholder,.ta::placeholder{color:#C4B69E;}
.ta{resize:vertical;min-height:76px;}
.inp.mini{width:76px;padding:6px 10px;border-radius:10px;font-size:13.5px;text-align:center;}
.field{margin-bottom:16px;}
.field>label{display:block;font-size:12px;font-weight:700;color:#C09B79;margin:0 0 6px 6px;letter-spacing:0.02em;}
.frow{display:flex;gap:14px;}
.frow>.field{flex:1;}
.label{font-size:11.5px;font-weight:800;color:#C09B79;text-transform:uppercase;letter-spacing:0.08em;}

.dot{display:inline-block;width:9px;height:9px;border-radius:50%;flex:none;}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;padding:3px 12px;border-radius:99px;white-space:nowrap;}
.tagrow{display:flex;flex-wrap:wrap;gap:7px;}
.tag{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;padding:3px 12px;border-radius:99px;background:#FFF3E5;color:#8A6D4E;}
.tag.stretch{background:linear-gradient(135deg,#FFE9D6,#FFDFC4);color:#C2511A;}
.tag .tag-x{background:none;border:none;cursor:pointer;font-size:13px;line-height:1;padding:0;color:inherit;opacity:0.5;}
.tag .tag-x:hover{opacity:1;}
.tag-none{font-size:13px;color:#C4B69E;font-style:italic;}

.av{width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#FFE3C4,#FFD1A1);color:#9A6B3C;display:inline-flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:800;flex:none;}
.av-stack{display:flex;}
.av-stack .av{border:2.5px solid #fff;margin-left:-9px;}
.av-stack .av:first-child{margin-left:0;}

.tabs{display:flex;gap:6px;margin:20px 0 22px;}
.tabs button{background:none;border:none;font-size:14px;font-weight:600;color:#A0937F;padding:8px 18px;cursor:pointer;border-radius:99px;transition:all .15s ease;}
.tabs button:hover{color:#E8590C;}
.tabs button.on{color:#E8590C;background:#FFEFDD;font-weight:700;}

.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px;}
@media(max-width:720px){.grid2{grid-template-columns:1fr;}.frow{flex-direction:column;gap:0;}}

.proj-card{cursor:pointer;transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease;}
.proj-card:hover{transform:translateY(-3px);border-color:#FFD9AE;box-shadow:0 12px 28px rgba(214,152,88,0.14);}
.proj-card h3{font-size:17px;}
.proj-desc{color:#8A8071;font-size:14px;margin:6px 0 16px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.proj-foot{display:flex;align-items:center;gap:10px;}
.proj-meta{margin-left:auto;font-size:12.5px;color:#C4B69E;text-align:right;}
.dots{display:flex;gap:5px;align-items:center;}
.row{display:flex;align-items:center;gap:12px;}

.hero{background:linear-gradient(150deg,#FFF3E4,#FFE8D0);border:none;text-align:center;padding:52px 40px;}
.hero h3{font-size:24px;font-weight:800;letter-spacing:-0.4px;margin-bottom:8px;}
.hero p{color:#A08B72;font-size:15px;max-width:460px;margin:0 auto 24px;}

.team-row{display:flex;align-items:center;gap:14px;padding:14px 0;border-top:1.5px solid #FBF2E6;}
.team-row:first-of-type{border-top:none;}
.team-who{min-width:0;flex:1;}
.team-who .nm{font-weight:700;font-size:14.5px;}
.team-who .rl{font-size:12.5px;color:#A0937F;}
.num{width:78px;text-align:center;}
.cap-suffix{font-size:13px;color:#A0937F;margin-left:6px;}

.glance{display:flex;flex-wrap:wrap;gap:10px;}
.glance-chip{display:flex;align-items:center;gap:10px;background:#FFFBF6;border:1.5px solid #F8EDDD;border-radius:16px;padding:9px 16px;}
.glance-chip .gc-name{font-weight:700;font-size:13.5px;line-height:1.35;}
.glance-chip .gc-sub{font-size:12px;color:#A0937F;line-height:1.35;}

.sgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:6px 0 16px;}
.scard{background:#fff;border:2px solid #F6EBDC;border-radius:16px;padding:13px 14px;text-align:center;cursor:pointer;transition:all .18s ease;}
.scard:hover{border-color:#FFD9AE;}
.scard.sel{border-color:#FF8A3D;box-shadow:0 8px 20px rgba(232,89,12,0.14);transform:translateY(-2px);}
.scard h5{margin:6px 0 2px;font-size:13.5px;font-weight:700;}
.scard p{margin:0;font-size:11.5px;color:#B4A88F;line-height:1.4;}
@media(max-width:640px){.sgrid{grid-template-columns:1fr;}}

.ci-hist{margin-top:16px;border-top:1.5px solid #FBF2E6;padding-top:12px;}
.ci-hist-row{display:flex;align-items:baseline;gap:9px;font-size:13.5px;padding:3px 0;color:#8A8071;}
.ci-hist-row .whn{color:#C4B69E;font-size:12.5px;white-space:nowrap;min-width:88px;}

.wk{padding:16px 0;border-top:1.5px solid #FBF2E6;}
.wk:first-of-type{border-top:none;padding-top:4px;}
.wk h4{font-size:12.5px;font-weight:800;color:#C09B79;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:8px;}
.wk-entry{display:flex;align-items:baseline;gap:10px;padding:4px 0;font-size:14px;}
.wk-entry .who{font-weight:700;white-space:nowrap;}
.wk-entry .cap{color:#C4B69E;font-size:12.5px;white-space:nowrap;}
.wk-entry .txt{color:#6E6455;}

.trust{display:flex;flex-direction:column;gap:13px;margin-top:14px;}
.trust-sec .label{display:block;margin-bottom:6px;}
.trust-line{font-size:14px;}
.trust-sub{font-size:12.5px;color:#A0937F;}
.resp-dots{display:flex;gap:4px;align-items:center;margin:4px 0 3px;}
.resp-dots i{width:16px;height:7px;border-radius:4px;background:#F6EBDC;}
.resp-dots i.f{background:linear-gradient(135deg,#FF7A1A,#FFB25C);}
.mini-label{font-size:12px;color:#A0937F;font-weight:700;margin-right:6px;}

.alloc-bar{height:6px;border-radius:3px;background:#F8EDDD;margin:9px 0 7px;overflow:hidden;}
.alloc-bar i{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,#FF7A1A,#FFB25C);}
.alloc-note{font-size:13px;color:#A0937F;}
.alloc-over{color:#C0564F;font-weight:700;}
.member-card h3{font-size:15.5px;}
.stat-row{display:flex;gap:14px;flex-wrap:wrap;font-size:13.5px;color:#6E6455;margin-top:8px;}
.stat-row b{font-weight:700;}
.subtle-list{font-size:13px;color:#A0937F;margin-top:6px;}
.quote{font-size:13.5px;color:#8A8071;font-style:italic;margin-top:8px;}

.empty{padding:40px 30px;text-align:center;}
.empty h3{font-size:17px;margin-bottom:6px;}
.empty p{color:#A0937F;font-size:14px;max-width:460px;margin:0 auto 18px;}
.section-head{display:flex;align-items:baseline;margin:28px 0 14px;}
.section-head h2{font-size:17px;font-weight:800;letter-spacing:-0.2px;}
.section-head .btn2,.section-head .btn{margin-left:auto;}
.back{background:none;border:none;font-size:13.5px;font-weight:600;color:#B4A88F;cursor:pointer;padding:0;margin-top:20px;}
.back:hover{color:#E8590C;}
.saved-note{font-size:13px;color:#3D8B63;font-weight:700;margin-right:auto;animation:fadeUp .25s ease;}
.modal-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:20px;align-items:center;}

/* ---------- journey overlay ---------- */
.jov{position:fixed;inset:0;z-index:60;background:linear-gradient(165deg,#FFF9F2 0%,#FFF1E1 100%);overflow:auto;animation:jovIn .28s ease;}
.jov-in{max-width:740px;margin:0 auto;padding:24px 24px 64px;min-height:100%;display:flex;flex-direction:column;}
.jov-top{display:flex;align-items:center;margin-bottom:10px;}
.jov-eyebrow{font-size:12px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:#D3B591;}
.jov-x{margin-left:auto;background:#fff;border:1.5px solid #F0E2CF;width:36px;height:36px;border-radius:50%;font-size:17px;line-height:1;color:#B4A88F;cursor:pointer;transition:all .15s ease;}
.jov-x:hover{color:#E8590C;border-color:#FFB25C;}

.path{display:flex;align-items:flex-start;justify-content:center;margin:14px 0 6px;}
.wp{display:flex;flex-direction:column;align-items:center;gap:7px;width:104px;background:none;border:none;padding:0;cursor:default;}
.wp .node{width:14px;height:14px;border-radius:50%;background:#F0E2CF;transition:all .2s ease;}
.wp.done{cursor:pointer;}
.wp.done .node{background:#FF8A3D;}
.wp.now .node{background:linear-gradient(135deg,#FF7A1A,#FFB25C);box-shadow:0 0 0 6px rgba(255,138,61,0.18);}
.wp .wlbl{font-size:11.5px;font-weight:700;color:#C4B69E;}
.wp.now .wlbl{color:#E8590C;}
.wp.done .wlbl{color:#B49878;}
.seg{height:3px;width:58px;background:#F0E2CF;border-radius:2px;margin-top:6px;flex:none;}
.seg.done{background:#FFB25C;}

.jbody{flex:1;animation:stepIn .3s cubic-bezier(.22,.9,.35,1.08);}
.jq{text-align:center;font-size:26px;font-weight:800;letter-spacing:-0.5px;margin:28px 0 8px;}
.jsub{text-align:center;font-size:14.5px;color:#A0937F;margin:0 auto 28px;max-width:440px;}
.jfield{max-width:460px;margin:0 auto 16px;}
.jfield>label{display:block;font-size:12px;font-weight:700;color:#C09B79;margin:0 0 6px 8px;}
.jfield .inp,.jfield .ta{font-size:16px;padding:13px 17px;}
.jrow{display:flex;gap:14px;max-width:460px;margin:0 auto 16px;}
.jrow .jfield{flex:1;margin:0 0 0;}
.jfoot{display:flex;align-items:center;justify-content:center;gap:18px;margin-top:36px;}
.skip{background:none;border:none;color:#B4A88F;font-size:13.5px;font-weight:600;cursor:pointer;padding:6px;}
.skip:hover{color:#E8590C;}
.jsteplbl{text-align:center;font-size:12.5px;color:#C4B69E;margin-top:16px;}

.rgrid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;max-width:660px;margin:0 auto;}
@media(max-width:680px){.rgrid{grid-template-columns:repeat(2,1fr);}}
.ccard{background:#fff;border:2px solid #F3E8D9;border-radius:16px;padding:14px 10px;text-align:center;cursor:pointer;transition:all .18s ease;}
.ccard:hover{border-color:#FFD9AE;}
.ccard.sel{border-color:#FF8A3D;box-shadow:0 10px 24px rgba(232,89,12,0.15);transform:translateY(-3px);}
.ccard h4{font-size:13px;font-weight:700;line-height:1.3;}
.ccard p{font-size:11px;color:#B4A88F;margin:4px 0 0;line-height:1.4;}
.ccard .ic{width:26px;height:26px;border-radius:9px;margin:0 auto 9px;background:#F8EDDD;transition:all .18s ease;}
.ccard.sel .ic{background:linear-gradient(135deg,#FF7A1A,#FFB25C);}

.yrsrow{display:flex;align-items:center;justify-content:center;gap:12px;margin-top:26px;font-size:14.5px;color:#8A8071;}
.yrsrow .bucket{font-weight:700;color:#E8590C;}

.capchips{display:flex;flex-wrap:wrap;gap:8px;}
.chip-btn{background:#fff;border:2px solid #F3E8D9;border-radius:99px;padding:6px 14px;font-size:13px;font-weight:600;color:#8A8071;cursor:pointer;transition:all .15s ease;}
.chip-btn b{font-weight:800;color:#33302B;}
.chip-btn:hover{border-color:#FFD9AE;}
.chip-btn.on{border-color:#FF8A3D;background:#FFF3E5;color:#C2511A;}
.chip-btn.on b{color:#C2511A;}
.capwrap{display:flex;flex-direction:column;gap:10px;align-items:center;}
.capcustom{font-size:13px;color:#A0937F;display:flex;align-items:center;gap:7px;}

.pgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:620px;margin:0 auto;}
@media(max-width:640px){.pgrid{grid-template-columns:1fr;}}
.pcard{background:#fff;border:2px solid #F3E8D9;border-radius:16px;padding:13px 16px;cursor:pointer;transition:all .18s ease;text-align:left;}
.pcard:hover{border-color:#FFD9AE;}
.pcard.sel{border-color:#FF8A3D;box-shadow:0 8px 20px rgba(232,89,12,0.13);}
.pcard .pnm{font-weight:700;font-size:14px;}
.pcard .prl{font-size:12.5px;color:#A0937F;}
.pcard .ptick{margin-left:auto;width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,#FF7A1A,#FFB25C);color:#fff;font-size:12px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;flex:none;}
.pcard .pcaps{margin-top:11px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;animation:fadeUp .2s ease;}
.pcard .pcaps .chip-btn{padding:4px 11px;font-size:12px;}

@keyframes jovIn{from{opacity:0;}to{opacity:1;}}
@keyframes stepIn{from{opacity:0;transform:translateX(26px);}to{opacity:1;transform:none;}}
@keyframes fadeUp{from{opacity:0;transform:translateY(5px);}to{opacity:1;transform:none;}}
@media (prefers-reduced-motion: reduce){
  .noon-root *,.jov,.jbody{animation:none !important;transition:none !important;}
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

/* Numeric input that keeps local state and commits on blur. */
function BlurNum({ id, value, onCommit }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <input
      id={id}
      className="inp num"
      type="number"
      min={0}
      max={100}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const n = clampPct(v);
        if (n !== value) onCommit(n);
        else setV(String(value));
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
          onChange={(e) => onChange(clampPct(e.target.value))}
        />
        % of their week
      </span>
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
                  onChange={(e) => onSetCap(m.id, clampPct(e.target.value))}
                />
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
  const [desc, setDesc] = useState("");
  const [req, setReq] = useState("");
  const [start, setStart] = useState(toISODate(new Date()));
  const [selections, setSelections] = useState({});

  const goto = (i) => {
    setStep(i);
    setMaxVisited((m) => Math.max(m, i));
  };
  const create = () =>
    onCreate({ name, description: desc, requirements: req, startDate: start }, selections);
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
          <div className="jfield" style={{ maxWidth: 250 }}>
            <label htmlFor="p-start">When it kicks off</label>
            <input
              id="p-start"
              className="inp"
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
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

/* ============================== dashboard ============================== */

function Dashboard({ bundles, members, membersById, onOpen, onNewProject, onNewMember }) {
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
          <div className="section-head" style={{ marginTop: 0 }}>
            <h2>Active</h2>
            <button className="btn" onClick={onNewProject}>
              New project
            </button>
          </div>
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
    </div>
  );
}

function ProjectCard({ bundle, membersById, onOpen, wrapped }) {
  const { project, assignments, checkIns } = bundle;
  const lastWeek = checkIns.reduce((acc, c) => (c.weekOf > acc ? c.weekOf : acc), "");
  return (
    <div
      className="card proj-card"
      style={wrapped ? { opacity: 0.82 } : null}
      onClick={() => onOpen(project.id, wrapped ? "wrapup" : "progression")}
    >
      <div className="row" style={{ alignItems: "baseline" }}>
        <h3 style={{ flex: 1, minWidth: 0 }}>{project.name}</h3>
        {wrapped && (
          <span className="pill" style={{ background: "#F8F3EA", color: "#B4A88F" }}>
            Wrapped up
          </span>
        )}
      </div>
      <p className="proj-desc">{project.description || "No description yet."}</p>
      <div className="proj-foot">
        <span className="av-stack">
          {assignments.slice(0, 5).map((a) => {
            const m = membersById[a.memberId];
            return <Avatar key={a.id} name={m ? m.name : "?"} />;
          })}
        </span>
        {assignments.length === 0 && <span className="tag-none">no one on it yet</span>}
        <span className="dots">
          {assignments.map((a) => {
            const latest = latestCheckIn(checkIns, a.id);
            const m = latest ? STATUS_META[latest.progressStatus] : NO_STATUS;
            return <Dot key={a.id} color={m.color} />;
          })}
        </span>
        <span className="proj-meta">
          {lastWeek ? "last check-in · wk of " + fmtWeek(lastWeek) : "no check-ins yet"}
        </span>
      </div>
    </div>
  );
}

/* ============================== roster ============================== */

function Roster({ members, bundles, onNewMember, onEditMember, onDeleteMember }) {
  const activeBundles = bundles.filter((b) => b.project.status === "active");

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
            return (
              <div className="card member-card" key={m.id}>
                <div className="row">
                  <Avatar name={m.name} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h3>{m.name}</h3>
                    <div className="trust-sub">{m.role || "—"}</div>
                  </div>
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
                  <div className="alloc-bar">
                    <i
                      style={{
                        width: Math.min(total, 100) + "%",
                        background:
                          total > 100
                            ? "#C0564F"
                            : "linear-gradient(90deg,#FF7A1A,#FFB25C)",
                      }}
                    />
                  </div>
                  <div className="alloc-note">
                    {rows.length === 0 ? (
                      "Not on any active project — room to breathe."
                    ) : (
                      <React.Fragment>
                        <b style={{ color: "#33302B" }}>{total}%</b> of their week is spoken for
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
              </div>
            );
          })}
        </div>
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
        <span
          className="pill"
          style={
            project.status === "active"
              ? { background: "#EAF3EE", color: "#3D8B63" }
              : { background: "#F8F3EA", color: "#B4A88F" }
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
    description: project.description || "",
    requirements: project.requirements || "",
    startDate: project.startDate || "",
    status: project.status,
  });
  const [savedFlash, setSavedFlash] = useState(false);

  const dirty =
    draft.name !== project.name ||
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
          <p style={{ color: "#A0937F", fontSize: 14, margin: "14px 0 4px" }}>
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
                  <BlurNum
                    id={"cap-" + a.id}
                    value={a.capacityAllocated}
                    onCommit={(n) => onUpdateAssignment(a.id, { capacityAllocated: n })}
                  />
                  <span className="cap-suffix">% of their week</span>
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
            onSave={onSaveCheckIn}
          />
        );
      })}
    </div>
  );
}

function CheckInCard({ assignment, member, history, onSave }) {
  const [week, setWeek] = useState(thisMonday());
  const [status, setStatus] = useState("on track");
  const [actual, setActual] = useState(String(assignment.capacityAllocated));
  const [note, setNote] = useState("");
  const [flash, setFlash] = useState(false);

  const first = firstName(member.name);
  const normWeek = mondayOf(week);
  const existing = history.find((c) => c.weekOf === normWeek);

  // When the chosen week changes, pre-fill from an existing check-in for that
  // week so saving edits it rather than silently overwriting blind.
  useEffect(() => {
    const ex = history.find((c) => c.weekOf === mondayOf(week));
    if (ex) {
      setStatus(ex.progressStatus);
      setActual(String(ex.capacityActual));
      setNote(ex.note || "");
    } else {
      setStatus("on track");
      setActual(String(assignment.capacityAllocated));
      setNote("");
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
            <span className="cap-suffix">% vs {assignment.capacityAllocated}% planned</span>
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

function WrapUpTab({ bundle, membersById, onUpdateProject }) {
  const { project, assignments, checkIns } = bundle;

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
              </div>
            );
          })}
        </div>
      )}

      <div className="section-head">
        <h2>Week by week</h2>
      </div>
      <div className="card">
        {weeks.length === 0 ? (
          <p style={{ color: "#A0937F", fontSize: 14, margin: 0 }}>
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
  const [page, setPage] = useState({ name: "dashboard" });
  const [modal, setModal] = useState(null);

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
            });
          }
        }
        loaded.sort((a, b) => (a.project.startDate || "").localeCompare(b.project.startDate || ""));
        setMembers(Array.isArray(m) ? m : []);
        setBundles(loaded);
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
    for (const b of bundles) {
      const dropped = b.assignments.filter((a) => a.memberId === memberId).map((a) => a.id);
      if (dropped.length === 0) continue;
      persistBundle({
        ...b,
        assignments: b.assignments.filter((a) => a.memberId !== memberId),
        checkIns: b.checkIns.filter((c) => !dropped.includes(c.assignmentId)),
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
    });
  };

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
          style={{ paddingTop: 80, textAlign: "center", color: "#A0937F" }}
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
  if (page.name === "roster") {
    content = (
      <Roster
        members={members}
        bundles={bundles}
        onNewMember={() => setModal({ type: "member" })}
        onEditMember={(m) => setModal({ type: "member", member: m })}
        onDeleteMember={deleteMember}
      />
    );
  } else if (page.name === "project") {
    const bundle = bundles.find((b) => b.project.id === page.id);
    content = bundle ? (
      <ProjectView
        bundle={bundle}
        membersById={membersById}
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
      <header className="hdr">
        <button className="wordmark" onClick={() => setPage({ name: "dashboard" })}>
          noon<span className="wm-dot">.</span>
        </button>
        <nav className="nav">
          <button
            className={page.name !== "roster" ? "on" : ""}
            onClick={() => setPage({ name: "dashboard" })}
          >
            Projects
          </button>
          <button
            className={page.name === "roster" ? "on" : ""}
            onClick={() => setPage({ name: "roster" })}
          >
            People
          </button>
        </nav>
      </header>

      <main className="container">{content}</main>

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
