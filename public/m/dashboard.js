(() => {
  const panel = document.getElementById("phone-panel");
  const nav = document.getElementById("phone-nav");
  const tabs = { home: "A1", picks: "Picks" };
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
        await open("picks"); drawPicks(stash ? "Queued for the next Mac run; not downloaded yet." : "Pick updated.");
      } catch (error) { if (current === version) drawPicks(error.message); }
    });
  }
  window.PhoneView = { active, reload: () => active !== "home" && open(active) };
  navigation();
})();
