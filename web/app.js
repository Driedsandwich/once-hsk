"use strict";

const $ = id => document.getElementById(id);
const localDemo = new URLSearchParams(location.search).get("mock") === "1";
// Colours live in styles.css variables; ?theme=receipt|violet|gold is applied by index.html. Keep the browser UI colour in sync with --bg.
const themeParam = new URLSearchParams(location.search).get("theme");
(function syncThemeColor() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (bg && meta) meta.setAttribute("content", bg);
})();
const unavailable = "—";
const labels = {
  NEW: "Request created", ORDER_CREATED: "Order created", PREPARED: "Quote locked",
  APPROVED_SIGN: "You approved signing", SIGNED: "Signed", FINALIZED: "Mandate finalized",
  APPROVED_SUBMIT: "You approved sending", SUBMIT_INTENT: "Sending", SUBMITTED: "Sent",
  CONFIRMED: "Confirmed on chain", FAILED: "Failed", PENDING_CONFIRMATION: "Waiting for confirmation"
};
const help = {
  hsp: "HashKey's payment settlement platform",
  calls: "How many times the payment was sent. 1 means no double payment",
  safe: "PAYMENT-SAFE: on chain with half of the required confirmations",
  raw: "The amount in the smallest unit of the stablecoin",
  generation: "Each restart starts the agent again as a new generation. 2 means it has been restarted once.",
  mcp: "MCP (Model Context Protocol) is how an AI agent calls tools. pay_once pays for an order after a person approves it, get_payment looks a payment up by its request ID, and resume_pending resumes pending orders under the approval rules."
};
function escapeHtml(value) {
  return String(value ?? unavailable).replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));
}
const icon = name => '<svg aria-hidden="true" class="icon"><use href="#' + name + '"/></svg>';
const hint = (name, label) => '<button class="help" data-help="' + name + '" aria-label="About ' + label + '" aria-expanded="false">?</button>';
function readCache(key) {
  try { return JSON.parse(sessionStorage.getItem(key)) || {}; } catch { return {}; }
}
function cache(key, value) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage is optional. */ }
}
// Shorten long hex values (middle left out). The full value stays in the tooltip and behind the Copy button.
function short(value) {
  const s = String(value ?? "");
  return !s || s === unavailable || s.includes("…") || s.length <= 16 ? s : s.slice(0,6) + "…" + s.slice(-4);
}
let copied = "";
function copyBtn(value) {
  const s = String(value ?? "");
  if (!s || s === unavailable || s.includes("…")) return "";
  return ' <button class="copy" data-copy="' + escapeHtml(s) + '" aria-label="Copy full value">' + (copied === s ? "Copied" : "Copy") + '</button>';
}
function learnText(value) {
  if (value == null || value === "") return unavailable;
  const parts = String(value).split(/[,、]/u).map(x => x.trim()).filter(Boolean);
  const text = parts.length > 1 ? parts.slice(0,-1).join(", ") + " and " + parts.at(-1) : parts[0] ?? unavailable;
  return escapeHtml(text) + '<span class="aside">Not in your local data</span>';
}
// Only the early steps fold. Sending, the lost connection and the restart stay open: that is the story.
const groupOf = {NEW:"order", ORDER_CREATED:"order", SIGNED:"signed", FINALIZED:"signed"};
const openGroups = new Set();
// Fold the early raw rows (Order created, Signed) into one step each. A step with several rows opens on click.
function fold(rows, rid) {
  const items = [];
  for (const e of rows) {
    const g = groupOf[e.state];
    const last = items.at(-1);
    if (g && last?.group === g) { last.children.push(e); continue; }
    items.push({group:g, key:rid + ":" + (g || items.length), children:[e]});
  }
  return items.map(it => {
    const first = it.children[0], last = it.children.at(-1);
    if (it.children.length === 1) return {...first, key:it.key, children:[]};
    const title = {order:"Order created", signed:"Signed"}[it.group];
    return {at:last.at, label:title, note:"",
      style:it.children.some(c => c.style === "warn") ? "warn" : "", key:it.key, children:it.children};
  });
}
const termsCache = localDemo ? {} : readCache("once-quote-terms");
let selectedId, restartResult, state = {}, busy = false, source, streamFailed = false;
let acknowledgedApproval;
let stateError = "", actionError = "";
function activeRequest() {
  const requests = state.requests || [];
  return requests.find(r => r.requestId === selectedId) ||
    requests.find(r => r.awaitingApproval) ||
    [...requests].sort((a,b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];
}
function fmtTime(at) {
  const d = new Date(at);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(11, 19) : unavailable;
}
function activity(r) {
  if (!r) return [];
  const rows = (r.history || []).map(h => ({
    at:h.at, state:h.state, label:labels[h.state] || h.state,
    note:[h.state === "SUBMIT_INTENT" ? "(recorded before sending)" : "", h.note].filter(Boolean).join(" "),
    style:h.state === "FAILED" ? "warn" : h.state === "CONFIRMED" ? "confirmed" : ""
  }));
  let crashPending = false;
  const events = [...(state.timeline || [])].sort((a,b) => Date.parse(a.at) - Date.parse(b.at));
  for (const e of events) {
    const data = e.data || {};
    if (data.requestId && data.requestId !== r.requestId) continue;
    if (e.event === "run-error" && (data.requestId === r.requestId || (state.requests.length === 1 && Date.parse(e.at) >= Date.parse(r.createdAt)))) {
      const sent = r.history?.some(h => ["SUBMIT_INTENT", "SUBMITTED"].includes(h.state) && Date.parse(h.at) <= Date.parse(e.at));
      rows.push({at:e.at, label:sent ? "CONNECTION LOST (simulated)" : "Agent stopped", note:sent ? "The agent crashed right after paying. This is the test." : data.message, style:"warn"});
      crashPending = !!sent;
    }
    const matchesRestart = data.requestId === r.requestId || (Array.isArray(data.resumed)
      ? data.resumed.some(result => result.requestId === r.requestId)
      : state.requests.length === 1 || (restartResult?.generation === data.generation && restartResult.resumed?.some(result => result.requestId === r.requestId)));
    if (crashPending && matchesRestart && e.event === "restart" && ["resuming","resumed"].includes(data.phase)) {
      rows.push({at:e.at, label:"RESUMED", note:"Asked HSP about the original payment. No resend.", style:"resumed"});
      crashPending = false;
    }
  }
  return rows.sort((a,b) => Date.parse(a.at) - Date.parse(b.at));
}
function renderAlerts() {
  const r = activeRequest();
  const runError = r?.error && (r.state === "SUBMIT_INTENT" ? "Connection lost after sending. Restart the agent to check the original payment." : String(r.error));
  const msg = actionError || stateError || runError || (streamFailed ? "Event stream disconnected. Reconnecting to the agent…" : "");
  $("alerts").hidden = !msg;
  $("alerts").innerHTML = escapeHtml(msg) + (stateError && !localDemo ? ' <a href="?mock=1' + (["receipt","violet","gold"].includes(themeParam) ? "&theme=" + themeParam : "") + '">Open mock demo</a>' : "");
}
function render() {
  const r = activeRequest();
  const terms = termsCache[r?.requestId] || {};
  const rows = activity(r);
  const resumed = rows.some(e => e.style === "resumed");
  const crashed = rows.some(e => e.label === "CONNECTION LOST (simulated)");
  const confirmed = r?.state === "CONFIRMED";
  const pending = r?.awaitingApproval;
  const armed = state.faults || {};
  const modeText = {mock:"Test network: local HSP simulator. No real money.", external:"HSP QA (test network). No real money."};
  $("network").textContent = modeText[state.mode] || "Test network. No real money.";
  $("reqid").innerHTML = r ? 'Request <span title="' + escapeHtml(r.requestId) + '">' + escapeHtml(short(r.requestId)) + '</span>' + copyBtn(r.requestId) : "Awaiting request";
  const steps = ["Ask for a quote and approve","Break the connection right after paying","Restart the agent"];
  const done = [!!r?.history?.some(h => ["APPROVED_SIGN","APPROVED_SUBMIT"].includes(h.state)), crashed, resumed];
  const current = !done[0] ? 0 : !crashed ? 1 : 2;
  $("steps").innerHTML = steps.map((s,i) => '<li class="step ' + (done[i] ? "done" : i === current ? "current" : "") + '"' + (i === current && !done[i] ? ' aria-current="step"' : "") + '><i>' + (done[i] ? icon("check") : i+1) + '</i>' + s + '</li>').join("");
  document.querySelectorAll('[data-action="quote"]').forEach(b => b.classList.toggle("next", current === 0 && !done[0]));
  document.querySelector('[data-action="drop-after-submit"]').classList.toggle("next", current === 1 && !done[1]);
  document.querySelector('[data-action="restart"]').classList.toggle("next", current === 2 && !done[2]);
  const allDone = done.every(Boolean);
  $("next").hidden = !allDone;
  $("next").innerHTML = allDone ? '<b>Next</b>: try “Expire the quote”, then ask for a new quote.' : "";
  $("guide").classList.toggle("alldone", allDone);
  const timeCell = e => '<time title="' + escapeHtml(e.at) + '">' + fmtTime(e.at) + '</time>';
  const items = fold(rows, r?.requestId);
  $("history").innerHTML = items.length ? items.map(e => {
    const open = openGroups.has(e.key);
    const name = e.children.length
      ? '<button class="fold" data-fold="' + escapeHtml(e.key) + '" aria-expanded="' + open + '"><span class="chev" aria-hidden="true">' + (open ? "▾" : "▸") + '</span>' + escapeHtml(e.label) + '<span class="count">' + e.children.length + ' steps</span></button>'
      : escapeHtml(e.label);
    const sub = e.children.length && open ? '<ul class="substeps">' + e.children.map(c => '<li><span>' + escapeHtml(c.label) + '</span>' + timeCell(c) + (c.note ? '<small>' + escapeHtml(c.note) + '</small>' : "") + '</li>').join("") + '</ul>' : "";
    return '<li class="event ' + e.style + '"><i class="node">' + (e.style === "warn" ? "!" : icon("check")) + '</i><span class="evname">' + name + '</span>' + timeCell(e) + (e.note ? '<small>' + escapeHtml(e.note) + '</small>' : "") + sub + '</li>';
  }).join("") : '<li class="empty">Ask for a quote to start the receipt.</li>';
  const hsp = state.hsp || {};
  const calls = hsp.submitPaymentCalls;
  const paidOnce = calls === 1 && hsp.accepted === 1;
  const verdict = paidOnce ? "Paid exactly once" : calls >= 2 ? "Submitted " + calls + " times — check" : calls === 0 ? "Not paid yet" : calls === 1 ? "Awaiting acceptance" : "Awaiting agent";
  const goodQuery = resumed && confirmed;
  let queryText = "No recovery query yet";
  if (crashed && !resumed) queryText = "Awaiting restart to query HSP";
  if (resumed) queryText = goodQuery ? "Original payment confirmed" : "Waiting for confirmation";
  const chip = confirmed ? '<span class="stamp">' + icon("check") + 'PAYMENT-SAFE</span>' + hint("safe", "payment-safe") : "";
  $("outcome").innerHTML = '<div class="hero ' + (paidOnce ? "good" : calls >= 2 ? "warn" : "") + '">' + (paidOnce ? '<div class="sealclip"><div class="seal">' + icon("shield") + '</div></div>' : "") + '<div class="chip">' + chip + '</div><div class="herohead"><div class="eyebrow">Payment outcome</div></div><h3>' + escapeHtml(verdict) + '</h3><div class="bignum mono">submit_payment calls: ' + escapeHtml(calls) + hint("calls","submit_payment calls") + '</div><div class="metrics mono">orders: ' + escapeHtml(hsp.orders) + '</div></div><div class="query ' + (goodQuery ? "good" : "") + '">' + icon(goodQuery ? "shield" : "clock") + '<span>Query result · ' + queryText + '</span></div>';
  const pair = (label, value, cls = "") => '<div><dt>' + label + '</dt><dd class="' + cls + '">' + value + '</dd></div>';
  const agent = (name,address) => escapeHtml(name) + '<span class="address mono" title="' + escapeHtml(address) + '">' + escapeHtml(short(address)) + copyBtn(address) + '</span>';
  const amount = r?.amountUsd ?? terms.amountUsd;
  $("summary").innerHTML = '<h3 class="summary-title">Payment summary</h3><dl class="summary">' +
    pair("Pay to",agent(r?.sellerAgentId ?? terms.sellerAgentId, pending?.review?.pay_to ?? terms.payTo ?? r?.payTo)) +
    pair("Payer",agent(state.buyerAgentId, pending?.review?.payer ?? state.buyer)) +
    pair("Amount",amount != null ? escapeHtml(amount) + " USD" : unavailable,"amount") +
    pair("Item",escapeHtml(r?.item ?? terms.item)) + pair("What you learn",learnText(terms.whatYouLearn ?? r?.whatYouLearn)) + '</dl>';
  const recovered = restartResult?.resumed?.find(x => x.requestId === r?.requestId);
  const result = recovered ? (labels[recovered.state] || recovered.state) : !restartResult && goodQuery ? labels.CONFIRMED : "";
  const resultText = result ? "Query-only · " + result + " · No resend" : restartResult?.resumed?.length === 0 ? "No pending payments to resume" : resumed ? "Original payment queried" : crashed ? "Agent stopped · Restart to recover" : "No recovery yet";
  $("recovery").innerHTML = '<div class="generation"><span>' + (state.generation > 1 ? "Agent restarted: generation" : "Agent running: generation") + hint("generation","generation") + '</span><strong>' + escapeHtml(state.generation) + '</strong></div><div class="result ' + (resumed || result ? "" : "pending") + '">' + icon(resumed || result ? "check" : "clock") + escapeHtml(resultText) + '</div>';
  $("approval").hidden = !pending;
  if (pending) {
    const review = pending.review || {};
    $("approval").innerHTML = '<div class="title"><span class="tile">' + icon("key") + '</span><h2>' + (pending.stage === "sign" ? "Approve signing" : "Approve sending") + '</h2></div><div class="approval-grid"><p class="approval-text">' + escapeHtml(pending.text ?? terms.approvalText) + '</p><dl class="review">' + pair("Pay to",escapeHtml(review.pay_to)) + pair("Payer",escapeHtml(review.payer)) + pair('token_total_raw <small>raw units</small> ' + hint("raw","raw units"),escapeHtml(review.token_total_raw)) + '</dl></div><div class="approval-actions"><button class="primary" data-action="approve">' + icon("check") + 'Approve</button><button class="secondary" data-action="decline">Decline</button></div>';
  }
  document.querySelectorAll("[data-action]").forEach(btn => {
    const a = btn.dataset.action;
    const alreadyApproved = (a === "approve" || a === "decline") && pending && acknowledgedApproval === JSON.stringify([r.requestId,pending.stage,pending.approvalId]);
    btn.disabled = busy || alreadyApproved || (a === "quote" && !!(pending || r?.running || (crashed && !resumed && !confirmed))) || !!armed[a];
    if (a in armed) {
      btn.setAttribute("aria-pressed", String(!!armed[a]));
      btn.querySelector("span").textContent = (a === "expire-quote" ? "Expire the quote" : "Break the connection after sending") + (armed[a] ? " · Armed" : "");
    }
  });
  renderAlerts();
}

// The offline fixture uses the supplied identities, amounts and abbreviated identifiers.
const example = {
  requestId:"0x7f3a…e21", buyer:"0x9AC…D54", buyerAgentId:"Research Agent",
  sellerAgentId:"Pool Data Agent", payTo:"0x4B2…91c", amountUsd:"0.50",
  item:"HSKSwap 1h flow report", whatYouLearn:"1h inflow (USD), 1h outflow (USD)",
  text:'Buy "HSKSwap 1h flow report"?\nPay to: Pool Data Agent (0x4B2…91c)\nAmount: 0.50 USD\nWhat you learn: 1h inflow (USD), 1h outflow (USD)'
};
const at = tail => "2026-11-23T23:52:" + tail + "Z";
function mockQuote() {
  const faults = state.faults || {"drop-after-submit":false,"expire-quote":false};
  state = {mode:"mock", generation:1, buyer:example.buyer, buyerAgentId:example.buyerAgentId,
    requests:[{requestId:example.requestId, item:example.item, amountUsd:example.amountUsd,
      sellerAgentId:example.sellerAgentId, createdAt:at("26.274"), flowId:"flow-81d7…",
      recordedSubmitAttempts:0, running:false, error:null, history:[]}],
    timeline:[], hsp:{submitPaymentCalls:0,accepted:0,orders:1}, faults};
  termsCache[example.requestId] = {...example, expiresAt:"2026-11-24T00:02:26.272Z"};
  restartResult = null;
  mockMark("NEW","26.283");
  mockMark("ORDER_CREATED","26.299");
  mockMark("PREPARED","26.305");
  mockApproval("sign");
}
function mockMark(name, time) {
  const r = activeRequest();
  r.state = name;
  r.history.push({state:name,at:at(time)});
}
function mockApproval(stage) {
  activeRequest().awaitingApproval = {approvalId:stage === "sign" ? "1" : "2", stage,text:example.text,
    review:{payer:example.buyer, pay_to:example.payTo, token_total_raw:"1000000"}};
}
function mockApprove(approve) {
  const r = activeRequest();
  const stage = r.awaitingApproval.stage;
  r.awaitingApproval = null;
  if (!approve || (stage === "submit" && state.faults["expire-quote"])) {
    state.faults["expire-quote"] = false;
    mockMark("FAILED",stage === "sign" ? "27.356" : "28.373");
    r.error = approve ? "Quote expired. Ask for a new quote." : "Approval declined.";
    r.history.at(-1).note = r.error;
    return;
  }
  if (stage === "sign") {
    mockMark("APPROVED_SIGN","27.356");
    mockMark("SIGNED","27.365");
    mockMark("FINALIZED","27.373");
    mockApproval("submit");
    return;
  }
  mockMark("APPROVED_SUBMIT","28.373");
  mockMark("SUBMIT_INTENT","28.381");
  r.recordedSubmitAttempts++;
  state.hsp.submitPaymentCalls++;
  state.hsp.accepted++;
  if (state.faults["drop-after-submit"]) {
    state.faults["drop-after-submit"] = false;
    r.error = "fetch failed";
    state.timeline.push({event:"run-error",at:at("28.390"),data:{requestId:r.requestId,message:r.error}});
  } else {
    mockMark("SUBMITTED","28.390");
    mockMark("CONFIRMED","30.450");
    r.txHash = "mock-transaction";
  }
}
function mockRestart() {
  const r = activeRequest();
  const resumed = [];
  state.timeline.push({event:"restart",at:at("29.100"),data:{phase:"crashing",generation:state.generation}});
  state.generation++;
  if (r?.state === "SUBMIT_INTENT" && state.hsp.accepted === 1) {
    state.timeline.push({event:"restart",at:at("30.100"),data:{phase:"resuming",generation:state.generation}});
    mockMark("CONFIRMED","30.450");
    r.error = null;
    r.txHash = "mock-transaction";
    resumed.push({requestId:r.requestId,state:r.state});
  }
  state.timeline.push({event:"restart",at:at("30.460"),data:{phase:"resumed",generation:state.generation}});
  restartResult = {ok:true,generation:state.generation,resumed};
}
function initMock() {
  mockQuote();
  mockApprove(true);
  state.faults["drop-after-submit"] = true;
  mockApprove(true);
  mockRestart();
}
async function api(path, body) {
  const options = body === undefined ? {cache:"no-store"} : {
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)
  };
  const response = await fetch("/api/" + path, options);
  if (!response.ok) throw new Error("Agent returned HTTP " + response.status + ".");
  return response.json();
}
let refreshWork, refreshAgain = false;
function refresh() {
  if (refreshWork) {
    refreshAgain = true;
    return refreshWork;
  }
  refreshWork = readSnapshots().finally(() => { refreshWork = null; });
  return refreshWork;
}
async function readSnapshots() {
  do {
    refreshAgain = false;
    try {
      const next = await api("state");
      if (!Array.isArray(next.requests)) throw new Error("Invalid state");
      state = next;
      stateError = "";
      for (const e of state.timeline || []) {
        if (e.event === "quote" && e.data?.requestId && !termsCache[e.data.requestId]?.item) rememberQuote(e.data);
      }
      for (const r of state.requests) {
        if (r.awaitingApproval?.review?.pay_to) {
          termsCache[r.requestId] = {...termsCache[r.requestId],payTo:r.awaitingApproval.review.pay_to};
        }
      }
      cache("once-quote-terms",termsCache);
    } catch { stateError = "Could not reach the agent. Is the local server running?"; }
    render();
  } while (refreshAgain);
}
function rememberQuote(q) {
  if (!q?.requestId || !q.terms) return;
  termsCache[q.requestId] = {...q.terms,approvalText:q.approvalText ?? q.decision?.approvalText};
  cache("once-quote-terms",termsCache);
}
function startLive() {
  refresh();
  source = new EventSource("/api/events");
  source.onopen = () => { streamFailed = false; refresh(); };
  source.onerror = () => { streamFailed = true; renderAlerts(); };
  for (const name of ["quote","approval","state","run-error","restart","fault"]) {
    source.addEventListener(name, e => {
      try {
        const data = JSON.parse(e.data);
        if (name === "quote") rememberQuote(data);
        if (name === "restart" && Array.isArray(data.resumed)) restartResult = data;
      } catch { /* The state snapshot also contains the event history. */ }
      refresh();
    });
  }
}
async function perform(action) {
  if (busy) return;
  const r = activeRequest();
  const stage = r?.awaitingApproval?.stage;
  busy = true;
  actionError = "";
  render();
  try {
    if (action === "quote") {
      if (localDemo) mockQuote();
      else {
        const q = await api("quote",{});
        selectedId = q.requestId;
        acknowledgedApproval = null;
        rememberQuote(q);
        restartResult = null;
      }
    } else if (action === "approve" || action === "decline") {
      if (localDemo) mockApprove(action === "approve");
      else {
        const response = await api("approve",{requestId:r.requestId,stage,approve:action === "approve"});
        if (response.ok) acknowledgedApproval = JSON.stringify([r.requestId,stage,r.awaitingApproval.approvalId]);
      }
    } else if (action === "restart") {
      if (localDemo) mockRestart();
      else restartResult = await api("restart",{});
    } else if (localDemo) state.faults[action] = true;
    else await api("fault",{kind:action});
  } catch (err) {
    actionError = err instanceof TypeError ? "Could not reach the agent. Is the local server running?" : "Action failed. " + err.message;
  } finally {
    if (!localDemo) await refresh();
    busy = false;
    render();
  }
}
let openHelp;
function closeHelp() {
  $("tooltip").hidden = true;
  openHelp?.setAttribute("aria-expanded","false");
  openHelp?.removeAttribute("aria-describedby");
  openHelp = null;
}
document.addEventListener("click", event => {
  const button = event.target.closest("button");
  const previous = openHelp;
  closeHelp();
  if (button?.dataset.help && previous !== button) {
    openHelp = button;
    button.setAttribute("aria-expanded","true");
    button.setAttribute("aria-describedby","tooltip");
    const tip = $("tooltip");
    tip.textContent = help[button.dataset.help];
    tip.hidden = false;
    const rect = button.getBoundingClientRect();
    tip.style.left = Math.max(8,Math.min(rect.left,innerWidth-tip.offsetWidth-8)) + "px";
    tip.style.top = (rect.bottom + tip.offsetHeight + 8 < innerHeight ? rect.bottom+6 : rect.top-tip.offsetHeight-6) + "px";
  } else if (button?.dataset.fold) {
    const k = button.dataset.fold;
    if (!openGroups.delete(k)) openGroups.add(k);
    render();
  } else if (button?.dataset.copy) {
    const value = button.dataset.copy;
    navigator.clipboard?.writeText(value).then(() => {
      copied = value; render();
      setTimeout(() => { if (copied === value) { copied = ""; render(); } }, 1400);
    }).catch(() => {});
  } else if (button?.dataset.action) perform(button.dataset.action);
});
document.addEventListener("keydown", e => { if (e.key === "Escape") closeHelp(); });
window.addEventListener("resize",closeHelp);
window.addEventListener("scroll",closeHelp,{passive:true});
if (localDemo) initMock();
render();
if (!localDemo) startLive();
