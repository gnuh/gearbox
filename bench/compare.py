"""Compares Claude Code sessions from their transcripts: time, prompts, requests, tokens and cost per model.

Reads ~/.claude/projects/<project>/<session>.jsonl and its subagents/*.jsonl, so it measures any session, with
gearbox on, off or not installed. Each argument is LABEL=WHAT, where WHAT is a session id, a .jsonl path, or
@<checkout path> for the latest session started in that checkout.

    python3 -I bench/compare.py A1=@../wt-plain B1=@../wt-gearbox
    python3 -I bench/compare.py --self-test
"""
import collections
import glob
import json
import os
import sys
import tempfile
from datetime import datetime

PROJECTS = os.path.expanduser("~/.claude/projects")
# US$ per million tokens: fresh input, cache write, cache read, output.
# shortcut: Anthropic list prices as of 2026-10; Haiku's long-prompt rate ignored. Update when prices move.
PRICES = {
    "haiku": (0.1, 0.125, 0.01, 0.5),
    "sonnet": (2, 2.5, 0.2, 10),
    "opus": (4, 5, 0.2, 20),
    "fable": (10, 12.5, 0.25, 50),
}


def family(model):
    return next((f for f in PRICES if f in (model or "")), "other")


def transcript_for(what):
    """A session's main transcript path from a session id, a .jsonl path or @<checkout path>."""
    if what.endswith(".jsonl"):
        return what
    if what.startswith("@"):
        project = os.path.abspath(what[1:]).replace("/", "-").replace(".", "-")
        found = sorted(glob.glob(os.path.join(PROJECTS, project, "*.jsonl")), key=os.path.getmtime)
        if not found:
            sys.exit(f"no sessions under {os.path.join(PROJECTS, project)}")
        return found[-1]
    found = glob.glob(os.path.join(PROJECTS, "*", f"{what}.jsonl"))
    if not found:
        sys.exit(f"no transcript for session {what}")
    return found[0]


def entries(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def measure(main_path):
    """Totals for one session, its subagents included."""
    sub_paths = sorted(glob.glob(os.path.join(main_path[: -len(".jsonl")], "subagents", "*.jsonl")))
    seen = set()  # a response is written once per content block; count its usage once
    per_model = collections.defaultdict(lambda: [0, 0, 0, 0, 0])  # requests, fresh, write, read, out
    stamps, prompts, gearbox_notes = [], 0, 0
    for path, is_sub in [(main_path, False)] + [(p, True) for p in sub_paths]:
        for d in entries(path):
            if d.get("timestamp"):
                stamps.append(d["timestamp"])
            msg = d.get("message") if isinstance(d.get("message"), dict) else {}
            typed = isinstance(msg.get("content"), str) and not msg["content"].lstrip().startswith("<")  # not a command row or a notice
            if not is_sub and d.get("type") == "user" and typed and not d.get("isMeta"):
                prompts += 1
                gearbox_notes += "gearbox route" in json.dumps(d) or "gearbox handoff" in json.dumps(d)
            if d.get("type") != "assistant" or not msg.get("usage"):
                continue
            key = msg.get("id") or d.get("uuid")
            if key in seen:
                continue
            seen.add(key)
            u, row = msg["usage"], per_model[family(msg.get("model"))]
            row[0] += 1
            row[1] += u.get("input_tokens", 0)
            row[2] += u.get("cache_creation_input_tokens", 0)
            row[3] += u.get("cache_read_input_tokens", 0)
            row[4] += u.get("output_tokens", 0)
    times = sorted(datetime.fromisoformat(s.replace("Z", "+00:00")) for s in stamps)
    wall = (times[-1] - times[0]).total_seconds() if len(times) > 1 else 0
    cost = sum(
        (r[1] * p[0] + r[2] * p[1] + r[3] * p[2] + r[4] * p[3]) / 1e6
        for m, r in per_model.items()
        for p in [PRICES.get(m, PRICES["opus"])]
    )
    return {"wall": wall, "prompts": prompts, "subagents": len(sub_paths), "per_model": dict(per_model), "cost": cost, "gearbox": gearbox_notes}


def kilo(n):
    return f"{n / 1e6:.1f}M" if n >= 1e6 else f"{n / 1e3:.1f}k" if n >= 1e3 else str(n)


def report(rows):
    print("| run | wall | prompts | subagents | requests by model | input (fresh/write/read) | output | ≈ cost |")
    print("|---|---|---|---|---|---|---|---|")
    for label, m in rows:
        pm = m["per_model"]
        reqs = ", ".join(f"{f} {r[0]}" for f, r in sorted(pm.items(), key=lambda kv: -kv[1][0]))
        fresh, write, read, out = (sum(r[i] for r in pm.values()) for i in (1, 2, 3, 4))
        print(
            f"| {label} | {m['wall'] / 60:.1f} min | {m['prompts']} | {m['subagents']} | {reqs} | "
            f"{kilo(fresh)} / {kilo(write)} / {kilo(read)} | {kilo(out)} | ${m['cost']:.2f} |"
        )
    print("\nCost at API list prices; on a subscription it shows as usage-limit headroom instead.")


def self_test():
    with tempfile.TemporaryDirectory() as tmp:
        main = os.path.join(tmp, "s.jsonl")
        os.makedirs(os.path.join(tmp, "s", "subagents"))
        usage = {"input_tokens": 10, "cache_creation_input_tokens": 1000, "cache_read_input_tokens": 0, "output_tokens": 100}
        rows = [
            {"type": "user", "timestamp": "2026-10-27T10:00:00Z", "message": {"role": "user", "content": "fix it"}},
            # the same response written twice (two content blocks): counted once
            {"type": "assistant", "timestamp": "2026-10-27T10:00:30Z", "message": {"id": "m1", "model": "claude-opus-5-5", "usage": usage}},
            {"type": "assistant", "timestamp": "2026-10-27T10:00:31Z", "message": {"id": "m1", "model": "claude-opus-5-5", "usage": usage}},
            {"type": "user", "timestamp": "2026-10-27T10:01:00Z", "message": {"role": "user", "content": [{"type": "tool_result"}]}},
        ]
        with open(main, "w") as f:
            f.write("\n".join(json.dumps(r) for r in rows))
        with open(os.path.join(tmp, "s", "subagents", "agent-a.jsonl"), "w") as f:
            f.write(json.dumps({"type": "assistant", "timestamp": "2026-10-27T10:02:00Z", "message": {"id": "m2", "model": "claude-haiku-5-5", "usage": usage}}))
        m = measure(main)
        assert m["prompts"] == 1, m
        assert m["subagents"] == 1, m
        assert m["per_model"]["opus"] == [1, 10, 1000, 0, 100], m
        assert m["per_model"]["haiku"][0] == 1, m
        assert m["wall"] == 120, m
        expected = (10 * 4 + 1000 * 5 + 100 * 20) / 1e6 + (10 * 0.1 + 1000 * 0.125 + 100 * 0.5) / 1e6
        assert abs(m["cost"] - expected) < 1e-9, (m["cost"], expected)
    print("self-test passed")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args == ["--self-test"]:
        self_test()
        sys.exit(0)
    if not args or any("=" not in a for a in args):
        sys.exit(__doc__)
    report([(label, measure(transcript_for(what))) for label, what in (a.split("=", 1) for a in args)])
