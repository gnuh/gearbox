# gearbox

A Claude Code mod that shifts gears for you. Start a session on **Haiku**. Before each prompt, a quick Haiku call *describes* the request: how much of the project it touches, how costly a mistake would be, how subtle it is, and whether the turn will edit code, drive a browser or wait on a long command. gearbox's own rules turn that description into a model (haiku, sonnet, opus, fable) and an effort (low … max), and the turn runs there. Browser checks and long commands go to cheap subagents, so the expensive model plans and judges instead of clicking and waiting.

Built and tested on Claude Code 2.1.311. The mod API is early access and may change between releases.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install gearbox --marketplace gnuh/gearbox
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). From a shell: `claude plugin install gearbox --marketplace gnuh/gearbox`. In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `gnuh/gearbox`, then Add plugin.

Then start a session on Haiku (`/model haiku`) and work as usual.

## The rules

| The survey says | Gear |
|---|---|
| one spot (a question, a rename, a one-line edit) | haiku |
| one feature or a few related files | sonnet |
| many files, or a bug whose location is unknown | opus |
| open-ended design or research | fable, in a subagent |
| a costly mistake (payments, auth, secrets, data) | at least opus · medium |
| depth 0 / 1 / 2 / 3 | effort low / medium / high / xhigh (max only when you ask) |

- **The main model only rises, and never to Fable.** Each model switch writes the whole conversation into the new model's cache, so gearbox shifts up when needed and stays there. A toast shows what each shift costs. Effort changes freely. `/clear` starts over.
- **Fable work runs in a Fable subagent** with a self-contained brief. If you name Fable yourself ("use fable"), that one turn runs on Fable in the main conversation.
- **Browser checks:** the main model writes the checklist, a **Sonnet** subagent clicks through it and reports pass or fail per step, and the main model judges. Screenshots never enter the main conversation.
- **Long commands** (build, deploy, publish, full test runs, log searches): a **Haiku** subagent runs the exact command and reports only the outcome.
- **Side tasks** unrelated to your recent messages go to a subagent at their own gear, unless they are quick edits.
- **Nods** ("ok", "go ahead", "pode seguir") keep the last gear with no survey.
- **Asking you first.** Before Fable or xhigh/max effort, gearbox asks, offering a cheaper gear. It skips the question when you asked for that model or effort yourself: the survey must report the ask *and* the word must appear in your own text, outside code and quotes.
- **Hands off otherwise.** Nothing happens unless the session's model is Haiku. Prompts nobody typed (notifications, schedules) run on the current main model without a survey.

## What the survey sees

The rules, your new prompt (up to about 4,000 characters, as JSON), your last three messages (200 characters each), and the previous gear. Never files, tool output or the model's replies. It is one Haiku call at low effort, about a second per prompt. If the reply is unusable, the turn keeps the previous gear (sonnet · medium on a first prompt).

## Commands

| Command | |
|---|---|
| `/gearbox` | status |
| `/gearbox on`, `/gearbox off` | turn gearbox on or off (off is plain Haiku) |
| `/gearbox ask on`, `/gearbox ask off` | ask before Fable or xhigh/max |
| `/gearbox usage` | calls, tokens and estimated cost per model, subagents included |
| `/gearbox usage reset` | clear the usage ledger |

The status line shows the gear, for example `gearbox ▸ opus·medium ⇢ sonnet browser check`. Each survey reply goes to the debug log (`claude --debug`).

## Tuning

The survey prompt and the rules are in `hooks/policy.ts` (`SURVEY`, `gearFor`, `plan`). The prices behind the cost estimates are `PRICES` in `hooks/register.ts`. Run the tests with `claude plugin test .`.

## License

MIT, see [LICENSE](LICENSE).
