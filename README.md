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

To set your coding effort or navigator, open `/config` in a session and change gearbox's **Coding effort** and **Browser navigator** rows.

### After installing

Work as usual: on Opus (or Sonnet) for steer mode, or start on Haiku (`/model haiku`) for shift mode. Set your coding effort in `/config` (below). To get a newer version later: `claude plugin update gearbox` from a shell, then `/reload-plugins`.

## Settings

Both appear as rows in `/config` and on the install screen.

| Setting | Default | |
|---|---|---|
| `code_effort` | `medium` | Effort for ordinary coding turns: `medium`, `high` or `xhigh`. Trivial turns still run `low` and the hardest `xhigh`; answers and explanations follow their difficulty. gearbox never asks before using your own choice. Anthropic advises `medium` for Opus 5.5, which beats Opus 5 at `high` on coding; pick `xhigh` if you want the most thorough work and accept longer turns. |
| `steer` | on | Steer sessions not on Haiku. Off leaves them alone apart from the readout. |
| `navigator` | `sonnet` | Model of the subagent that clicks through browser checks and only collects evidence: `sonnet` or `haiku` (cheaper). In a side-by-side run on one page both gave identical, correct evidence; Sonnet took 78 s against Haiku's 84 s and Haiku lost a tab once. The main model always does the analysis. |

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
- **Nods** ("ok", "go ahead", "pode seguir") keep the last gear with no survey.
- **Asking you first.** Before Fable or xhigh/max effort, gearbox asks, offering a cheaper gear. It skips the question when the effort is your own `code_effort`, or when you asked for that model or effort yourself: the survey must report the ask *and* the word must appear in your own text, outside code and quotes.
- **Hands off otherwise.** Prompts nobody typed (notifications, schedules) run on the current gear without a survey.

## Multi-step requests

A prompt with several steps ("go to Jira, check the task, build it, test it in Chrome and with Playwright, then commit") becomes a numbered route the main model reads, each step with its own executor and effort. For that prompt, on Opus with `code_effort` xhigh:

| Step | Runs on | Effort |
|---|---|---|
| Read the Jira task | Haiku subagent, returns the task word for word | low |
| Build the change | main conversation (Opus) | xhigh |
| Check it in Chrome: navigate | Sonnet subagent, evidence only | low |
| Check it in Chrome: analyze | main conversation (Opus) | medium or higher |
| Run Playwright | Haiku subagent, outcome only | low |
| Commit | main conversation (Opus) | low |

Name a model for a step and it wins over the settings ("navigate with haiku"), but only if the word is in your own text, outside code and quotes. The main model calls gearbox's `phase` tool as each step starts, and gearbox sets its effort for that step; effort changes keep the prompt cache. Other models come in only as subagents, since switching the main conversation's model mid-turn would restart its cache. The status line shows the step under way, `gearbox ▸ opus·xhigh · step 2/6 build the change`.

## Live readout

gearbox shows which model every loop is running on at this moment: the main conversation and each subagent, in either mode.

- **Spinner:** the working loop's line names its model, `Sauteing… on opus` (Claude Code already shows the effort).
- **Above the prompt:** while subagents run, a chip per live loop, `● main opus·high  ● check it in Chrome haiku·low  ● deploy haiku·low`. It stays empty otherwise.
- **Pane:** `/gearbox pane` opens a table of every loop in the session, nested under the loop that started it, with its model, effort, the tool it is running and its step count. A row says `answered by …` when a fallback answered on a different model than the one requested.
- **Status line:** the main gear plus the running subagents, `gearbox ▸ opus·high ⇢ 2 agents: sonnet·medium, haiku·low`.

All four read one shared record that is updated when a subagent starts, as each request leaves (so the readout is never a step late), when the reply returns, on each tool call and when a turn ends.

## What the survey sees

The rules, your new prompt (up to about 4,000 characters, as JSON), your last three messages (200 characters each), and the previous gear. Never files, tool output or the model's replies. It is one Haiku call at low effort, about a second per prompt. If the reply is unusable, the turn keeps the previous gear (sonnet · medium on a first prompt).

## Commands

| Command | |
|---|---|
| `/gearbox` | status: mode, coding effort, current gear |
| `/gearbox pane` | open the live table of every loop's model |
| `/gearbox on`, `/gearbox off` | turn gearbox on or off (off leaves every session alone, no readout) |
| `/gearbox ask on`, `/gearbox ask off` | ask before Fable or xhigh/max |
| `/gearbox usage` | calls, tokens and estimated cost per model, subagents included |
| `/gearbox usage reset` | clear the usage ledger |

Each survey reply goes to the debug log (`claude --debug`).

## Tuning

The survey prompt and the rules are in `hooks/policy.ts` (`SURVEY`, `gearFor`, `plan`). The prices behind the cost estimates are `PRICES` in `hooks/register.tsx`. Run the tests with `claude plugin test .`.

## License

MIT, see [LICENSE](LICENSE).
