"""Speed Lab's offline queue uses the existing Bench retry contract."""
import bench


def speed_api(api):
    """Adapt Bench's posting path without mixing speed and quality queue rows."""
    def call(path, method="GET", body=None):
        if path != "/api/bench/runs":
            raise ValueError("unexpected Bench queue path")
        return api("/api/bench/speed", method, body)
    return call


def publish_rows(rows, A):
    """Flush earlier rows, then post these already-persisted local measurements."""
    queue = A.STATE_DIR / "bench" / "pending-speed.jsonl"
    api = speed_api(A.api)
    flushed = bench.flush_queue(api, queue)
    posted = sum(bench.post_or_queue(row, api, queue, A.log) for row in rows)
    return {"flushed": flushed, "posted": posted, "attempted": len(rows)}
