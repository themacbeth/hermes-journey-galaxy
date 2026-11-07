// App shell: loads journeys from the local server, runs first-run setup, the side panel,
// drag-and-drop import, and live reload when journey files change.
const $ = (id) => document.getElementById(id);
const Q = new URLSearchParams(location.search);
const api = (path, opts = {}) =>
  fetch(path, { ...opts, headers: { "X-Galaxy": "1", ...(opts.headers || {}) } }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const SERVED = location.protocol.startsWith("http");
let STATIC_HOST = false, probed = false; // set when /api is missing (page served by a plain static host)
let ctx = null, lastFp = null, current = null;

export async function loadJourneys() {
  if (SERVED && !probed) { probed = true; try { await api("/api/fingerprint"); } catch { STATIC_HOST = true; } }
  // Static hosting (no galaxy.py, e.g. GitHub Pages): show the bundled demo galaxy.
  if (!SERVED || STATIC_HOST) {
    try { return (await (await fetch("demo-galaxy.json")).json()).profiles; } catch { return []; }
  }
  const data = await api(`/api/journeys${Q.has("memories") ? "?memories=1" : ""}`);
  current = data;
  return data.journeys;
}

function toast(msg, ms = 4200) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), ms);
}

async function rebuild(note) {
  const journeys = await loadJourneys();
  const n = ctx.rebuild(journeys);
  renderPanel();
  if (note) toast(note.replace("{n}", n));
  try { lastFp = (await api("/api/fingerprint")).fp; } catch {}
}

// ---------- first run: offer the detected Hermes install ----------
function showSetup(state) {
  const h = state.hermes, box = $("setup");
  if (h.found) {
    const withData = h.profiles.filter((p) => p.skills || p.memories);
    const rows = h.profiles.map((p) => `<label class="prof"><input type="checkbox" value="${esc(p.name)}" ${p.skills || p.memories ? "checked" : "disabled"}>
      <span class="pn">${esc(p.name)}</span><span class="pc">${p.error ? "could not read" : `${p.skills} skills · ${p.memories} memories`}</span></label>`).join("");
    box.innerHTML = `<div class="card">
      <div class="eyebrow">FOUND HERMES AGENT</div>
      <h2>Show your journey?</h2>
      <p>Hermes Agent v${esc(h.version)} is installed at <code>${esc(h.path)}</code>. The galaxy can read your journey from it. Nothing leaves this computer, and memory text stays hidden.</p>
      <div class="profs">${rows}</div>
      <label class="namefield">Name on your system <input id="setup-name" maxlength="24" value="${esc(state.settings.name || state.default_name)}"></label>
      <div class="actions"><button class="primary" id="setup-yes" ${withData.length ? "" : "disabled"}>Show my journey</button><button id="setup-no">Just show the demo</button></div>
      ${withData.length ? "" : `<p class="note">These profiles have no skills or memories yet. Use Hermes for a while, then come back and press Refresh.</p>`}
    </div>`;
    $("setup-yes").onclick = async () => {
      const picked = [...box.querySelectorAll(".prof input:checked")].map((i) => i.value);
      const all = picked.length === withData.length;
      await api("/api/settings", { method: "POST", body: JSON.stringify({ hermes: "on", profiles: all ? null : picked, name: $("setup-name").value.trim() || null }) });
      box.classList.remove("show"); rebuild("Showing {n} journey(s) from Hermes.");
    };
  } else {
    box.innerHTML = `<div class="card">
      <div class="eyebrow">HERMES AGENT NOT FOUND</div>
      <h2>Here is a demo galaxy</h2>
      <p>To see your own journey, run this where Hermes is installed and drop the file onto this page:</p>
      <pre>hermes journey --json &gt; my-journey.json</pre>
      <p>You can also put journey files in <code>${esc(state.journeys_dir)}</code>, or restart with <code>--hermes /path/to/hermes</code>.</p>
      <div class="actions"><button class="primary" id="setup-no">OK</button></div>
    </div>`;
  }
  $("setup-no").onclick = async () => { await api("/api/settings", { method: "POST", body: JSON.stringify({ hermes: "off" }) }); box.classList.remove("show"); };
  box.classList.add("show");
  ctx.pauseTour(true);
  const close = () => ctx.pauseTour(false);
  box.querySelectorAll("button").forEach((b) => b.addEventListener("click", close));
}

// ---------- side panel ----------
function renderPanel() {
  const list = $("panel-list"); if (!list) return;
  const sys = ctx.systems();
  const src = new Map((current?.journeys || []).map((j) => [j.name, j]));
  list.innerHTML = sys.length ? sys.map((s) => {
    const j = src.get(s.name), c = `#${s.color.getHexString()}`;
    return `<button class="sys" data-name="${esc(s.name)}"><span class="dot" style="background:${c};box-shadow:0 0 10px ${c}"></span>
      <span class="sn">${esc(s.name)}</span><span class="sm">${s.nSkills} skills · ${s.nMem} memories</span>
      <span class="ss">${esc(j ? j.source : "")}</span></button>`;
  }).join("") : `<p class="note">No journeys yet.</p>`;
  list.querySelectorAll(".sys").forEach((b) => (b.onclick = () => { closePanel(); ctx.focusSystem(b.dataset.name); }));
  const banner = $("demo-banner");
  if (banner) banner.classList.toggle("show", !!current?.demo);
  const warn = $("panel-warn");
  if (warn) warn.innerHTML = (current?.warnings || []).map((w) => `<p class="note">${esc(w)}</p>`).join("");
}
function openPanel() { $("panel").classList.add("open"); ctx.pauseTour(true); renderPanel(); }
function closePanel() { $("panel").classList.remove("open"); ctx.pauseTour(false); }

async function renderHermesRow() {
  const row = $("panel-hermes"); if (!row) return;
  try {
    const st = await api("/api/state"), h = st.hermes;
    if (!h.found) { row.innerHTML = `<p class="note">Hermes Agent not detected on this computer.</p>`; return; }
    const on = st.settings.hermes === "on";
    row.innerHTML = `<div class="hrow"><div><div class="hl">Hermes Agent v${esc(h.version)}</div><div class="hs">${esc(h.path)}</div></div>
      <label class="switch"><input type="checkbox" id="hermes-toggle" ${on ? "checked" : ""}><span></span></label></div>`;
    $("hermes-toggle").onchange = async (e) => {
      await api("/api/settings", { method: "POST", body: JSON.stringify({ hermes: e.target.checked ? "on" : "off" }) });
      rebuild(e.target.checked ? "Showing your Hermes journey." : "Hermes journey hidden.");
    };
  } catch {}
}

// ---------- drag and drop / file picker import ----------
async function importFiles(files) {
  let ok = 0;
  for (const f of files) {
    try { await api(`/api/import?name=${encodeURIComponent(f.name)}`, { method: "POST", body: await f.arrayBuffer() }); ok++; }
    catch (e) { toast(`${f.name}: ${e.message}`, 6000); }
  }
  if (ok) rebuild(`Added ${ok} journey file${ok > 1 ? "s" : ""}. Showing {n} system(s).`);
}

export async function setupPanel(c) {
  ctx = c;
  if (Q.has("tv")) document.body.classList.add("tv");
  if (!SERVED || STATIC_HOST) { document.body.classList.add("static"); return; }
  $("menu-btn").onclick = openPanel;
  $("panel-close").onclick = closePanel;
  $("panel-refresh").onclick = async () => {
    $("panel-refresh").disabled = true;
    try { await api("/api/refresh", { method: "POST" }); await rebuild("Reloaded. Showing {n} system(s)."); renderHermesRow(); }
    catch (e) { toast(e.message); }
    $("panel-refresh").disabled = false;
  };
  $("panel-file").onchange = (e) => importFiles([...e.target.files]);
  let dragN = 0;
  addEventListener("dragenter", (e) => { e.preventDefault(); dragN++; document.body.classList.add("dragging"); });
  addEventListener("dragleave", () => { if (--dragN <= 0) { dragN = 0; document.body.classList.remove("dragging"); } });
  addEventListener("dragover", (e) => e.preventDefault());
  addEventListener("drop", (e) => { e.preventDefault(); dragN = 0; document.body.classList.remove("dragging"); importFiles([...e.dataTransfer.files]); });
  addEventListener("keydown", (e) => { if (e.key === "Escape") closePanel(); if (e.key === "m" && !e.target.closest("input")) $("panel").classList.contains("open") ? closePanel() : openPanel(); });

  const state = await api("/api/state");
  $("panel-dir").textContent = state.journeys_dir;
  renderPanel(); renderHermesRow();
  if (state.settings.hermes === "unset" && !state.demo_only && !Q.has("tv")) showSetup(state);
  else if (current?.demo && !state.hermes.found && !Q.has("tv")) toast("Demo galaxy. Drop a journey file here, or press M for options.", 7000);
  // live reload: pick up new or edited files in journeys/ without a page refresh
  try { lastFp = (await api("/api/fingerprint")).fp; } catch {}
  setInterval(async () => {
    try { const { fp } = await api("/api/fingerprint"); if (lastFp && fp !== lastFp) { lastFp = fp; rebuild("Journeys changed. Showing {n} system(s)."); } } catch {}
  }, 4000);
}
