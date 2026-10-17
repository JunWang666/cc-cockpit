# cc-cockpit

Claude Code mods for a terminal cockpit: a stats band above the prompt and quick navigation through your own messages. Needs Claude Code 2.1.287 or newer.

| Mod | What it does |
|---|---|
| **quota-band** | A divider between the transcript and the prompt, and one row under it: turn number, output speed (tok/s), turn and session cost, prompt-cache countdown, 5-hour and weekly quota with reset times, and context usage. |
| **welcome** | When a new session starts, a card above the prompt shows the project's branch, uncommitted changes, ahead/behind, the last three commits, a one-line gist of README.md / AGENTS.md / CLAUDE.md (press one to read its opening lines), what the last session did (its recap and the files it edited) and the project's five most recent sessions; press a digit in the empty prompt to resume one. It hides on your first message; `/welcome` brings it back. |
| **prompt-jump** | `/prompts` lists the messages you sent in this session; press a number to scroll the transcript to one. `0` or `/bottom` jumps back to the end. Scrolling needs the fullscreen layout (`/tui fullscreen`). |

## Install

```
/plugin install quota-band --marketplace JunWang666/cc-cockpit
/plugin install prompt-jump --marketplace JunWang666/cc-cockpit
/plugin install welcome --marketplace JunWang666/cc-cockpit
```

## Develop

Each mod is in `mods/<name>/`. Check one with `claude plugin validate mods/<name>` and `claude plugin test mods/<name>`, then `/reload-plugins` in a session.
