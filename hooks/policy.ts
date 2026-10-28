import type { ModelEffort } from 'claude-code'

export type Model = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Gear = { model: Model; effort: ModelEffort }

export const MODELS: readonly Model[] = ['haiku', 'sonnet', 'opus', 'fable']
export const EFFORTS: readonly ModelEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// The higher of two rungs on a ladder.
export const upTo = <T>(ladder: readonly T[], a: T, b: T): T => (ladder.indexOf(b) > ladder.indexOf(a) ? b : a)
const below = (m: Model, target: Model) => MODELS.indexOf(m) < MODELS.indexOf(target)
// The model a reading calls for, as a hand-off runs it: Fable comes in only through its own deep hand-off.
export const upFor = (want: Gear): Model => (want.model === 'fable' ? 'opus' : want.model)

// Handing a steered session's work up to a stronger model's subagent: `on` hands up code, reviews, costly work and
// subtle questions; `code` only work that changes files (code, and fixing what a browser check found) and reviews;
// `off` nothing.
export type Escalate = 'on' | 'code' | 'off'
export const ESCALATES: readonly Escalate[] = ['on', 'code', 'off']
// Whether the setting lets work of this mode go up at all. Mechanical work (depth 0) never does: a cold subagent
// costs more than the care it would add. A review goes at any depth, under `code` too: it changes no files, but it
// is never an answer for this setting.
const mayGoUp = (mode: string, depth: number, escalate: Escalate) =>
  escalate !== 'off' && (depth >= 1 || mode === 'review') && mode !== 'commit' && !(escalate === 'code' && mode === 'answer')
// What the main conversation runs at while a stronger model's subagent takes its work: writing a brief from a long
// conversation, and later reviewing the result, is where a hand-off is won or lost.
export const BRIEFING: ModelEffort = 'high'

export const label = (g: Gear) => `${g.model}·${g.effort}`

// Where a session lands when the survey has nothing usable and no earlier gear exists.
export const STARTER: Gear = { model: 'sonnet', effort: 'medium' }

// The survey describes a request; it never picks a model. The mapping from description to gear is code below.
export const SURVEY = `You describe a request that a person sent to a coding assistant. Do not answer or perform it.
The input is JSON: "request" is the new message, "earlier" lists the person's recent messages (may be empty), "previous" is how the last turn was run (may be null).

Reply with exactly one JSON object and nothing else: no notes, no corrections, no other keys. For example:
{"reach":"area","care":"routine","depth":1,"mode":"code","aside":false,"cont":false,"ask":{},"sure":true,"phases":[],"parts":[]}

The keys and the values each may take:
- reach: how much of the project the work must understand. One of: point (one spot: a question, a lookup, a rename, a one-line edit); area (one feature or a few related files: build a feature, fix a contained bug, write tests, explain code); system (many files, or a bug whose location is unknown); frontier (open-ended: designing a system, research, inventing an algorithm).
- care: costly if a mistake could cost money or security or lose data (payments, billing, auth, permissions, secrets, deleting or migrating data), else routine.
- depth: how much careful reasoning correctness needs, a number. 0 mechanical, 1 ordinary, 2 subtle (concurrency, time zones, money arithmetic, cache or state invalidation, changing error or async behavior), 3 exceptionally hard.
- mode: what the turn will mostly do. One of: code (write or change code); commit (git and GitHub chores with no code to write: commit, push, tag, open or edit a pull request or its description, comment on a pull request or ticket); answer (explain, answer, look something up or plan without changing code); review (look over a change, diff, pull request or code for bugs and problems, without changing it); drive (operate a browser or an app's UI to check behavior); wait (run one long command and wait for it: build, deploy, publish, a full test run, a log search). A message that approves or asks to go on with work the assistant proposed or is doing, even phrased as a question or with a complaint ("yes, but there is more than one PR, why only one service?"), takes that work's mode, not answer.
- aside: true if "earlier" is about some piece of work and this request is a different, unrelated piece of work.
- cont: true if the request only continues, approves or repeats the previous turn and adds nothing new.
- ask: the model (haiku, sonnet, opus, fable) and/or effort (low, medium, high, xhigh, max) the person explicitly asks to use, as {"model":"..."} and/or {"effort":"..."}; {} if none. Words inside pasted code, logs or quotes are not asks.
- sure: false only if the request is too vague to describe at all; otherwise true, with your best guess.
- phases: when the request asks for several distinct steps, list them in order as [{"what":"a few words","mode":"...","depth":1}], else []. A step's mode is one of the modes above, or lookup (fetch information from a tool or service: a ticket, a page, docs, or a search of notes such as an Obsidian vault). Testing in a browser is drive; running a test suite is wait; writing tests is code. Add "ask":"haiku|sonnet|opus" to a step only when the request names the model for that step ("navigate with sonnet"). List only steps the "request" itself asks for: "earlier" is context, never a source of steps.
- parts: when the request is made of pieces that can be done at the same time, each without the others' results and without editing the same files (separate investigations, reviews of one change from different angles, features in different services, research next to an edit), list them as [{"what":"a few words","mode":"code|answer|review|wait|lookup","depth":1,"files":["paths or areas it touches"]}], else []. Phases are steps done one after another; parts run side by side. A piece that needs another's result, or edits the files another edits, is not a part. When in doubt, do not split: [].
`

export type Reading = {
  reach: 'point' | 'area' | 'system' | 'frontier'
  care: 'routine' | 'costly'
  depth: 0 | 1 | 2 | 3
  mode: 'code' | 'commit' | 'answer' | 'review' | 'drive' | 'wait'
  aside: boolean
  cont: boolean
  ask: Partial<Gear>
  sure: boolean
  phases: Phase[]
  parts: Part[]
}

export type Phase = { what: string; mode: 'lookup' | 'code' | 'answer' | 'drive' | 'wait' | 'commit'; depth: 0 | 1 | 2 | 3; ask?: 'haiku' | 'sonnet' | 'opus' }
const PHASE_MODES = ['lookup', 'code', 'answer', 'drive', 'wait', 'commit']
// A piece of a request that can run beside the others: what it does, and the files or areas it touches.
export type Part = { what: string; mode: 'code' | 'answer' | 'review' | 'wait' | 'lookup'; depth: 0 | 1 | 2 | 3; files: string[] }
const PART_MODES = ['code', 'answer', 'review', 'wait', 'lookup']

// The survey's phases, kept only when well formed; at most eight. A review step is an answer step: it reads and
// changes nothing.
const readPhases = (list: unknown): Phase[] =>
  (Array.isArray(list) ? list : [])
    .map((p: any) => (p && p.mode === 'review' ? { ...p, mode: 'answer' } : p))
    .filter((p: any) => p && PHASE_MODES.includes(p.mode) && [0, 1, 2, 3].includes(p.depth))
    .slice(0, 8)
    .map((p: any) => ({ what: String(p.what ?? p.mode).slice(0, 60), mode: p.mode, depth: p.depth, ...(['haiku', 'sonnet', 'opus'].includes(p.ask) ? { ask: p.ask } : {}) }))

// The survey's parts, and the fan tool's, kept only when well formed; at most six. Its files are kept as text,
// blanks dropped.
export const readParts = (list: unknown): Part[] =>
  (Array.isArray(list) ? list : [])
    .filter((p: any) => p && PART_MODES.includes(p.mode) && [0, 1, 2, 3].includes(p.depth))
    .slice(0, 6)
    .map((p: any) => ({
      what: String(p.what ?? p.mode).slice(0, 60),
      mode: p.mode,
      depth: p.depth,
      files: (Array.isArray(p.files) ? p.files : [])
        .filter((f: unknown): f is string => typeof f === 'string' && f.trim() !== '')
        .map((f: string) => f.trim().slice(0, 120))
        .slice(0, 12),
    }))

const REACHES = ['point', 'area', 'system', 'frontier']
const MODES = ['code', 'commit', 'answer', 'review', 'drive', 'wait']

// The survey's reply as a reading: undefined without a valid reach and depth; other keys fall back to plain values.
// Every top-level {...} in a reply, in order: a model that corrects itself writes more than one.
export const jsonObjects = (text: string): string[] => {
  const found: string[] = []
  let depth = 0
  let start = -1
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '\\') i++
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === '{' && depth++ === 0) start = i
    else if (c === '}' && depth > 0 && --depth === 0) found.push(text.slice(start, i + 1))
  }
  return found
}

// The survey's reply as a reading: its last valid object, so a reply that corrects itself is read by its correction.
export const readReading = (reply: string): Reading | undefined => {
  for (const candidate of jsonObjects(reply).reverse()) {
    try {
      const reading = toReading(JSON.parse(candidate))
      if (reading) return reading
    } catch {}
  }
  return undefined
}

const toReading = (o: any): Reading | undefined => {
  if (!o || !REACHES.includes(o.reach) || ![0, 1, 2, 3].includes(o.depth)) return undefined
  const ask = o.ask && typeof o.ask === 'object' ? o.ask : {}
  return {
    reach: o.reach,
    care: o.care === 'costly' ? 'costly' : 'routine',
    depth: o.depth,
    // A single-step lookup is answering: it reads, it changes nothing.
    mode: o.mode === 'lookup' ? 'answer' : MODES.includes(o.mode) ? o.mode : 'code',
    aside: o.aside === true,
    cont: o.cont === true,
    ask: {
      ...(MODELS.includes(ask.model) ? { model: ask.model } : {}),
      ...(EFFORTS.includes(ask.effort) ? { effort: ask.effort } : {}),
    },
    sure: o.sure !== false,
    phases: readPhases(o.phases),
    parts: readParts(o.parts),
  }
}

const REACH_MODEL: Record<Reading['reach'], Model> = { point: 'haiku', area: 'sonnet', system: 'opus', frontier: 'fable' }
const DEPTH_EFFORT: readonly ModelEffort[] = ['low', 'medium', 'high', 'xhigh'] // max only when asked for

// A max coding effort is for the big jobs: subtle or hard code (depth 2 and up). Everything else that follows the
// coding effort (small code, nods, failed reads, a turn that starts editing, code-writing subagents) stops at xhigh.
export const everyday = (standing: ModelEffort): ModelEffort => (standing === 'max' ? 'xhigh' : standing)
const codeFloor = (depth: number, standing: ModelEffort): ModelEffort => (depth >= 2 ? standing : everyday(standing))

// A review is read by at least Opus, whatever its reach: a missed bug costs more than the model. Its effort is the
// work's own, as an answer's. One rule for a review prompt and for a reviewing skill's fork.
export const reviewGear = (g: Gear): Gear => ({ model: upTo(MODELS, g.model, 'opus'), effort: g.effort })

// The gear a reading calls for. `standing` is the person's effort for ordinary coding (the code_effort setting):
// code never runs below it, at any depth, since "a small edit" is a guess made before anyone read the code;
// other work past depth 0 doesn't either; answers, reviews and git chores follow depth alone. A costly mistake lifts
// the gear to at least opus·medium, a review to at least opus; the person's own ask wins.
export const gearFor = (r: Reading, standing: ModelEffort = 'medium'): Gear => {
  const costly = r.care === 'costly'
  const model = costly ? upTo(MODELS, REACH_MODEL[r.reach], 'opus') : REACH_MODEL[r.reach]
  const byDepth = DEPTH_EFFORT[r.depth]!
  const base =
    r.mode === 'code'
      ? upTo(EFFORTS, byDepth, codeFloor(r.depth, standing))
      : r.depth > 0 && r.mode !== 'answer' && r.mode !== 'review' && r.mode !== 'commit'
        ? upTo(EFFORTS, byDepth, everyday(standing))
        : byDepth
  const effort = costly ? upTo(EFFORTS, base, 'medium') : base
  const g = r.mode === 'review' ? reviewGear({ model, effort }) : { model, effort }
  return { model: r.ask.model ?? g.model, effort: r.ask.effort ?? g.effort }
}

// Skills that review: their fork runs at a review's gear. Any other skill runs as Claude Code starts it.
export const reviews = (skill: string) => /review/i.test(skill)
// A forked skill's loop as the engine lists it: named after the skill, its description the skill's command and
// arguments ("/code-review <pull request>"). Nothing in the listing marks a fork as such. A plugin's skill
// ("github:code-review") may go by its own name alone.
export const isSkillFork = (a: { name?: string; description?: string }, skill: string): boolean =>
  [skill, skill.split(':').pop()!].some(n => a.name === n || a.description === `/${n}` || (a.description ?? '').startsWith(`/${n} `))

// The person's own words: fenced and inline code and quoted lines are dropped.
export const ownWords = (text: string) => text.replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ').replace(/^\s*>.*$/gm, ' ')

const SPOKEN: Record<Model | ModelEffort, RegExp> = {
  haiku: /\bhaiku\b/i,
  sonnet: /\bsonnet\b/i,
  opus: /\bopus\b/i,
  fable: /\bfable\b/i,
  low: /\blow\b|\bbaix/i,
  medium: /\bmedium\b|\bm[eé]di/i,
  high: /\bhigh\b|\balt[oa]\b/i,
  xhigh: /\bx-?high\b|extra.?high/i,
  max: /\bmax|m[aá]xim/i,
}

// The survey's "ask", kept only where the person's own words back it up, so a paste never picks a costly gear.
export const verifyAsk = (ask: Partial<Gear>, text: string): Partial<Gear> => {
  const words = ownWords(text)
  return {
    ...(ask.model && SPOKEN[ask.model].test(words) ? { model: ask.model } : {}),
    ...(ask.effort && SPOKEN[ask.effort].test(words) ? { effort: ask.effort } : {}),
  }
}

// Fable and the top efforts cost the most: they go to the person first, unless asked for, already running,
// or the person's own standing effort.
export const needsConsent = (g: Gear, ask: Partial<Gear>, previous?: Gear, standing?: ModelEffort) =>
  (g.model === 'fable' && !ask.model && previous?.model !== 'fable') ||
  // Never for an effort at or under the person's own coding effort: they chose it.
  ((g.effort === 'xhigh' || g.effort === 'max') && !ask.effort && previous?.effort !== g.effort && !(standing && EFFORTS.indexOf(g.effort) <= EFFORTS.indexOf(standing)))

export const stepDown = (g: Gear): Gear => ({
  model: g.model === 'fable' ? 'opus' : g.model,
  effort: g.effort === 'xhigh' || g.effort === 'max' ? 'high' : g.effort,
})

// One step of a multi-step request: the main conversation does it at `gear.effort`, or a subagent does it
// on `gear`. `mainEffort` is what the main conversation runs at during the step.
export type Step = { what: string; mode: Phase['mode'] | 'analyze'; by: 'main' | 'agent'; gear: Gear; mainEffort: ModelEffort }

// Each phase's executor and gear. The main model never changes mid-turn (that would restart the cache), so
// other models only come in as subagents; effort changes between steps are free.
// A browser check is two steps: the navigator (Sonnet, or Haiku by setting) only collects evidence, then the main model, a different
// one, analyzes it, so no model judges its own clicking.
// `up` is the model the request calls for: when the main model is below it, subtle or costly steps (code, answers,
// judging a browser check) go to a subagent on it, at the step's effort, while the main model briefs it and judges.
// The same rule as a single request's: code goes up past a mechanical edit, since the request's reach already says it
// is hard; answers and judgments only when subtle or costly.
export const route = (phases: Phase[], main: Model, standing: ModelEffort, costly: boolean, navigator: Model = 'sonnet', long = false, up: Model = main, escalate: Escalate = 'on'): Step[] =>
  phases.flatMap(({ what, mode, depth, ask }): Step[] => {
    const floor = (e: ModelEffort) => (costly ? upTo(EFFORTS, e, 'medium') : e)
    const doer = (what: string, mode: Step['mode'], effort: ModelEffort): Step =>
      below(main, up) && mayGoUp(mode, depth, escalate) && (mode === 'code' || depth >= 2 || costly)
        ? { what, mode, by: 'agent', gear: { model: up, effort }, mainEffort: BRIEFING }
        : { what, mode, by: 'main', gear: { model: main, effort }, mainEffort: effort }
    if (mode === 'lookup' || mode === 'wait') return [{ what, mode, by: 'agent', gear: { model: ask ?? 'haiku', effort: 'low' }, mainEffort: 'low' }]
    if (mode === 'commit' && long) return [{ what, mode, by: 'agent', gear: choreGear(depth), mainEffort: 'low' }]
    if (mode === 'drive') {
      const judge = floor(upTo(EFFORTS, DEPTH_EFFORT[depth]!, 'medium'))
      return [
        { what: `${what}: navigate`, mode, by: 'agent', gear: { model: ask ?? navigator, effort: 'low' }, mainEffort: 'medium' },
        doer(`${what}: analyze`, 'analyze', judge),
      ]
    }
    if (mode === 'commit') return [{ what, mode, by: 'main', gear: { model: main, effort: floor('low') }, mainEffort: floor('low') }]
    return [doer(what, mode, floor(mode === 'code' ? upTo(EFFORTS, DEPTH_EFFORT[depth]!, codeFloor(depth, standing)) : DEPTH_EFFORT[depth]!))]
  })

// A step the main model would do, handed to a stronger model's subagent.
export const escalated = (s: Step) => s.by === 'agent' && (s.mode === 'code' || s.mode === 'answer' || s.mode === 'analyze')

// What a subagent taking over the main model's work needs: it sees nothing of this conversation.
const BRIEF =
  'a brief that stands on its own: where the project is, the goal, the limits, what is already decided here, what was tried and ruled out, and what the person asked for along the way; point it at files rather than pasting them'
// Such a subagent starts as a plain Agent, so gearbox runs it on the gear the work calls for, not a typed agent's own.
const PLAIN = 'a plain Agent (no subagent_type)'

// The person's own recent words, which gearbox adds under a stronger model's brief so a thin brief cannot drop
// what they asked: their last few messages, latest last, each cut to its end (where the ask usually is).
// A part of a fan-out reads them as context: its brief is its part alone, and other agents take the rest.
export const ownBrief = (messages: readonly string[], part = false): string => {
  const kept = messages
    .map(m => m.trim())
    .filter(Boolean)
    .slice(-3)
    .map(m => (m.length <= 1500 ? m : `[…] ${m.slice(-1500)}`))
  return kept.length
    ? `\n\n---\nAdded by gearbox: the person's own recent messages in the main conversation, word for word, latest last. The brief above is what is decided${part ? ", and it is this agent's part alone: other agents take the rest of the request at the same time" : ''}; these are what they asked.\n${kept.map(m => m.replace(/^/gm, '> ')).join('\n\n')}`
    : ''
}

const STEP_TASK: Record<Step['mode'], string> = {
  lookup: 'that fetches it and returns the full relevant content word for word (for a ticket: title, description, acceptance criteria, comments that change the scope; for notes: each matching note\'s title and full text), with nothing summarized away',
  drive: 'with a checklist you write here first (where to go and what to do); it must not edit files or judge pass or fail, only report per step exactly what it saw: visible text and values, what each screenshot shows, console errors and failed network requests',
  wait: 'that runs only the exact command you settle here, waits until it ends, and answers with passed or failed, the lines that explain a failure, and any link or id it printed',
  commit: 'with a brief that stands on its own: the repository path and branch, the commits, the pull request and any text to write, in full; it runs only that, changes nothing else, and reports what it did with any link, hash or id',
  code: `with ${BRIEF}; it makes the change, checks it, and reports the files it changed and anything left open; review that here`,
  answer: `with ${BRIEF}; it works it out and reports its findings in full, which you pass on to the person without cutting them down`,
  analyze: 'with the navigator\'s report word for word and what the change should do; it judges what is broken, fixes it, and reports what it found and changed; review that here',
}

// The route the main model reads beside the prompt. It calls the phase tool as each step starts.
export const routeNote = (steps: Step[]): string =>
  [
    `gearbox route for this request. As you start each step, call the tool mcp__gearbox__phase with its number: gearbox then sets your effort for it. Subagent steps keep their output out of this conversation. Skip a step that turns out unnecessary; judge results and fix problems here.`,
    ...steps.map((s, i) =>
      s.by === 'agent'
        ? `${i + 1}. ${s.what}: start ${escalated(s) ? PLAIN : 'an Agent'} with model "${s.gear.model}" and effort "${s.gear.effort}" ${STEP_TASK[s.mode]}.`
        : s.mode === 'analyze'
          ? `${i + 1}. ${s.what}: judge the evidence yourself against what the change should do (effort ${s.gear.effort}); decide what is broken and fix it here.`
          : `${i + 1}. ${s.what}: do it yourself (effort ${s.gear.effort}).`,
    ),
  ].join('\n')

// The effort of a route's own work: its highest main-conversation step, or the briefing of work handed up. A turn
// starts there, so a model that never calls the phase tool works at the work's effort, not at a briefing step's low.
export const workEffort = (steps: Step[]): ModelEffort =>
  steps.filter(s => s.by === 'main' || escalated(s)).reduce<ModelEffort>((top, s) => upTo(EFFORTS, top, s.mainEffort), 'low')

// Tools that do a browser check or a long command's work: the main conversation calling one during such a step
// means it skipped the subagent.
export const doesHandoffWork = (tool: string) => /^(Bash|PowerShell)$|chrome|playwright|browser|computer/i.test(tool)

// What strict mode keeps out of the main conversation during a hand-off step: driving the browser in a browser
// check, and the long command itself (a test run, a build, a deploy) in a long-command step. Other shell work,
// such as reading a file to settle the command, stays allowed.
export const isBrowserTool = (tool: string) => /chrome|playwright|browser|computer/i.test(tool)
// Only the command itself counts, not its quoted text or heredocs: a commit message that mentions "build" runs no build.
const unquoted = (command: string) =>
  command.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\s*\1\b/g, ' ').replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, ' ')
export const isLongCommand = (command: string) =>
  /\b(test|tests|e2e|playwright|jest|vitest|cypress|mocha|pytest|build|deploy|publish|release)\b/i.test(unquoted(command))

// A long conversation: every request here re-reads the whole context, so past this size git chores go to a fresh
// subagent and runs of reads to Haiku. Below it, the main conversation does both itself.
export const LONG_CONTEXT = 100_000
// Plain git work on Haiku; writing (a pull request section, a ticket comment) on Sonnet.
export const choreGear = (depth: number): Gear => (depth === 0 ? { model: 'haiku', effort: 'low' } : { model: 'sonnet', effort: 'medium' })

// A git or GitHub command that does a chore's work: the main conversation running one during a chore hand-off
// skipped the subagent. Reading (git status, git log, gh pr view) stays allowed.
export const isChoreCommand = (command: string) =>
  /\bgit\s+(commit|push|tag)\b|\bgh\s+(pr|issue|release)\s+(create|edit|comment|merge|close|review)\b/.test(unquoted(command))

// Shell commands that only read: a list or pipeline of them, with no redirection into a file and no command
// substitution. Anything it cannot tell is not a read.
const READERS = new Set(['cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ls', 'tree', 'find', 'wc', 'sort', 'uniq', 'cut', 'tr', 'jq', 'awk', 'sed', 'diff', 'stat', 'file', 'du', 'pwd', 'echo', 'printf', 'which', 'basename', 'dirname', 'realpath', 'nl', 'column', 'date', 'cd', 'true'])
const readsOne = (words: string[]): boolean => {
  while (/^\w+=/.test(words[0] ?? '')) words = words.slice(1)
  const [cmd = '', ...args] = words
  if (!cmd) return true
  if (cmd === 'git') {
    while (args[0] === '-C' || args[0] === '-c' || args[0] === '--no-pager') args.splice(0, args[0] === '--no-pager' ? 1 : 2)
    const [sub = '', ...rest] = args
    // Listing branches, remotes or tags takes only flags; a name creates, renames or deletes one.
    if (/^(branch|remote|tag)$/.test(sub)) return rest.every(a => a.startsWith('-') && !/^(-[dDmMcCfu]|--(delete|move|copy|force|set-upstream|unset-upstream|edit-description))/.test(a))
    return /^(status|log|show|diff|blame|grep|ls-files|ls-tree|rev-parse|describe|shortlog|cat-file|merge-base|name-rev|for-each-ref)$/.test(sub)
  }
  if (cmd === 'gh') {
    const [group = '', sub = ''] = args
    if (group === 'api') return !args.some(a => /^(-X|--method|-f|-F|--field|--raw-field|--input)/.test(a))
    if (group === 'auth') return sub === 'status'
    return group === 'search' || (/^(pr|issue|run|release|repo|workflow|label)$/.test(group) && /^(view|list|checks|diff|status)$/.test(sub))
  }
  if (cmd === 'sed') return !args.some(a => /^-[^-]*i|^--in-place/.test(a))
  if (cmd === 'find') return !args.some(a => /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(a))
  if (cmd === 'sort') return !args.some(a => /^(-o|--output)/.test(a))
  return READERS.has(cmd)
}
export const isReadOnlyCommand = (command: string): boolean => {
  const bare = unquoted(command)
  if (/\$\(|`|[<>]\(/.test(bare)) return false
  // Into another stream or /dev/null is no write.
  if (/>/.test(bare.replace(/\d*>&\d+|[&\d]?>>?\s*\/dev\/null/g, ' '))) return false
  return bare.split(/&&|\|\||[;|\n]/).every(part => {
    const words = part.trim().replace(/^(do|then|else)\s+/, '').split(/\s+/).filter(Boolean)
    if (words[0] === 'done' || words[0] === 'fi') return words.length === 1
    if (words[0] === 'for') return words[2] === 'in'
    return readsOne(words)
  })
}

// A tool call, as a request's response asks for it.
export type Use = { name: string; input: unknown }
const LOOKS = /^(Read|Grep|Glob|LS|NotebookRead|WebFetch|WebSearch)$/
// Tools that neither look nor change anything: they keep a run of reads going without counting as one.
const ASIDE = /^(TodoWrite|mcp__gearbox__phase)$|__update_plan$/
const looks = (u: Use) => LOOKS.test(u.name) || (u.name === 'Bash' && isReadOnlyCommand(String((u.input as { command?: unknown } | null)?.command ?? '')))
export const looksUp = (tool: string, command: string) => looks({ name: tool, input: { command } })
// While deep work waits for its agent, the main model may still brief it: start or message the agent, load a tool,
// plan, mark a step, ask the person, and make a few reads to write the brief.
export const BRIEFING_TOOLS = /^(Agent|SendMessage|ToolSearch|TodoWrite|AskUserQuestion|mcp__gearbox__phase|mcp__gearbox__fan)$|__update_plan$/
export const BRIEF_READS = 3
// What a response did: only read (asides allowed), only asides, or anything else (an edit, a command that changes
// something, an answer with no call).
export const readKind = (uses: readonly Use[]): 'read' | 'aside' | 'other' => {
  const own = uses.filter(u => !ASIDE.test(u.name))
  return !uses.length ? 'other' : !own.length ? 'aside' : own.every(looks) ? 'read' : 'other'
}

// Scouting: on a long conversation, a run of reads (fetching logs, reading files, grepping) goes to Haiku, whose
// cached input costs a quarter of Opus's. The main model still decides anything that matters: Haiku's reply is
// kept only if it calls nothing but reads and says little; any other reply is thrown away and the same request
// goes to the main model.
export const SCOUT: Gear = { model: 'haiku', effort: 'low' }
// Its first request caches the whole conversation for Haiku, which Claude Code keeps for an hour: so scouting
// starts on the second read in a row, or on the first while that cache is warm.
export const SCOUT_WARM_MS = 55 * 60_000
export const scouts = (streak: number, warm: boolean) => streak >= 2 || (streak >= 1 && warm)
export const keepsScout = (r: { stopReason: string | null; answer: string; toolUses: readonly Use[]; serverToolUses?: readonly unknown[] }) =>
  r.stopReason === 'tool_use' && r.answer.length <= 600 && !r.serverToolUses?.length && r.toolUses.length > 0 && r.toolUses.every(looks)

// `judge`: a browser check whose evidence a stronger model's subagent analyzes, not the main model.
// `resume`: a deep hand-off that goes on in the agent that already holds the work, by its id.
// `lane`: the orchestrator's hand-off, to the long-lived agent of the gear's model (`resume`: its id, when it is worth
// going back to); the gear's effort is the job's, which gearbox sets on each message.
// `fan`: the orchestrator's hand-off of independent parts, one agent each, all started at once; `gear` is the part
// a nod goes back to.
export type Handoff = { kind: 'drive' | 'wait' | 'chore' | 'aside' | 'deep' | 'lane' | 'fan'; gear: Gear; judge?: Gear; resume?: string; parts?: FanPart[] }
// One part of a fan-out: what it does, its gear, and whether it edits files. `resume`: the lane that takes it, by
// its id; `lane`: the agent started for it becomes its model's lane. Neither: a fresh agent for this turn only.
export type FanPart = { what: string; gear: Gear; edits: boolean; resume?: string; lane?: boolean }
export type Plan = { main: Gear; handoff?: Handoff }

export const handoffLabel = (h: Handoff) =>
  h.kind === 'fan'
    ? `fan × ${h.parts?.length ?? 0} → ${(h.parts ?? []).map(p => `${label(p.gear)}${p.resume ? ' (same agent)' : ''}`).join(', ')}`
    : `${h.kind}${h.resume ? ' (same agent)' : ''} → ${label(h.gear)}${h.judge ? `, judge ${label(h.judge)}` : ''}`

// Splits a turn between the main conversation and a subagent. `floor` is the main model so far;
// `hasEarlier` says whether there is earlier work for the request to be unrelated to. With `fixed`, the
// session keeps that model (steer mode): only effort and handoffs change, and weighty work (code, a review, a costly
// mistake, subtle reasoning) that calls for a stronger model goes to a subagent on it instead, as `escalate` allows.
// A guess hands nothing off and only sets the effort, a review excepted: that is handed off sure or not, on `want`.
export const plan = (r: Reading, want: Gear, floor: Model | undefined, hasEarlier: boolean, fixed?: Model, navigator: Model = 'sonnet', long = false, escalate: Escalate = 'on'): Plan => {
  if (!r.sure && r.mode !== 'review') return { main: fixed ? { model: fixed, effort: want.effort } : want }
  const base = fixed ?? floor ?? 'sonnet'
  // On tool-heavy turns the main model only plans and judges; a costly target still gets opus for that.
  const planner = fixed ?? (r.care === 'costly' ? upTo(MODELS, base, 'opus') : base)
  const costly = r.care === 'costly'
  if (r.mode === 'drive') {
    const up = upFor(want)
    const judge = below(planner, up) && mayGoUp('analyze', r.depth, escalate) && (r.depth >= 2 || costly) ? { model: up, effort: upTo(EFFORTS, DEPTH_EFFORT[r.depth]!, 'medium') } : undefined
    return { main: { model: planner, effort: 'medium' }, handoff: { kind: 'drive', gear: { model: r.ask.model === 'haiku' || r.ask.model === 'sonnet' ? r.ask.model : navigator, effort: 'low' }, ...(judge ? { judge } : {}) } }
  }
  if (r.mode === 'wait') return { main: { model: planner, effort: 'low' }, handoff: { kind: 'wait', gear: { model: 'haiku', effort: 'low' } } }
  if (r.mode === 'commit' && long) return { main: { model: planner, effort: 'low' }, handoff: { kind: 'chore', gear: choreGear(r.depth) } }
  if (want.model === 'fable' && r.ask.model !== 'fable' && fixed !== 'fable' && !(fixed && escalate === 'off'))
    return { main: { model: base, effort: BRIEFING }, handoff: { kind: 'deep', gear: want } }
  if (r.aside && hasEarlier && want.model !== 'haiku') return { main: { model: base, effort: 'medium' }, handoff: { kind: 'aside', gear: want } }
  // Code goes up at any depth past mechanical, since the reach that calls for the stronger model says it is hard;
  // a review at any depth; a question only when it is subtle or a mistake would be costly.
  const weighty = mayGoUp(r.mode, r.depth, escalate) && (r.mode === 'code' || r.mode === 'review' || costly || r.depth >= 2)
  if (fixed && !r.ask.model && weighty && below(fixed, want.model)) return { main: { model: fixed, effort: BRIEFING }, handoff: { kind: 'deep', gear: want } }
  return { main: fixed ? { model: fixed, effort: want.effort } : want }
}

// A deep hand-off's agent stays worth going back to while its cache is warm (an hour, as for scouting) and its
// context is still small enough that a fresh agent with a brief would not read less.
export const RESUME_MS = 55 * 60_000
export const RESUME_TOKENS = 150_000
export type DeepAgent = { id: string; gear: Gear; at: number; tokens: number }
export const resumable = (a: DeepAgent | undefined, now: number): a is DeepAgent => a !== undefined && now - a.at < RESUME_MS && a.tokens < RESUME_TOKENS

// The model the main conversation runs: the person's ask when the turn stays here, else never below the
// floor, since each switch writes the whole context into the new model's cache.
export const mainModel = (p: Plan, ask: Partial<Gear>, floor: Model | undefined): Model =>
  !p.handoff && ask.model ? ask.model : upTo(MODELS, p.main.model, floor ?? p.main.model)

// The floor after a turn on `m`: it only rises, and Fable never becomes it.
export const nextFloor = (m: Model, floor: Model | undefined): Model | undefined =>
  m === 'fable' ? floor : upTo(MODELS, floor ?? m, m)

// Replies that only say "carry on": they keep the last gear with no survey.
export const NOD =
  /^(ok(ay)?|k|yes|yeah|yep|sure|go( on| ahead)?|carry on|continue|proceed|do it|sim|pode( ir| seguir| continuar)?|segue|continua|manda|bora|beleza|certo|isso)[\s.!]*$/i

// Long pastes keep their opening and, larger, their end, where the question usually is.
export const trimRequest = (text: string) => (text.length <= 4000 ? text : `${text.slice(0, 1000)} […] ${text.slice(-3000)}`)

// What the main model reads beside the prompt (the person does not) when part of the turn belongs to a subagent.
// Work a lane holds that turns out to be independent pieces goes to the fan tool, not the one lane.
const SPLIT = 'Send it all to that one agent unless the new work splits into independent pieces: then call mcp__gearbox__fan first.'

export const handoffNote = ({ kind, gear, judge, resume, parts }: Handoff): string => {
  const agent = `an Agent with model "${gear.model}"${kind === 'aside' || kind === 'deep' || kind === 'chore' ? ` and effort "${gear.effort}"` : ''}`
  switch (kind) {
    case 'drive':
      return `gearbox handoff, browser check: a fast model navigates, and ${judge ? 'a stronger one' : 'you, a different model,'} judge${judge ? 's' : ''} what it found.
1. Write the check here: where to go and what to do, and note for yourself what each step should show.
2. Start ${agent} with that checklist. It must not edit files or judge pass or fail; it reports per step exactly what it saw: visible text and values, what each screenshot shows, console errors and failed network requests.
${judge ? `3. Start ${PLAIN} with model "${judge.model}" and effort "${judge.effort}" ${STEP_TASK.analyze}.` : '3. Analyze that evidence here against what the change should do, decide what is broken, and fix it.'}`
    case 'wait':
      return `gearbox handoff, long command: keep its output out of this conversation.
1. Settle the exact command and the directory it runs in here.
2. Start ${agent} to run only that, wait until it ends, and answer with: passed or failed, the lines that explain a failure, and any link or id it printed.
3. If it failed, investigate here.`
    case 'chore':
      return `gearbox handoff, git chore: this conversation is long, and every request here re-reads all of it, so a fresh subagent does the chore for less.
1. Settle exactly what to do here: the repository path and branch, the commits, the pull request, and any text to write, in full.
2. Start ${agent} with that brief. It runs only that, changes nothing else, and reports what it did with any link, hash or id.
3. Tell the person the outcome.`
    case 'aside':
      return `gearbox handoff, side task: this looks unrelated to the work so far. If it needs more than a quick edit, start ${agent} with a brief that stands on its own: where the project is, what to achieve, the limits, how to check the result, and anything decided here that applies. Send follow-ups to that same agent with SendMessage. If it turns out to be a quick edit, or part of the earlier work after all, do it here.`
    case 'lane':
      return resume
        ? `gearbox handoff, lane: the ${gear.model} lane ${resume} already holds this work and what it found. Send it the person's new message, with anything decided here since, using SendMessage to "${resume}" (load SendMessage with ToolSearch first if it is not loaded). Start no new agent unless that one no longer answers; then start ${PLAIN} with model "${gear.model}" and ${BRIEF}. ${SPLIT} gearbox sets the effort of each job. Review what it returns here before acting on it, and pass its findings on to the person in full, not cut down.`
        : `gearbox handoff, lane: this work is the ${gear.model} lane's, not yours. Start ${PLAIN} with model "${gear.model}" and ${BRIEF}, and say what to hand back. gearbox sets the effort of each job. Send follow-ups to that same agent with SendMessage, unless the new work splits into independent pieces: then call mcp__gearbox__fan first. Until it starts, edits, commands and more reads are refused here. Review what it returns before acting on it, and pass its findings on to the person in full, not cut down.`
    case 'fan':
      return fanNote(parts ?? [])
    case 'deep':
      return resume
        ? `gearbox handoff, deep work goes on: the ${gear.model} agent ${resume} already holds this work and what it found. Send it the person's new message, with anything decided here since, using SendMessage to "${resume}" (load SendMessage with ToolSearch first if it is not loaded). Start no new agent unless that one no longer answers; then start ${PLAIN} with model "${gear.model}" and effort "${gear.effort}" and ${BRIEF}. Review what it returns here before acting on it, and pass its findings on to the person in full, not cut down.`
        : `gearbox handoff, deep work: start ${PLAIN} with model "${gear.model}" and effort "${gear.effort}" and ${BRIEF}, and say what to hand back. Send follow-ups to that same agent with SendMessage, and review what it returns here before acting on it. Its findings reach the person only through you: pass them on in full, not cut down.`
  }
}

// The fan tool's answer: each part's agent, and how to start them all at once.
export const fanReply = (parts: readonly FanPart[]): string => {
  const apart = apartEdits(parts)
  const lanes = parts.some(p => p.resume)
  return [
    `gearbox fan-out: ${parts.length} independent parts, one agent each, running at the same time.`,
    ...parts.map(
      (p, i) =>
        `part ${i + 1}: ${p.what}: ${p.resume ? `SendMessage to "${p.resume}", the ${p.gear.model} lane that holds earlier work` : `model "${p.gear.model}"`}, gearbox runs it at ${p.gear.effort}; ${p.edits ? `edits files${apart ? ', isolation "worktree"' : ', in the working tree'}` : 'only reads'}.`,
    ),
    `Start all ${parts.length} in ONE message, now: ${PLAIN} per part with run_in_background false, the description "part N: ..." with its number, the model above${apart ? ' and isolation "worktree"' : ''}, and ${BRIEF}, for that part alone: say which files are its own and which the other parts are changing, and what to hand back.${lanes ? ' A part a lane takes goes to it by SendMessage, in that same message.' : ''} Do not start one and wait for it before the next.`,
    `Until all ${parts.length} have started, edits, commands and more reads are refused here. Then wait for every result, review and reconcile them${apart ? ', merge the worktree branches into the working tree (git merge or cherry-pick)' : ''}, and run the combined check (tests, build) here, or through a Haiku agent when it is a long command.`,
  ].join('\n')
}

// Two or more parts that edit files each work in a git worktree of their own, so the agents cannot collide.
export const apartEdits = (parts: readonly FanPart[]) => parts.filter(p => p.edits).length >= 2

// The fan-out: every part's agent starts in one message, so they run at the same time; gearbox sets each one's effort.
const fanNote = (parts: readonly FanPart[]): string => {
  const apart = apartEdits(parts)
  const back = (p: FanPart) =>
    p.edits
      ? `it makes the change, checks it, and hands back the files it changed${apart ? ', its worktree branch' : ''}, how it checked them and anything left open`
      : 'it hands back its findings in full'
  return [
    `gearbox handoff, fan-out: this request splits into ${parts.length} independent parts, which run at the same time, one agent each.`,
    `1. Start every part in ONE message, all at once: ${PLAIN} per part with run_in_background false, the description "part N: ..." with its number, its model, and ${BRIEF}, for that part alone: say which files are its own and which the other parts are changing, and what to hand back. Do not start one and wait for it before the next.${apart ? ' Each part that edits files starts with isolation "worktree", in a git worktree of its own, so the agents cannot collide.' : ''}`,
    ...parts.map(
      (p, i) =>
        `   ${i + 1}. ${p.what}: ${p.resume ? `send it with SendMessage to "${p.resume}", the ${p.gear.model} lane that already holds earlier work, in that same message (load SendMessage with ToolSearch first if it is not loaded)` : `model "${p.gear.model}"${p.edits && apart ? ', isolation "worktree"' : ''}`}; ${back(p)}.`,
    ),
    `2. gearbox sets each agent's effort. Until all ${parts.length} have started, edits, commands and more reads are refused here.`,
    `3. Wait for every result before going on. Then review each, and reconcile them: overlaps, contradictions, anything one part found that changes another.${apart ? ' Merge the worktree branches into the working tree (git merge or cherry-pick); a conflict that needs editing goes back to an agent.' : ''} Run the combined check (tests, build) here, or through a Haiku agent when it is a long command. Pass the findings on to the person in full, not cut down.`,
  ].join('\n')
}
