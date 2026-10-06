"""Build tests/bench/stape-select.jsonl: pick the right Stape template for a GTM job.

    python3 tests/bench/make_stape_select.py          (writes the bank, prints the keyword baseline)

Each task is a job plus a candidate list of Stape templates (name, description, container), one yes/no question per
candidate, scored with the jev-gateway selection rule like skill-select. The candidates come from an alias-aware
keyword shortlist of 10 (code, not a model). When that shortlist misses the right template it is swapped in for the
weakest candidate, and the miss is recorded as retrieval_hit=false: the bench measures the decision model, the
retrieval number is reported separately. The catalog is a pinned copy of stape-agent-toolset's templates.json.
"""
import json, re
from pathlib import Path

HERE = Path(__file__).resolve().parent
CATALOG = json.loads((HERE / "stape-catalog.json").read_text())
BY_NAME = {t["name"]: t for t in CATALOG}
K = 10

# The stape-agent-toolset findTemplates rule today: stop words dropped, one point per job word found, top 5.
STOP = {"a", "an", "and", "for", "in", "of", "on", "or", "send", "server", "server-side", "side", "the", "to", "with"}
# Words people say vs words in the catalog. Code-side recall fix, proposed for stape-agent-toolset.
ALIASES = {"meta": ["facebook", "fb"], "facebook": ["meta"], "capi": ["conversion", "conversions", "api"],
           "conversions": ["conversion", "capi"], "conversion": ["conversions", "capi"], "bing": ["microsoft"],
           "microsoft": ["uet"], "x": ["twitter"], "ga4": ["google", "analytics"], "sheet": ["spreadsheet", "sheets"],
           "sheets": ["spreadsheet"], "bots": ["bot", "botd", "crawler"], "bot": ["botd", "crawler"],
           "dedupe": ["duplicate"], "duplicates": ["duplicate"], "duplicate": ["transaction"], "phone": ["formatter"],
           "consent": ["parser", "listener"], "offline": ["crm"], "refunds": ["adjustments"], "refund": ["adjustments"],
           "audience": ["audiences", "custom"], "slack": ["notification"], "log": ["logger"], "debug": ["logger"],
           "itp": ["cookie", "extender"], "cookies": ["cookie"], "lifetime": ["extender"], "ad": ["ads"],
           "blockers": ["loader"], "js": ["loader"], "twice": ["duplicate"], "subdomain": ["loader", "proxy"], "hash": ["md5", "hash"]}


def words(s):
    return [w for w in re.split(r"[^a-z0-9]+", s.lower()) if len(w) > 1 and w not in STOP]


def stem(w):
    return w[:-1] if len(w) > 3 and w.endswith("s") and not w.endswith("ss") else w


def text(t):
    return f"{t['name']} {t['job']} {' '.join(t['keywords'])} {t['category']}"


def keyword_top(job, k=5, aliases=False):
    """aliases=False is today's findTemplates. aliases=True is the proposed shortlist: aliases added, and each word
    weighted by how rare it is in the catalog (IDF), so "hubspot" outweighs "container"; plurals match singulars."""
    q = words(job)
    if not aliases:
        out = []
        for t in CATALOG:
            tw = set(words(text(t)))
            s = sum(1 for w in q if w in tw)
            if s:
                out.append((s, t["name"]))
        out.sort(key=lambda x: (-x[0], x[1]))
        return out[:k]
    terms = {stem(w): 1.0 for w in q}
    for w in q:
        for a in ALIASES.get(w, []) + ALIASES.get(stem(w), []):
            terms.setdefault(stem(a), 1.0)
    out = []
    for t in CATALOG:
        tw = {stem(w) for w in words(text(t))}
        s = sum(wt * IDF.get(w, 0) for w, wt in terms.items() if w in tw)
        if s:
            out.append((round(s, 4), t["name"]))
    out.sort(key=lambda x: (-x[0], x[1]))
    return out[:k]


def _idf():
    import math
    df = {}
    for t in CATALOG:
        for w in {stem(x) for x in words(text(t))}:
            df[w] = df.get(w, 0) + 1
    return {w: math.log(len(CATALOG) / n) for w, n in df.items()}


IDF = _idf()


def container(t):
    j = t["job"].lower()
    if t["category"] in ("web-tag",) or "web container" in j or " web" in j:
        return "web container"
    if t["category"] in ("tag", "variable", "client"):
        return "server container"
    return t["category"]


def question(t):
    return {"type": "noul", "instructions": f"Is the Stape template \"{t['name']}\" the right one for this job? "
                                            f"The template: {t['job'].strip()} ({t['category']}, {container(t)})."}


JOBS = [
    ("stape-meta-capi", "Send purchase events from our server container to the Meta Conversions API.", "facebook-tag"),
    ("stape-meta-offline", "Upload offline sales from our CRM to Meta so in-store purchases count as conversions.", "facebook-offline-conversion-tag"),
    ("stape-meta-leads", "Send qualified-lead status back to Meta so Lead Ads optimize for good leads (Facebook Leads API).", "facebook-leads-tag"),
    ("stape-meta-audience", "Add customers who purchased to a Meta custom audience from the server container.", "meta-custom-audiences-tag"),
    ("stape-tiktok-capi", "Forward purchase and add-to-cart events to the TikTok Events API server-side.", "tiktok-tag"),
    ("stape-tiktok-pixel", "Install the TikTok pixel in our GTM web container.", "tiktok-web-tag"),
    ("stape-hubspot", "Send new leads from the server container into HubSpot.", "hubspot-tag"),
    ("stape-firestore-write", "Store first-party user IDs and click IDs in Firestore when a user signs up.", "firestore-writer-tag"),
    ("stape-firestore-read", "On later events, read the user's stored data back from Firestore to enrich the request.", "firestore-restore-variable"),
    ("stape-bots", "Block bot traffic before any tags fire.", "botd-gtm"),
    ("stape-linkedin", "Send form-submit conversions to the LinkedIn Conversions API.", "linkedin-tag"),
    ("stape-gads-refunds", "Retract or adjust Google Ads conversions after orders are refunded.", "gads-conversion-adjustments-tag"),
    ("stape-gads-offline", "Upload closed deals from our CRM to Google Ads as offline conversions.", "gads-offline-conversion-tag"),
    ("stape-dedupe", "Stop the same purchase from being counted twice when the thank-you page reloads.", "duplicate-transaction-checker-variable"),
    ("stape-phone", "Normalize customer phone numbers to E.164 in the server container before sending them to ad platforms.", "phone-number-formatter-variable"),
    ("stape-md5", "A partner wants customer emails hashed with MD5 before we send them.", "md5-hash-variable"),
    ("stape-consent", "Read the Google Consent Mode state inside the server container to decide which tags may fire.", "consent-parser-variable"),
    ("stape-slack", "Post a message to our Slack channel whenever an order over $1,000 comes in.", "slack-notification-tag"),
    ("stape-logger", "Log incoming requests and event data so I can debug the server container.", "logger-tag"),
    ("stape-pinterest", "Send checkout events to the Pinterest Conversions API.", "pinterest-capi-tag"),
    ("stape-shopify", "Set up server-side tracking on a Shopify store starting from a ready-made container.", "shopify-gtm-container-templates"),
    ("stape-itp", "Safari ITP keeps cutting our first-party cookies to 7 days; extend their lifetime from the server.", "cookie-extender-tag"),
    ("stape-sheets", "Append every lead event as a row in a Google Sheet.", "spreadsheet-tag"),
    ("stape-reddit", "Send signup conversions to Reddit server-side.", "reddit-tag"),
    ("stape-loader", "Serve gtm.js from our own subdomain so ad blockers don't block GTM.", "gtm-loader"),
    ("stape-bing", "Send conversions to Microsoft Advertising (Bing) through its conversion API.", "microsoft-capi-tag"),
    ("stape-none-quantcast", "Send purchase conversions to Quantcast server-side.", None),
    ("stape-none-looker", "Build a Looker Studio dashboard of ROAS by channel.", None),
    ("stape-none-segment", "Forward all our events to Segment.", None),
]


def build():
    tasks, base, recall5, recall10 = [], [], 0, 0
    for tid, job, gold in JOBS:
        assert gold is None or gold in BY_NAME, gold
        cands = [n for _, n in keyword_top(job, K, aliases=True)]
        hit = gold is None or gold in cands
        recall10 += hit
        recall5 += gold is None or gold in [n for _, n in keyword_top(job, 5)]
        if not hit:
            cands = (cands[:K - 1] if len(cands) >= K else cands) + [gold]
        cands = sorted(cands)  # no position hint
        state = f"GTM job from the user: {job}"
        tasks.append({"id": tid, "type": "decision", "prompt": state, "state": state,
                      "questions": {n: question(BY_NAME[n]) for n in cands},
                      "gold": {n: n == gold for n in cands}, "select_gold": gold, "retrieval_hit": hit})
        # Today's keyword picker as a "model": its top hit if alone at the top, else its tied top three.
        top = keyword_top(job, 5)
        if not top:
            kind, pick = "none", []
        elif len(top) == 1 or top[0][0] > top[1][0]:
            kind, pick = "selected", top[0][1]
        else:
            kind, pick = "top3", [n for s, n in top if s == top[0][0]][:3]
        base.append(1.0 if (gold is None and kind == "none") or (kind == "selected" and pick == gold)
                    else 0.5 if kind == "top3" and gold in pick else 0.0)
    (HERE / "stape-select.jsonl").write_text("".join(json.dumps(t) + "\n" for t in tasks))
    n = len(JOBS)
    print(f"{n} tasks; keyword top-5 recall {recall5}/{n}; alias top-{K} recall {recall10}/{n}; "
          f"keyword picker score {sum(base) / n:.3f}, passes {sum(1 for b in base if b == 1.0)}/{n}")


if __name__ == "__main__":
    build()
