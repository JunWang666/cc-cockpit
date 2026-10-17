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


DOCS = ["README.md", "AGENTS.md", "CLAUDE.md"]
PREVIEW_LINES = 12


def docs():
    """The project's README / AGENTS.md / CLAUDE.md: a title, a one-line gist and the opening lines."""
    names = {n.lower(): n for n in os.listdir(cwd)} if os.path.isdir(cwd) else {}
    out = []
    for want in DOCS:
        name = names.get(want.lower())
        if name is None and want == "CLAUDE.md" and os.path.isfile(os.path.join(cwd, ".claude", "CLAUDE.md")):
            name = ".claude/CLAUDE.md"
        if name is None:
            continue
        try:
            with open(os.path.join(cwd, name), encoding="utf-8", errors="replace") as f:
                text = f.read(200_000)
        except OSError:
            continue
        lines = text.splitlines()
        title, gist, preview = "", "", []
        for raw in lines:
            line = raw.strip()
            # badges, html, image-only and rule lines say nothing in a terminal
            if not line or line.startswith(("<", "![", "[![", "---", "===")):
                continue
            if len(preview) < PREVIEW_LINES:
                preview.append(raw.rstrip())
            if not title and line.startswith("#"):
                title = line.lstrip("#").strip()
            elif not gist and not line.startswith(("#", "|", "```", ">")):
                gist = re.sub(r"[*_`]", "", line)
            if title and gist and len(preview) >= PREVIEW_LINES:
                break
        out.append({"name": name, "title": title, "gist": gist[:300], "lines": len(lines), "preview": preview})
    return out


def sessions():
    folder = os.path.join(os.path.expanduser("~/.claude/projects"), re.sub(r"[^A-Za-z0-9]", "-", cwd))
    files = sorted(glob.glob(os.path.join(folder, "*.jsonl")), key=os.path.getmtime, reverse=True)
    out = []
    for path in files:
        sid = os.path.basename(path)[:-6]
        if sid == current:
            continue
        first, count, recap, edited = "", 0, "", []
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                for line in f:
                    is_recap = '"away_summary"' in line
                    is_edit = '"tool_use"' in line and not out
                    if '"type":"user"' not in line and not is_recap and not is_edit:
                        continue
                    try:
                        e = json.loads(line)
                    except ValueError:
                        continue
                    if is_recap and e.get("subtype") == "away_summary":
                        recap = str(e.get("content", ""))
                        continue
                    if is_edit and e.get("type") == "assistant" and not e.get("isSidechain"):
                        for b in (e.get("message") or {}).get("content") or []:
                            if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") in ("Edit", "Write", "NotebookEdit"):
                                fp = (b.get("input") or {}).get("file_path") or (b.get("input") or {}).get("notebook_path")
                                if fp:
                                    rel = os.path.relpath(fp, cwd) if fp.startswith(cwd + os.sep) else fp
                                    if rel not in edited:
                                        edited.append(rel)
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
            row = {"id": sid, "prompt": first[:200], "prompts": count, "time": os.path.getmtime(path) * 1000}
            if not out:
                # the latest session also says what it did: its last recap and the files it edited
                row["recap"] = re.sub(r"\s*\(disable recaps in /config\)\s*$", "", recap).strip()[:600]
                row["edited"] = edited
            out.append(row)
        if len(out) >= limit:
            break
    return out


print(json.dumps({"git": git_state(), "docs": docs(), "sessions": sessions(), "scannedAt": time.time() * 1000}, ensure_ascii=False))
