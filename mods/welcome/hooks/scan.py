#!/usr/bin/env python3
"""Startup facts for one project as JSON: git state and the project's recent Claude sessions.

Usage: scan.py <cwd> <current-session-id> [sessions]
"""
import glob, json, os, re, subprocess, sys, time

cwd = sys.argv[1]
current = sys.argv[2] if len(sys.argv) > 2 else ""
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 5


def git(*args):
    try:
        out = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=5)
        return out.stdout.strip() if out.returncode == 0 else None
    except Exception:
        return None


def git_state():
    if git("rev-parse", "--is-inside-work-tree") != "true":
        return None
    branch = git("branch", "--show-current") or git("rev-parse", "--short", "HEAD") or "?"
    status = git("status", "--porcelain") or ""
    ahead = behind = None
    counts = git("rev-list", "--left-right", "--count", "@{upstream}...HEAD")
    if counts:
        behind, ahead = (int(n) for n in counts.split())
    log = git("log", "-3", "--format=%h%x09%ct%x09%s") or ""
    commits = []
    for line in log.splitlines():
        h, ct, s = (line.split("\t", 2) + ["", ""])[:3]
        commits.append({"hash": h, "time": int(ct) * 1000 if ct.isdigit() else 0, "subject": s})
    return {"branch": branch, "changes": len([l for l in status.splitlines() if l.strip()]),
            "ahead": ahead, "behind": behind, "commits": commits}


def prompt_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                return b.get("text", "")
    return ""


def sessions():
    folder = os.path.join(os.path.expanduser("~/.claude/projects"), re.sub(r"[^A-Za-z0-9]", "-", cwd))
    files = sorted(glob.glob(os.path.join(folder, "*.jsonl")), key=os.path.getmtime, reverse=True)
    out = []
    for path in files:
        sid = os.path.basename(path)[:-6]
        if sid == current:
            continue
        first, count = "", 0
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                for line in f:
                    if '"type":"user"' not in line:
                        continue
                    try:
                        e = json.loads(line)
                    except ValueError:
                        continue
                    if e.get("type") != "user" or e.get("isSidechain") or e.get("isMeta"):
                        continue
                    if e.get("toolUseResult") is not None:
                        continue
                    text = prompt_text((e.get("message") or {}).get("content")).strip()
                    if not text or text.startswith("<"):
                        continue
                    count += 1
                    first = first or " ".join(text.split())
        except OSError:
            continue
        if first:
            out.append({"id": sid, "prompt": first[:200], "prompts": count, "time": os.path.getmtime(path) * 1000})
        if len(out) >= limit:
            break
    return out


print(json.dumps({"git": git_state(), "sessions": sessions(), "scannedAt": time.time() * 1000}, ensure_ascii=False))
