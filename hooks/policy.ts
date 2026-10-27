import type { ModelEffort } from 'claude-code'

export type Model = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Gear = { model: Model; effort: ModelEffort }

export const MODELS: readonly Model[] = ['haiku', 'sonnet', 'opus', 'fable']
export const EFFORTS: readonly ModelEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// The higher of two rungs on a ladder.
export const upTo = <T>(ladder: readonly T[], a: T, b: T): T => (ladder.indexOf(b) > ladder.indexOf(a) ? b : a)

export const label = (g: Gear) => `${g.model}·${g.effort}`

// Where a session lands when the survey has nothing usable and no earlier gear exists.
export const STARTER: Gear = { model: 'sonnet', effort: 'medium' }

// The survey describes a request; it never picks a model. The mapping from description to gear is code below.
export const SURVEY = `You describe a request that a person sent to a coding assistant. Do not answer or perform it.
The input is JSON: "request" is the new message, "earlier" lists the person's recent messages (may be empty), "previous" is how the last turn was run (may be null).
Reply with only a JSON object with these keys:
"reach": how much of the project the work must understand. "point": one spot (a question, a lookup, a rename, a one-line edit). "area": one feature or a few related files (build a feature, fix a contained bug, write tests, explain code). "system": many files, or a bug whose location is unknown. "frontier": open-ended (designing a system, research, inventing an algorithm).
"care": "costly" if a mistake could cost money or security or lose data (payments, billing, auth, permissions, secrets, deleting or migrating data), else "routine".
"depth": how much careful reasoning correctness needs. 0 mechanical, 1 ordinary, 2 subtle (concurrency, time zones, money arithmetic, cache or state invalidation, changing error or async behavior), 3 exceptionally hard.
"mode": what the turn will mostly do. "code": write or change code. "answer": explain, answer, review or plan without changing code. "drive": operate a browser or an app's UI to check behavior. "wait": run one long command and wait for it (build, deploy, publish, a full test run, a log search). Committing or pushing alone is "code".
"aside": true if "earlier" is about some piece of work and this request is a different, unrelated piece of work.
"cont": true if the request only continues, approves or repeats the previous turn.
"ask": the model ("haiku", "sonnet", "opus", "fable") and/or effort ("low", "medium", "high", "xhigh", "max") the person explicitly asks to use, as {"model":...} and/or {"effort":...}; {} if none. Words inside pasted code, logs or quotes are not asks.
"sure": false if the request is too vague to describe.`

export type Reading = {
  reach: 'point' | 'area' | 'system' | 'frontier'
  care: 'routine' | 'costly'
  depth: 0 | 1 | 2 | 3
  mode: 'code' | 'answer' | 'drive' | 'wait'
  aside: boolean
  cont: boolean
  ask: Partial<Gear>
  sure: boolean
}

const REACHES = ['point', 'area', 'system', 'frontier']
const MODES = ['code', 'answer', 'drive', 'wait']

// The survey's reply as a reading: undefined without a valid reach and depth; other keys fall back to plain values.
export const readReading = (reply: string): Reading | undefined => {
  let o: any
  try {
    o = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1))
  } catch {
    return undefined
  }
  if (!o || !REACHES.includes(o.reach) || ![0, 1, 2, 3].includes(o.depth)) return undefined
  const ask = o.ask && typeof o.ask === 'object' ? o.ask : {}
  return {
    reach: o.reach,
    care: o.care === 'costly' ? 'costly' : 'routine',
    depth: o.depth,
    mode: MODES.includes(o.mode) ? o.mode : 'code',
    aside: o.aside === true,
    cont: o.cont === true,
    ask: {
      ...(MODELS.includes(ask.model) ? { model: ask.model } : {}),
      ...(EFFORTS.includes(ask.effort) ? { effort: ask.effort } : {}),
    },
    sure: o.sure !== false,
  }
}

const REACH_MODEL: Record<Reading['reach'], Model> = { point: 'haiku', area: 'sonnet', system: 'opus', frontier: 'fable' }
const DEPTH_EFFORT: readonly ModelEffort[] = ['low', 'medium', 'high', 'xhigh'] // max only when asked for

// The gear a reading calls for. `standing` is the person's effort for ordinary coding (the code_effort setting):
// code turns never run below it past depth 0, answers follow depth alone. A costly mistake lifts the gear to at
// least opus·medium; the person's own ask wins.
export const gearFor = (r: Reading, standing: ModelEffort = 'medium'): Gear => {
  const costly = r.care === 'costly'
  const model = costly ? upTo(MODELS, REACH_MODEL[r.reach], 'opus') : REACH_MODEL[r.reach]
  const byDepth = DEPTH_EFFORT[r.depth]!
  const base = r.depth > 0 && r.mode !== 'answer' ? upTo(EFFORTS, byDepth, standing) : byDepth
  const effort = costly ? upTo(EFFORTS, base, 'medium') : base
  return { model: r.ask.model ?? model, effort: r.ask.effort ?? effort }
}

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
  ((g.effort === 'xhigh' || g.effort === 'max') && !ask.effort && previous?.effort !== g.effort && g.effort !== standing)

export const stepDown = (g: Gear): Gear => ({
  model: g.model === 'fable' ? 'opus' : g.model,
  effort: g.effort === 'xhigh' || g.effort === 'max' ? 'high' : g.effort,
})

export type Handoff = { kind: 'drive' | 'wait' | 'aside' | 'deep'; gear: Gear }
export type Plan = { main: Gear; handoff?: Handoff }

// Splits a turn between the main conversation and a subagent. `floor` is the main model so far;
// `hasEarlier` says whether there is earlier work for the request to be unrelated to. With `fixed`, the
// session keeps that model (steer mode): only effort and handoffs change.
export const plan = (r: Reading, want: Gear, floor: Model | undefined, hasEarlier: boolean, fixed?: Model): Plan => {
  const base = fixed ?? floor ?? 'sonnet'
  // On tool-heavy turns the main model only plans and judges; a costly target still gets opus for that.
  const planner = fixed ?? (r.care === 'costly' ? upTo(MODELS, base, 'opus') : base)
  if (r.mode === 'drive') return { main: { model: planner, effort: 'medium' }, handoff: { kind: 'drive', gear: { model: 'sonnet', effort: 'medium' } } }
  if (r.mode === 'wait') return { main: { model: planner, effort: 'low' }, handoff: { kind: 'wait', gear: { model: 'haiku', effort: 'low' } } }
  if (want.model === 'fable' && r.ask.model !== 'fable' && fixed !== 'fable') return { main: { model: base, effort: 'medium' }, handoff: { kind: 'deep', gear: want } }
  if (r.aside && hasEarlier && want.model !== 'haiku') return { main: { model: base, effort: 'medium' }, handoff: { kind: 'aside', gear: want } }
  return { main: fixed ? { model: fixed, effort: want.effort } : want }
}

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
export const handoffNote = ({ kind, gear }: Handoff): string => {
  const agent = `an Agent with model "${gear.model}"${kind === 'aside' || kind === 'deep' ? ` and effort "${gear.effort}"` : ''}`
  switch (kind) {
    case 'drive':
      return `gearbox handoff, browser check: keep the clicking and screenshots out of this conversation.
1. Write the check here: where to go, what to do, and what each step should show.
2. Start ${agent} with that checklist. It must not edit files, and it answers step by step: pass or fail, what it saw, console errors.
3. Read its answer and decide here what is broken and how to fix it.`
    case 'wait':
      return `gearbox handoff, long command: keep its output out of this conversation.
1. Settle the exact command and the directory it runs in here.
2. Start ${agent} to run only that, wait until it ends, and answer with: passed or failed, the lines that explain a failure, and any link or id it printed.
3. If it failed, investigate here.`
    case 'aside':
      return `gearbox handoff, side task: this looks unrelated to the work so far. If it needs more than a quick edit, start ${agent} with a brief that stands on its own: where the project is, what to achieve, the limits, how to check the result, and anything decided here that applies. Send follow-ups to that same agent with SendMessage. If it turns out to be a quick edit, or part of the earlier work after all, do it here.`
    case 'deep':
      return `gearbox handoff, deep work: start ${agent} with a brief that stands on its own: where the project is, the goal, the limits, what is already decided here, and what to hand back. Send follow-ups to that same agent with SendMessage, and review what it returns here before acting on it.`
  }
}
