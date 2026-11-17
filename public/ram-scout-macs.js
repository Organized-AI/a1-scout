// Macs from RAM Scout: the exact chip + memory combinations watched in RAM Scout's "Interests / watched
// combinations". RAM Scout's "Test in A1 Scout" link carries them after the # (#ram-scout-macs=<base64url JSON>,
// schema ram-scout-a1-macs/v1), which the browser never sends to the Worker; a downloaded JSON file works too.
// They are kept in this browser only and join the Macs used for fit chips (map.js), the Lab (lab.js) and
// bench labels (bench.js). Bandwidth is Apple's published figure when RAM Scout has one; otherwise the Lab
// checks fit and memory but gives no speed estimate. Load before map.js.
(() => {
  const KEY = "a1-ram-scout-macs", HASH = "#ram-scout-macs=", MAX = 50;
  const APPLE = /^https:\/\/(support|www)\.apple\.com\//;
  const CONDITIONS = ["new", "refurbished", "used", "parts"];
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = (x, lo, hi) => (typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi ? x : null);
  const str = (x, max) => (typeof x === "string" && x.length <= max ? x : null);

  // Rebuild every field from the payload; nothing is passed through as-is.
  function clean(p) {
    if (!p || p.schema !== "ram-scout-a1-macs/v1" || !Array.isArray(p.macs)) throw new Error("not a RAM Scout Macs list (ram-scout-a1-macs/v1)");
    if (p.macs.length > MAX) throw new Error(`more than ${MAX} Macs`);
    const macs = [], seen = new Set();
    for (const m of p.macs) {
      const id = str(m?.id, 40), chip = str(m?.chip, 12), gb = Number.isInteger(m?.gb) ? num(m.gb, 8, 1024) : null;
      if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id) || !chip || !/^M\d{1,2}( (Pro|Max|Ultra))?$/.test(chip) || !gb || seen.has(id)) continue;
      seen.add(id);
      const src = str(m.bandwidth_source, 200), bw = src && APPLE.test(src) ? num(m.bandwidth_gbs, 1, 5000) : null;
      const lo = m.lowest_observed && typeof m.lowest_observed === "object" ? m.lowest_observed : null;
      macs.push({
        id, chip, gb, label: `${chip} ${gb}GB`,
        bandwidth_gbs: bw, bandwidth_source: bw ? src : null,
        variants: (Array.isArray(m.variants) ? m.variants : []).slice(0, 20).map(v => ({
          storage_gb: Number.isInteger(v?.storage_gb) ? num(v.storage_gb, 1, 262144) : null,
          condition_class: CONDITIONS.includes(v?.condition_class) ? v.condition_class : null })),
        lowest_observed: lo && num(lo.price, 0, 1e7) != null ? {
          price: lo.price, price_basis: str(lo.price_basis, 40), observed_at: str(lo.observed_at, 40),
          item_url: /^https:\/\//.test(lo.item_url || "") ? str(lo.item_url, 500) : null } : null,
      });
    }
    return { generated_at: str(p.generated_at, 40), macs };
  }
  function decode(b64) {
    if (b64.length > 200000 || !/^[A-Za-z0-9_-]+$/.test(b64)) throw new Error("link is damaged or too long");
    const s = b64.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(s + "=".repeat((4 - s.length % 4) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
  }

  let saved = null, notice = null;
  try { const v = JSON.parse(localStorage.getItem(KEY)); if (v && Array.isArray(v.macs)) saved = { ...v, ...clean({ ...v, schema: "ram-scout-a1-macs/v1" }) }; } catch {}
  const persist = () => { try { saved ? localStorage.setItem(KEY, JSON.stringify(saved)) : localStorage.removeItem(KEY); } catch {} };

  // A RAM Scout list replaces the previous one: it is the whole watched set, not an addition.
  function accept(payload, via) {
    const c = clean(payload);
    saved = { received_at: new Date().toISOString(), via, ...c };
    persist();
    const n = c.macs.length;
    notice = { ok: true, text: n ? `Added ${n} Mac${n === 1 ? "" : "s"} from RAM Scout: ${c.macs.map(m => m.label).join(", ")}.` : "RAM Scout sent no Apple silicon Macs; the list is now empty." };
    return n;
  }
  if (typeof location !== "undefined" && location.hash.startsWith(HASH)) {
    try { accept(decode(location.hash.slice(HASH.length)), "link"); }
    catch (e) { notice = { ok: false, text: "RAM Scout link not applied: " + e.message + "." }; }
    try { history.replaceState(null, "", location.pathname + location.search); } catch {}
  }

  const list = () => (saved ? saved.macs : []);
  const byId = id => list().find(m => m.id === id) || null;
  window.RamScoutMacs = {
    list,
    // Macs to add to a base list: anything already there (same A1 Bench id) is not repeated.
    extra: base => list().filter(m => !base.some(b => b.id === m.id)).map(m => ({ id: m.id, label: m.label, gb: m.gb, from: "ram-scout" })),
    label: id => byId(id)?.label || null,
    bandwidth: id => { const m = byId(id); return m && m.bandwidth_gbs ? { gbs: m.bandwidth_gbs, note: "Apple spec", source: m.bandwidth_source } : null; },
    accept: p => accept(p, "file"),
    async importFile(f) {
      try { if (!f) return 0; if (f.size > 500000) throw new Error("file too large"); return accept(JSON.parse(await f.text()), "file"); }
      catch (e) { notice = { ok: false, text: "RAM Scout file not applied: " + e.message + "." }; return -1; }
    },
    clear() { saved = null; persist(); notice = { ok: true, text: "Removed the Macs from RAM Scout." }; },
    notice: () => notice,
    // Short block for the Lab's Mac picker: what came from RAM Scout, and how to replace or remove it.
    noteHtml() {
      const ms = list(), n = notice ? `<p class="rsm-n${notice.ok ? "" : " bad"}" role="status">${esc(notice.text)}</p>` : "";
      const when = saved?.received_at ? new Date(saved.received_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
      return `<div class="rsm">${n}<p>${ms.length ? `From RAM Scout${when ? ` (${esc(when)})` : ""}: ${ms.map(m => `${esc(m.label)}${m.bandwidth_gbs ? "" : " <em>no speed estimate</em>"}${m.lowest_observed ? ` <em>seen at $${Number(m.lowest_observed.price).toLocaleString("en-US")}</em>` : ""}`).join(" · ")}.`
        : "Test a Mac you're watching: use “Test in A1 Scout” in RAM Scout's watched combinations, or import its JSON."}</p>
        <div class="rsm-a"><label class="lab-btn">Import RAM Scout JSON<input type="file" accept="application/json,.json" data-rsm-file hidden></label>${ms.length ? '<button type="button" class="lab-btn" data-rsm-clear>Remove RAM Scout Macs</button>' : ""}</div></div>`;
    },
  };

  const css = document.createElement("style");
  css.textContent = `.rsm{margin-top:8px;font-size:12.5px;color:var(--mute)}.rsm p{margin:0 0 6px}.rsm em{font-style:normal;font:11px "IBM Plex Mono",monospace;color:var(--mute)}
  .rsm-n{color:var(--ink)}.rsm-n.bad{color:var(--bad)}.rsm-a{display:flex;gap:6px;flex-wrap:wrap}.rsm-a .lab-btn{cursor:pointer}
  .rsm-toast{position:fixed;left:16px;bottom:16px;z-index:70;max-width:min(420px,calc(100vw - 32px));background:var(--panel);color:var(--ink);border:1px solid var(--brand);border-radius:12px;padding:10px 12px;font:13px/1.45 "IBM Plex Sans",sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.3)}
  .rsm-toast.bad{border-color:var(--bad)}.rsm-toast button{all:unset;cursor:pointer;float:right;margin-left:10px;color:var(--mute)}`;
  document.head.appendChild(css);
  // Say what happened to a RAM Scout link, once, wherever the page opens.
  if (notice && typeof addEventListener === "function") addEventListener("DOMContentLoaded", () => {
    const t = document.createElement("div");
    t.className = "rsm-toast" + (notice.ok ? "" : " bad"); t.setAttribute("role", "status");
    t.innerHTML = `<button type="button" aria-label="Dismiss">✕</button>${esc(notice.text)}${notice.ok && list().length ? " Bench compares them with your Macs on every workflow; they also show in model fit chips and in Simulate." : ""}`;
    t.querySelector("button").onclick = () => t.remove();
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 12000);
  });
})();
