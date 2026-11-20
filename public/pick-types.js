// Picks by type: the type chips (models, datasets, Spaces, code, collections, papers) that sit under the
// status chips on the Scout tab, plus the "sort by score / type" switch. Type order follows what matters most
// for the A1: models, datasets and Spaces first. The choice is kept in this browser and can be opened directly
// with ?view=scout&type=dataset (or &sort=type). Pure functions here; index.html draws and wires them.
(() => {
  const TYPES = ["model", "dataset", "space", "code", "collection", "paper"];
  const LABEL = { model: "models", dataset: "datasets", space: "Spaces", code: "code", collection: "collections", paper: "papers" };
  const SORTS = ["score", "type"];
  const KEY = "a1-scout-pick-view";
  const rank = k => { const i = TYPES.indexOf(k); return i < 0 ? TYPES.length : i; };
  const okType = t => t === "all" || TYPES.includes(t);

  // Saved choice, overridden by ?type= / ?sort= when present.
  function load(search = "") {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch {}
    let q = null; try { q = new URLSearchParams(search); } catch {}
    const type = q?.get("type") ?? saved.type, sort = q?.get("sort") ?? saved.sort;
    return { type: okType(type) ? type : "all", sort: SORTS.includes(sort) ? sort : "score" };
  }
  function save(v) { try { localStorage.setItem(KEY, JSON.stringify({ type: v.type, sort: v.sort })); } catch {} }

  const byStatus = (picks, status) => picks.filter(p => status === "all" || p.status === status);
  const byType = (picks, type) => picks.filter(p => type === "all" || p.kind === type);

  // How many picks of each type are in the current status, in type order. Unknown kinds count under "other".
  function typeCounts(picks, status) {
    const n = {};
    for (const p of byStatus(picks, status)) { const k = TYPES.includes(p.kind) ? p.kind : "other"; n[k] = (n[k] || 0) + 1; }
    return n;
  }
  // Status counts for one type (the server's counts cover every type, so use those when type is "all").
  function statusCounts(picks, type) {
    const n = {};
    for (const p of byType(picks, type)) n[p.status] = (n[p.status] || 0) + 1;
    return n;
  }
  // The rows to show. Score order keeps the server's order (status group, then score); type order groups by
  // type, best score first within each group, and returns the groups so the page can head each one.
  function view(picks, { status = "new", type = "all", sort = "score" } = {}) {
    const rows = byType(byStatus(picks, status), type);
    if (sort !== "type" || type !== "all") return { rows, groups: null };
    const sorted = rows.map((p, i) => [p, i]).sort((a, b) => rank(a[0].kind) - rank(b[0].kind) || (b[0].score ?? 0) - (a[0].score ?? 0) || a[1] - b[1]).map(x => x[0]);
    const groups = [];
    for (const p of sorted) {
      const k = TYPES.includes(p.kind) ? p.kind : "other";
      if (!groups.length || groups[groups.length - 1].kind !== k) groups.push({ kind: k, label: LABEL[k] || "other", rows: [] });
      groups[groups.length - 1].rows.push(p);
    }
    return { rows: sorted, groups };
  }
  // Chips to draw: "all types" first, then each type that has picks in this status (the selected one always shows).
  function chips(picks, status, selected) {
    const n = typeCounts(picks, status), total = byStatus(picks, status).length;
    const out = [{ type: "all", label: "all types", n: total }];
    for (const t of TYPES) if (n[t] || t === selected) out.push({ type: t, label: LABEL[t], n: n[t] || 0 });
    return out;
  }

  window.PickTypes = { TYPES, LABEL, SORTS, load, save, view, chips, typeCounts, statusCounts };
})();
