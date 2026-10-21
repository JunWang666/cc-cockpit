# cc-cockpit

Claude Code mods for a terminal cockpit: a stats band above the prompt and quick navigation through your own messages. Needs Claude Code 2.1.287 or newer.

| Mod | What it does |
|---|---|
| **quota-band** | A divider between the transcript and the prompt, and one row under it: turn number, output speed (tok/s), turn and session cost, prompt-cache countdown, 5-hour and weekly quota with reset times, and context usage. |
| **welcome** | When a new session starts, a card above the prompt shows the project's branch, uncommitted changes, ahead/behind, the last three commits, a one-line gist of README.md / AGENTS.md / CLAUDE.md (press one to read its opening lines), what the last session did (its recap and the files it edited) and the project's five most recent sessions; press a digit in the empty prompt to resume one. It hides on your first message; `/welcome` brings it back. |
| **desktop-cockpit** | The three mods above, drawn for Claude Code Desktop. Above the prompt: the stats row (turn, tok/s, cost, cache minutes left, quota and context as bars) and, in a new session, the welcome card. `/cockpit [usage\|project\|prompts] [keyword]` (or the 驾驶舱 › button) opens a pane with three tabs: usage with reset times, the project's git state, docs and last session, and your messages, each one click to scroll to. On desktop, quota-band and welcome leave the band to it; in a terminal it draws nothing above the prompt. Needs no Python. |
| **auto-continue** | `/auto-continue on [1d\|12h\|90m]` turns on auto-continue for the session (`off` turns it off, no argument shows its state). When a turn stops because the weekly (or 5-hour) quota is used up, it waits for that window to reset and then sends a prompt to carry the work on — but only if the reset comes within the wait you allowed, counted from when the quota ran out (24 hours by default). While waiting, the status line shows when it will continue and the prompt footer shows `auto-continue`. It also continues at a set time: `/auto-continue at 14:30 [message]` (today, or tomorrow once passed), `at 10/22 09:00 [message]` or `in 2h [message]` sends the message (`continue` by default) then; `cancel` drops it. Options: on by default, the longest wait, the prompts it sends, and whether to wait for the weekly quota only. Works in the terminal and the desktop app. With quota-band or desktop-cockpit installed, its state also shows in their stats row beside the quota (`⏳ 10:01 自动续`, `⏰ 14:30 定时续`, `⟳ 自动续`), and desktop-cockpit's usage tab has buttons to turn it on or off, continue in an hour, or cancel the set time. |
| **prompt-jump** | `/prompts` lists the messages you sent in this session; press a number to scroll the transcript to one. `0` or `/bottom` jumps back to the end. Scrolling needs the fullscreen layout (`/tui fullscreen`). |

## Install

```
/plugin install quota-band --marketplace JunWang666/cc-cockpit
/plugin install prompt-jump --marketplace JunWang666/cc-cockpit
/plugin install welcome --marketplace JunWang666/cc-cockpit
/plugin install desktop-cockpit --marketplace JunWang666/cc-cockpit
/plugin install auto-continue --marketplace JunWang666/cc-cockpit
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `JunWang666/cc-cockpit`, then Add plugin.

## Develop

Each mod is in `mods/<name>/`. Check one with `claude plugin validate mods/<name>` and `claude plugin test mods/<name>`, then `/reload-plugins` in a session.
