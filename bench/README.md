# Does gearbox pay off?

A small side-by-side test: the same real tasks, run once on plain Opus and once with gearbox, compared on cost, time and quality. Decide what to keep from the numbers, not from the design.

## 1. Pick the tasks

Take 5 to 8 tasks you would really do this week, mixed like your usual work. For each, write down how you will judge the result before running anything.

| # | Task (the prompt you will paste) | Kind | Quality check |
|---|---|---|---|
| 1 | | ticket with an e2e check | tests pass; review the diff |
| 2 | | bug whose cause is unknown | bug gone; no regression |
| 3 | | refactor across files | tests pass |
| 4 | | small UI change checked in the browser | looks right in the browser |
| 5 | | question about the codebase | answer correct and complete |

## 2. Run each task twice

Both runs start from the same commit, in their own checkout, so neither sees the other's changes:

```
git worktree add ../wt-plain  <commit>
git worktree add ../wt-gearbox <commit>
```

**Plain run** (in `../wt-plain`): start `claude`, then `/model opus`, `/effort xhigh` (or the effort you normally use) and `/gearbox off`. Paste the task prompt and work as you normally would. When it is done, run the quality check.

**gearbox run** (in `../wt-gearbox`): start `claude`, `/model opus`, `/gearbox on`. Paste the same prompt and answer any questions the same way. Run the quality check.

- Run the two one after the other, never at the same time: `/gearbox off` applies to every session on the machine until you turn it back on.
- Alternate which side goes first from task to task, so neither always benefits from a warm prompt cache.
- Give both runs the same follow-ups. If one needs an extra nudge ("you missed the test"), that counts against it; note it.

## 3. Measure

From the gearbox checkout, after each pair:

```
python3 -I bench/compare.py plain-1=@../wt-plain gearbox-1=@../wt-gearbox
```

`@<checkout>` picks the latest session started in that checkout. The script reads Claude Code's own transcripts, so the plain run is measured the same way. It reports wall time, prompts you typed, subagents, requests per model, tokens and cost at API list prices, subagents included. `python3 -I bench/compare.py --self-test` checks the script itself.

## 4. Record and decide

| Task | Side | Cost | Time | Tests / check | Review (1–5) | Nudges | Notes |
|---|---|---|---|---|---|---|---|
| 1 | plain | | | | | | |
| 1 | gearbox | | | | | | |

Read it per task, then overall:

- **gearbox wins** where it costs less and the quality check and review hold.
- **A cheaper run with a worse result is a loss**, not a saving.
- **Single runs are noisy.** A difference of a few cents or one review point is within noise; repeat a task if the call is close.
- Look at what gearbox did on the tasks where it lost (the route note at the top of the turn, the status line, `/gearbox pane`). That points at which part to change or drop.
