(() => {
  const panel = document.getElementById("phone-panel");
  const nav = document.getElementById("phone-nav");
  const tabs = { home: "A1", picks: "Picks", sessions: "Coding", catalog: "Catalog", notes: "Notes", jobs: "Jobs", more: "More" };
  let active = "home", version = 0, pickStatus = "new", pickKind = "all", picks = [], counts = {}, offset = 0, more = false;
  const html = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const post = (path, body) => call(path, { method: "POST", body: JSON.stringify(body) });
  const buttons = (values, selected, attr, label) => `<div class="phone-chips" role="group" aria-label="${label}">${values.map(([value, title]) => `<button ${attr}="${value}" aria-pressed="${selected === value}">${html(title)}</button>`).join("")}</div>`;
  function navigation() {
    nav.innerHTML = Object.entries(tabs).map(([key, label]) => `<button data-view="${key}" aria-pressed="${active === key}">${label}</button>`).join("");
    nav.querySelectorAll("button").forEach(button => button.onclick = () => open(button.dataset.view));
  }
  async function open(view) {
    active = tabs[view] ? view : "home"; version++;
    window.PhoneView.active = active;
    document.getElementById("app").hidden = active !== "home"; panel.hidden = active === "home";
    navigation();
    if (active === "home") { if (A) render(false); return; }
    panel.innerHTML = '<section class="card">Loading…</section>';
    const current = version;
    try { await loadView(current); }
    catch (error) { if (current === version) panel.innerHTML = `<section class="card"><h2>Couldn't load ${html(tabs[active])}</h2><p role="alert">${html(error.message)}</p><button data-retry>Retry</button></section>`; panel.querySelector("[data-retry]")?.addEventListener("click", () => open(active)); }
  }
  async function loadView(current) {
    if (active === "sessions") return loadSessions(current);
    if (active === "catalog") return loadCatalog(current);
    if (active === "notes") return loadNotes(current);
    if (active === "jobs") return loadJobs(current);
    if (active === "more") return loadMore(current);
    if (active === "picks") {
      const [rows, tally] = await Promise.all([fetchPicks(0), call("/api/picks/counts")]);
      if (current !== version) return;
      picks = rows; counts = tally; offset = rows.length; more = rows.length === 20; drawPicks();
    }
  }
  const fetchPicks = start => call(`/api/picks?status=${pickStatus}&kind=${pickKind}&limit=20&offset=${start}&include_ok=1`);
  function licenseUrl(pick) {
    const repo = String(pick.repo || "").split("/").map(encodeURIComponent).join("/");
    return `https://huggingface.co/${pick.kind === "dataset" ? "datasets/" : pick.kind === "space" ? "spaces/" : ""}${repo}`;
  }
  function pickCard(pick) {
    const gated = pick.gated && !["false", "False", "null"].includes(String(pick.gated));
    const fit = pick.kind === "model" && pick.size_bytes && window.MachineFit ? window.MachineFit(pick.size_bytes, pick.repo).filter(machine => machine.fits).map(machine => `fits ${machine.label}`) : [];
    return `<article class="card"><h3>${html(pick.repo || pick.id)}</h3><p>${html(pick.kind)} · ${html(gb(pick.size_bytes))} · score ${html(pick.score)} · ${html(pick.status)}</p><p class="sub">${[...fit, ...(pick.reasons || []), ...(pick.flags || [])].map(html).join(" · ")}</p>${gated ? `<a class="phone-link" href="${licenseUrl(pick)}" target="_blank" rel="noopener">Accept license first ↗</a>` : ""}${pick.status !== "stashed" ? `<div class="phone-chips">${[["approved", "Approve"], ["skipped", "Skip"], ["stash", "Stash on A1"]].map(([status, label]) => `<button data-pick="${html(pick.id)}" data-status="${status}">${label}</button>`).join("")}</div>` : ""}</article>`;
  }
  function drawPicks(message = "") {
    const statuses = ["new", "approved", "stashed", "skipped", "all"].map(status => [status, `${status} (${status === "all" ? counts.total || 0 : counts.by_status?.[status] || 0})`]);
    const kinds = [["all", "All types"], ["model", "Models"], ["dataset", "Datasets"], ["space", "Spaces"], ["paper", "Papers"], ["collection", "Collections"], ["code", "Code"]];
    panel.innerHTML = `<h2>Picks</h2>${buttons(statuses, pickStatus, "data-pick-status", "Pick status")}${buttons(kinds, pickKind, "data-pick-kind", "Asset type")}<p role="status">${html(message)}</p><p class="sub">Approve or Stash queues the agent's next download. Only the Mac can confirm an item is stashed; gated assets still require a license.</p>${picks.map(pickCard).join("") || '<p class="card">No picks match these filters.</p>'}${more ? '<button data-more>Show more</button>' : ""}`;
    panel.querySelectorAll("[data-pick-status]").forEach(button => button.onclick = () => { pickStatus = button.dataset.pickStatus; open("picks"); });
    panel.querySelectorAll("[data-pick-kind]").forEach(button => button.onclick = () => { pickKind = button.dataset.pickKind; open("picks"); });
    panel.querySelector("[data-more]")?.addEventListener("click", async event => {
      const current = version; event.target.disabled = true;
      try { const rows = await fetchPicks(offset); if (current !== version) return; picks.push(...rows); offset += rows.length; more = rows.length === 20; drawPicks(); }
      catch (error) { if (current === version) drawPicks(error.message); }
    });
    panel.querySelectorAll("[data-pick]").forEach(button => button.onclick = async () => {
      const current = version; button.disabled = true;
      try {
        const stash = button.dataset.status === "stash";
        await post("/api/picks/status", { id: button.dataset.pick, status: stash ? "approved" : button.dataset.status });
        if (current !== version) return;
        await open("picks");
        if (active === "picks" && current + 1 === version) drawPicks(stash ? "Queued for the next Mac run; not downloaded yet." : "Pick updated.");
      } catch (error) { if (current === version) drawPicks(error.message); }
    });
  }
  const output = value => `<pre>${html(JSON.stringify(value, null, 2))}</pre>`;
  const field = (name, label, value = "") => `<label>${label}<input name="${name}" value="${html(value)}" required></label>`;
  function action(selector, work) {
    panel.querySelectorAll(selector).forEach(button => button.onclick = async () => {
      const current = version;
      button.disabled = true;
      const status = panel.querySelector("[data-feedback]");
      if (status) status.textContent = "Working…";
      try {
        const result = await work(button);
        if (current === version && status) status.textContent = typeof result === "string" ? result : JSON.stringify(result);
      } catch (error) { if (current === version && status) status.textContent = error.message; }
      finally { button.disabled = false; }
    });
  }
  function form(selector, work) {
    panel.querySelector(selector)?.addEventListener("submit", async event => {
      event.preventDefault();
      const current = version, target = event.target, button = target.querySelector('[type="submit"]');
      const status = target.querySelector('[role="status"]');
      button.disabled = true; status.textContent = "Working…";
      try {
        const result = await work(Object.fromEntries(new FormData(target)));
        if (current === version) status.textContent = typeof result === "string" ? result : JSON.stringify(result);
      } catch (error) { if (current === version) status.textContent = error.message; }
      finally { button.disabled = false; }
    });
  }
  let actor = "you", days = "30", app = "all", sessions = [], sessionMore = false;
  const group = session => actor === "agent" ? "Agent runs" : ["claude-desktop", "claude-cowork"].includes(session.app) ? "Claude Desktop" : session.source === "codex" ? "Codex" : "Claude Code";
  async function loadSessions(current) {
    const [overview, page] = await Promise.all([call("/api/sessions"), call(`/api/sessions/list?actor=${actor}&limit=60`)]);
    if (current !== version) return;
    sessions = page.sessions || []; sessionMore = sessions.length === 60;
    drawSessions(overview);
  }
  function drawSessions(overview) {
    const cutoff = Date.now() - Number(days) * 86400000;
    const visible = sessions.filter(session => (!Number(days) || Date.parse(session.first_event) >= cutoff) && (app === "all" || group(session) === app));
    panel.innerHTML = `<h2>Coding sessions</h2>${buttons([["you", "Your sessions"], ["agent", "Agent runs"]], actor, "data-actor", "Session actor")}${buttons([["7", "7 days"], ["30", "30 days"], ["0", "All time"]], days, "data-days", "Time frame")}${buttons(["all", "Claude Code", "Claude Desktop", "Codex", "Agent runs"].map(name => [name, name]), app, "data-app", "App")}<section class="card"><p>${html(overview.totals?.sessions || 0)} synced sessions overall. Showing ${visible.length} matching loaded sessions; load more for older history.</p><p>Collection ${overview.connect?.on ? "on" : "off"} · transcript storage ${overview.transcripts?.on ? "on" : overview.connect?.transcripts ? "on" : "off"}</p><button data-sync>Sync now</button> <button data-connect>${overview.connect?.on ? "Pause collection" : "Enable collection"}</button> <button data-transcripts>Change transcript storage</button><p data-feedback role="status"></p></section>${visible.map(session => `<article class="card"><h3>${html(group(session))}</h3><p>${html(session.model || session.app)} · ${html(session.host)}</p><p>${html(session.first_event)} · ${html(session.active_minutes || 0)} active min · ${html(session.turns || 0)} turns · ${html(session.edits || 0)} edits · ${html(session.errors || 0)} errors</p>${session.transcript_bytes ? `<a class="phone-link" href="/api/sessions/transcript?source=${encodeURIComponent(session.source)}&digest=${encodeURIComponent(session.digest)}" target="_blank" rel="noopener">Open stored transcript</a>` : ""}</article>`).join("") || '<p class="card">No matching sessions.</p>'}${sessionMore ? '<button data-session-more>Show more sessions</button>' : ""}<details class="card"><summary>Weekly alerts and sync status</summary>${output({ alerts: overview.alerts, hosts: overview.hosts, history: overview.history })}</details>`;
    for (const [attribute, set] of [["actor", value => { actor = value; app = "all"; }], ["days", value => { days = value; }], ["app", value => { app = value; }]]) panel.querySelectorAll(`[data-${attribute}]`).forEach(button => button.onclick = () => { set(button.dataset[attribute]); attribute === "actor" ? open("sessions") : drawSessions(overview); });
    action("[data-sync]", () => post("/api/sessions/sync-now", {}));
    action("[data-connect]", () => post("/api/sessions/connect", { on: !overview.connect?.on }).then(() => open("sessions")));
    action("[data-transcripts]", async () => {
      const enabled = !!overview.connect?.transcripts;
      if (!confirm(enabled ? "Stop uploading transcripts? Previously stored transcripts remain." : "Upload redacted transcripts from your Macs? These may contain sensitive conversation content. Continue?")) return "Unchanged.";
      await post("/api/sessions/transcripts", { on: !enabled }); await open("sessions");
    });
    action("[data-session-more]", async () => {
      const current = version, before = sessions.at(-1)?.first_event;
      const page = await call(`/api/sessions/list?actor=${actor}&limit=60&before=${encodeURIComponent(before)}`);
      if (current !== version) return;
      sessions.push(...(page.sessions || [])); sessionMore = page.sessions?.length === 60; drawSessions(overview);
    });
  }
  async function loadCatalog(current) {
    const catalog = await call("/api/catalog");
    if (current !== version) return;
    const items = (catalog.categories || []).flatMap(category => (category.items || []).map(item => ({ ...item, category: category.id })));
    panel.innerHTML = `<h2>Catalog</h2><label>Search local stash<input data-search type="search" placeholder="Name, category or path"></label><p>${items.length} local items</p><div data-catalog></div><form class="card" data-add><h3>Add a pick</h3>${field("repo", "Repository (owner/name)")}<label>Type<select name="kind"><option value="model">Model</option><option value="dataset">Dataset</option><option value="space">Space</option><option value="code">Code (GitHub)</option></select></label><button type="submit">Add pick</button><p role="status"></p></form>`;
    const draw = query => {
      panel.querySelector("[data-catalog]").innerHTML = items.filter(item => JSON.stringify(item).toLowerCase().includes(query.toLowerCase())).map(item => `<article class="card"><h3>${html(item.name)}</h3><p>${html(item.type || item.category)} · ${html(gb(item.bytes))}</p><p>${html(item.path)}</p></article>`).join("") || '<p class="card">No local items match.</p>';
    };
    draw(""); panel.querySelector("[data-search]").oninput = event => draw(event.target.value);
    form("[data-add]", data => post("/api/picks/add", data).then(() => "Pick added. Open Picks to review it."));
  }
  async function loadNotes(current) {
    const notes = await call("/api/notes");
    if (current !== version) return;
    panel.innerHTML = `<h2>Notes</h2><form class="card" data-note>${field("path", "Item path or note key")}${field("name", "Name")}<label>Answers (JSON object)<textarea name="answers">{}</textarea></label><button type="submit">Save note</button><p role="status"></p></form>${Object.values(notes).map((note, index) => `<article class="card"><h3>${html(note.name || note.path)}</h3><p>${html(note.path)}</p>${output(note.answers)}<button data-edit-note="${index}">Edit</button> <button data-delete-note="${index}">Delete</button></article>`).join("")}<p data-feedback role="status"></p>`;
    const rows = Object.values(notes), editor = panel.querySelector("[data-note]");
    let original = {};
    panel.querySelectorAll("[data-edit-note]").forEach(button => button.onclick = () => {
      original = rows[Number(button.dataset.editNote)];
      editor.elements.path.value = original.path; editor.elements.name.value = original.name || ""; editor.elements.answers.value = JSON.stringify(original.answers, null, 2); editor.scrollIntoView({ block: "start" });
    });
    form("[data-note]", async data => {
      const answers = JSON.parse(data.answers);
      if (!answers || Array.isArray(answers) || typeof answers !== "object") throw new Error("Answers must be a JSON object.");
      if (original.path && original.path !== data.path) throw new Error("Keep the original key when editing; reload Notes to create a new note.");
      await post("/api/notes", { ...original, ...data, answers }); await open("notes");
    });
    action("[data-delete-note]", async button => {
      if (!confirm("Delete this note?")) return "Unchanged.";
      await call(`/api/notes?path=${encodeURIComponent(rows[Number(button.dataset.deleteNote)].path)}`, { method: "DELETE" }); await open("notes");
    });
  }
  async function loadJobs(current) {
    const [activity, updates, leaderboard] = await Promise.all([call("/api/activity"), call("/api/updates"), call("/api/bench/leaderboard")]);
    if (current !== version) return;
    panel.innerHTML = `<h2>Jobs and activity</h2><section class="card"><h3>Blind bench battle</h3><label>Suite<select data-suite>${["gtm-debug", "sql-ga4", "html-json", "rag-notes", "asr", "screen", "gtm-gate", "skill-select", "stape-select"].map(suite => `<option>${suite}</option>`).join("")}</select></label><button data-battle>Find battle</button><p data-feedback role="status"></p><div data-battle-result></div></section><details class="card"><summary>Leaderboard</summary>${output(leaderboard)}</details><details class="card" open><summary>Activity and requests</summary>${output(activity)}</details><details class="card"><summary>Stash updates</summary>${output(updates)}</details>`;
    action("[data-battle]", async () => {
      const current = version, battle = await call(`/api/bench/battle?suite=${encodeURIComponent(panel.querySelector("[data-suite]").value)}`);
      if (current !== version) return;
      panel.querySelector("[data-battle-result]").innerHTML = `<p>${html(battle.task.prompt)}</p>${["a", "b"].map(side => `<h3>Answer ${side.toUpperCase()}</h3><pre>${html(battle[side].output)}</pre>`).join("")}<div class="phone-chips">${["a", "b", "tie"].map(vote => `<button data-vote="${vote}">${vote === "tie" ? "Tie" : `Prefer ${vote.toUpperCase()}`}</button>`).join("")}</div>`;
      action("[data-vote]", async button => {
        panel.querySelectorAll("[data-vote]").forEach(option => option.disabled = true);
        try {
          const result = await post("/api/bench/battle", { id: battle.id, vote: button.dataset.vote });
          if (current === version) panel.querySelector("[data-battle-result]").innerHTML = `<h3>Vote recorded</h3>${output(result)}`;
          return "Vote recorded.";
        } catch (error) { panel.querySelectorAll("[data-vote]").forEach(option => option.disabled = false); throw error; }
      });
      return "Choose the better answer without seeing model names.";
    });
  }
  async function loadMore(current) {
    const activity = await call("/api/activity");
    if (current !== version) return;
    panel.innerHTML = `<h2>Tools and learning</h2><section class="card"><h3>Discovery</h3><button data-scan>Scan now</button><p data-feedback role="status"></p></section><form class="card" data-license><h3>License access</h3>${field("repo", "Hugging Face repository (owner/name)")}<label>Type<select name="kind"><option value="model">Model</option><option value="dataset">Dataset</option><option value="space">Space</option></select></label><label>Action<select name="decision"><option value="check">Check access on Mac</option><option value="yes">Accept license on Mac</option><option value="no">Decline / skip</option></select></label><p>Read the repository's license first. Accepting submits your acknowledgement through the Mac's Hugging Face account.</p><button type="submit">Submit</button><p role="status"></p></form><details class="card"><summary>License status</summary>${output({ licenses: activity.licenses, check: activity.license_check, decisions: activity.license_decisions })}</details><section class="card"><h3>Large-screen workspaces</h3><p>The Lab's visual stack editor and Map's spatial treemap need a large screen. Use Catalog here for stash search, and the lessons below for learning.</p><a class="phone-link" href="/">Open full dashboard on desktop ↗</a></section><h2>Learning path</h2>${window.Lessons.chapters.map(chapter => `<details class="card"><summary>${html(chapter.title)}</summary><p>${html(chapter.blurb)}</p>${chapter.steps.map(id => {
      const lesson = window.Lessons.sections[id], step = window.MapView.steps.find(step => step.id === id);
      return `<section><h3>${html(step?.title || id)}</h3>${lesson.p.map(paragraph => `<p>${html(paragraph)}</p>`).join("")}<p><strong>${html(lesson.q.q)}</strong></p>${lesson.q.o.map((option, index) => `<button class="phone-answer" data-question="${id}" data-answer="${index}">${html(option)}</button>`).join("")}<p data-why="${id}" role="status"></p></section>`;
    }).join("")}</details>`).join("")}<h2>Concept reference</h2>${Object.values(window.CONCEPTS).map(concept => `<details class="card"><summary>${html(concept.title)}</summary><p>${html(concept.body)}</p></details>`).join("")}`;
    action("[data-scan]", () => post("/api/scan", {}));
    form("[data-license]", async data => {
      if (data.decision === "check") return post("/api/license-check", { repos: [data.repo] });
      if (!confirm(`${data.decision === "yes" ? "Accept the license for" : "Decline"} ${data.repo} on your Mac?`)) return "Unchanged.";
      return post("/api/license-decision", data);
    });
    panel.querySelectorAll("[data-question]").forEach(button => button.onclick = () => {
      const question = window.Lessons.sections[button.dataset.question].q;
      panel.querySelector(`[data-why="${button.dataset.question}"]`).textContent = `${Number(button.dataset.answer) === question.a ? "Correct." : "Try again."} ${question.why}`;
    });
  }
  window.PhoneView = { active, reload: () => active !== "home" && open(active) };
  document.getElementById("app").addEventListener("click", event => {
    const tile = event.target.closest("a.tile");
    if (!tile) return;
    event.preventDefault(); open(tile.textContent.includes("license") ? "more" : "picks");
  });
  navigation();
})();
