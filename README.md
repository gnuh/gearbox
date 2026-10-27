# gearbox

A Claude Code mod that shifts gears for you. Before each prompt, a quick Haiku call *describes* the request: how much of the project it touches, how costly a mistake would be, how subtle it is, and whether the turn will write code, answer, drive a browser or wait on a long command. gearbox's own rules turn that description into a gear, and the turn runs there. Browser checks and long commands go to cheap subagents, so the expensive model plans and judges instead of clicking and waiting.

It works in two modes, picked by the model the session runs on:

- **Steer** (any model but Haiku, for example Opus 5.5): the session keeps its model, so its prompt cache and reasoning stay intact. gearbox sets each turn's effort and hands tool-heavy and Fable-level work to subagents. Changing effort between turns keeps the prompt cache: on Claude Code 2.1.311 with Opus 5.5 and a 70K-token conversation, a switch wrote under 1K tokens to the cache, the same as an unchanged turn.
- **Shift** (a session on Haiku): gearbox also picks the model per turn (haiku, sonnet, opus, fable), only ever moving up.

Built and tested on Claude Code 2.1.311. The mod API is early access and may change between releases.

## Install

### Claude Code in a terminal

At the prompt of a terminal session:

```
/plugin install gearbox --marketplace gnuh/gearbox
```

Answer `y` to add the marketplace, then pick a scope. The user scope loads gearbox in every session, including the desktop app's local Code sessions. From a shell instead: `claude plugin install gearbox --marketplace gnuh/gearbox`.

### Claude desktop app

`/plugin` does not run in the desktop app's Code tab; use the Plugins menu instead:

1. Open the **Code** tab and start or open a session.
2. Click **+** next to the prompt box, then **Plugins**.
3. Choose **Add marketplace** and enter `gnuh/gearbox`.
4. Find **gearbox** in that marketplace's list and choose **Add plugin**.
5. Start a new session. The status line under the prompt box shows `gearbox ▸ …` once the first turn runs, and `/gearbox` reports the mode and settings.

gearbox works with its defaults right away. To change a setting, type `/gearbox settings` in a session (see Settings below).

### After installing

Work as usual: on Opus (or Sonnet) for steer mode, or start on Haiku (`/model haiku`) for shift mode. The defaults suit most work; change them with `/gearbox settings`. To get a newer version later: `claude plugin update gearbox` from a shell, then `/reload-plugins`.

## Settings

The defaults are ready to use. To change one, type in any session, terminal or desktop app:

- `/gearbox settings`: a panel with a row of buttons per setting; the value in use is marked, press another to switch.
- Or directly: `/gearbox effort high`, `/gearbox navigator haiku`, `/gearbox steer off`, `/gearbox strict off`, `/gearbox log on`.

A change applies from your next prompt and is kept for later sessions. What you set with `/gearbox` wins over the plugin's own options, which you can also set from a shell (`claude plugin configure gearbox@gearbox --values-stdin`) where you prefer.

| Setting | Default | |
|---|---|---|
| coding effort (`/gearbox effort`) | `xhigh` | Effort for ordinary coding turns: `medium`, `high` or `xhigh`. Trivial turns still run `low`; answers and explanations follow their difficulty. gearbox never asks before using it. `xhigh` is the most thorough and makes turns longer; Anthropic suggests `medium` for Opus 5.5, which beats Opus 5 at `high` on coding, if you want faster, cheaper turns. |
| steer (`/gearbox steer`) | on | Steer sessions not on Haiku. Off leaves them alone apart from the readout. |
| strict hand-offs (`/gearbox strict`) | on | During a browser-check or long-command step, the main conversation may not drive the browser or run the test, build or deploy command itself: the call is refused with a note naming the subagent to start. Other shell work, like reading a file or a commit whose message mentions a build, still runs: only the command itself counts, not its quoted text. Off lets the model do it itself, at least at medium effort. |
| popup (`/gearbox popup`) | `always` | `always`: whenever Claude works, a popup with the live model and effort and any subagents (see Live readout); `agents`: only while subagents run; `off`. Quiet while the gearbox pane is open. |
| debug log (`/gearbox log`) | off | `on` writes what gearbox decides to a log file (below); `full` also keeps the first 200 characters of each prompt. |
| navigator (`/gearbox navigator`) | `sonnet` | Model of the subagent that clicks through browser checks and only collects evidence: `sonnet` or `haiku` (cheaper). In a side-by-side run on one page both gave identical, correct evidence; Sonnet took 78 s against Haiku's 84 s and Haiku lost a tab once. The main model always does the analysis. |

## The rules

| The survey says | Gear |
|---|---|
| one spot (a question, a rename, a one-line edit) | haiku |
| one feature or a few related files | sonnet |
| many files, or a bug whose location is unknown | opus |
| open-ended design or research | fable, in a subagent |
| a costly mistake (payments, auth, secrets, data) | at least opus · medium |
| depth 0 | effort low |
| depth 1 / 2 / 3, writing code | your `code_effort` / at least high / at least xhigh |
| depth 1 / 2 / 3, answering | effort medium / high / xhigh (max only when you ask) |

In steer mode the model column only picks subagents' models: the session itself keeps its model unless you name another ("use sonnet for this"), which moves that one turn.

- **In shift mode the main model only rises, and never to Fable.** Each model switch writes the whole conversation into the new model's cache, so gearbox shifts up when needed and stays there. A toast shows what each shift costs. Effort changes keep the cache. `/clear` starts over.
- **Fable work runs in a Fable subagent** with a self-contained brief. If you name Fable yourself ("use fable"), that one turn runs on Fable in the main conversation.
- **Browser checks are two steps.** A navigator subagent (**Sonnet** by default, or **Haiku** with the `navigator` setting) clicks through and only collects evidence: what each page showed, values, console errors and failed requests, with no pass or fail. The main model, a different one, then analyzes that evidence, so no model judges its own clicking. Screenshots never enter the main conversation.
- **Long commands** (build, deploy, publish, full test runs, log searches): a **Haiku** subagent runs the exact command and reports only the outcome.
- **Side tasks** unrelated to your recent messages go to a subagent at their own gear, unless they are quick edits.
- **Nods** ("ok", "go ahead", "pode seguir") keep the gear of the last real work with no survey, never the low effort of a turn that only briefed a subagent.
- **Hand-offs are enforced.** A plain subagent started during a hand-off step runs on that step's model and effort, whatever the call named (typed agents such as Explore keep theirs). With strict hand-offs on, the main conversation cannot drive the browser or run the long command itself during such a step; with it off, doing so raises its effort to at least medium.
- **Asking you first.** Before Fable or xhigh/max effort, gearbox asks, offering a cheaper gear. It skips the question when the effort is your own `code_effort`, or when you asked for that model or effort yourself: the survey must report the ask *and* the word must appear in your own text, outside code and quotes.
- **Slash commands and skills set their own effort.** A `/command` turn does not inherit the gear of your last prompt: the skill's own `effort` frontmatter applies, else Claude Code's usual effort. So does `ultrathink` in your own words.
- **Hands off otherwise.** Prompts nobody typed (notifications, schedules) run on the current gear without a survey.

## Multi-step requests

A prompt with several steps ("go to Jira, check the task, build it, test it in Chrome and with Playwright, then commit") becomes a numbered route the main model reads, each step with its own executor and effort. For that prompt, on Opus with `code_effort` xhigh:

| Step | Runs on | Effort |
|---|---|---|
| Read the Jira task | Haiku subagent, returns the task word for word | low |
| (or) Search the vault for earlier decisions | Haiku subagent, returns each matching note in full | low |
| Build the change | main conversation (Opus) | xhigh |
| Check it in Chrome: navigate | Sonnet subagent, evidence only | low |
| Check it in Chrome: analyze | main conversation (Opus) | medium or higher |
| Run Playwright | Haiku subagent, outcome only | low |
| Commit | main conversation (Opus) | low |

Name a model for a step and it wins over the settings ("navigate with haiku"), but only if the word is in your own text, outside code and quotes. The main model calls gearbox's `phase` tool as each step starts, and gearbox sets its effort for that step (until the first call, the turn runs at the effort of its main work step); effort changes keep the prompt cache. Other models come in only as subagents, since switching the main conversation's model mid-turn would restart its cache. The status line shows the step under way, `gearbox ▸ opus·xhigh · step 2/6 build the change`.

## Live readout

gearbox shows which model every loop is running on at this moment: the main conversation and each subagent, in either mode.

- **Spinner:** the working loop's line names the model and effort of its request in flight, `Sauteing… on opus · xhigh`. Claude Code's own effort display shows the session setting, not what gearbox sent; this one is live.
- **Above the prompt:** while subagents run, a chip per live loop, `● main opus·high  ● check it in Chrome haiku·low  ● deploy haiku·low`. It stays empty otherwise.
- **Pane:** `/gearbox pane` opens a table of every loop in the session, nested under the loop that started it, with its model, effort, the tool it is running and its step count. A row says `answered by …` when a fallback answered on a different model than the one requested. **Hide finished** at the top keeps only what is running (the main conversation stays); **Show finished (n)** brings the rest back. The choice is kept; `/gearbox pane running` or `/gearbox pane all` sets it too.
- **Popup:** whenever Claude is working, a popup (a toast, in the terminal and the desktop app) shows what is running, live. Its first line is the main conversation's model·effort for the request in flight and what it is doing (down to the Bash command, file or URL), `gearbox · opus·xhigh · Edit total.ts`, so a surface that shows one line still shows it; any subagents follow as a tree. Each popup asks for a short stay and is renewed every few seconds while work runs. It follows every request and tool call, and a short "gearbox · done" replaces it when the turn ends. It stays quiet while the gearbox pane is open, which shows the same. `/gearbox popup agents` shows it only while subagents run; `/gearbox popup off` turns it off.
- **Status line:** the main gear plus the running subagents, `gearbox ▸ opus·high ⇢ 2 agents: sonnet·medium, haiku·low`.

All four read one shared record that is updated when a subagent starts, as each request leaves (so the readout is never a step late), when the reply returns, on each tool call and when a turn ends.

## What the survey sees

The rules, your new prompt (up to about 4,000 characters, as JSON), your last three messages (200 characters each), and the previous gear. Never files, tool output or the model's replies. It is one Haiku call at low effort, about a second per prompt, with no cap on the length of Haiku's answer. If Haiku corrects itself mid-reply, its corrected answer is used. If it is unsure, its best guess sets the effort but nothing is handed off; if its reply is unusable, the turn keeps the previous gear, or your coding effort on a first prompt.

## Commands

| Command | |
|---|---|
| `/gearbox` | status: mode, settings, current gear |
| `/gearbox settings` | open the settings panel |
| `/gearbox log` | show the debug log's path, last decision and last request; `/gearbox log on\|off\|full` turns it on or off |
| `/gearbox effort <medium\|high\|xhigh>`, `/gearbox navigator <sonnet\|haiku>`, `/gearbox steer <on\|off>`, `/gearbox strict <on\|off>` | change one setting directly |
| `/gearbox pane` | open the live table of every loop's model; `/gearbox pane running` lists only what is running, `/gearbox pane all` everything |
| `/gearbox on`, `/gearbox off` | turn gearbox on or off (off leaves every session alone, no readout) |
| `/gearbox ask on`, `/gearbox ask off` | ask before Fable or xhigh/max |
| `/gearbox usage` | calls, tokens and estimated cost per model, subagents included |
| `/gearbox usage reset` | clear the usage ledger |

Each survey reply goes to the debug log (`claude --debug`).

## Tuning

The survey prompt and the rules are in `hooks/policy.ts` (`SURVEY`, `gearFor`, `plan`). The prices behind the cost estimates are `PRICES` in `hooks/register.tsx`. Run the tests with `claude plugin test .`.

## Debug log

`/gearbox log on` (off by default) writes one JSON line per event to `~/.claude/gearbox/logs/<session-id>.jsonl`, so you can see what gearbox decided and why:

- `session`: gearbox and Claude Code versions, the session's model, and the settings in force with where they came from.
- `prompt`: its kind (typed, command, notification, ultrathink) and length. The text itself is kept only with `/gearbox log full`, first 200 characters.
- `survey`: the quick Haiku check's reply, how long it took, and how it was read.
- `gear`: the gear chosen and why (for example `survey: code, area, depth 1`, `nod: reused the last work gear`, `survey unreadable: previous gear`), plus any hand-off or route.
- `phase`, `agent` (a subagent re-geared: asked versus set), `strict` (a refused call), `raise` (effort raised because the model did a hand-off step itself), `popup` (what the popup showed, or that it closed).
- `step`: every request, main conversation and subagents: the model and effort gearbox **sent**, what Claude Code's own setting would have sent, the model that answered, and tokens.

`/gearbox log` shows the file's path, the last decision and the last request. Claude Code's own effort display shows its session setting, not what gearbox sent per request; the log's `step` lines show both. `bench/compare.py` reads the log to add the effort sent per request to its comparison. The log stays on your machine; delete the folder whenever you like.

## Does it pay off?

`bench/` has a side-by-side test: the same real tasks on plain Opus and with gearbox, compared on cost, time and quality from Claude Code's own transcripts. See [bench/README.md](bench/README.md).

## License

MIT, see [LICENSE](LICENSE).
