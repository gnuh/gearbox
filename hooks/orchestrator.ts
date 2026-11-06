// The orchestrator: the main conversation only plans, briefs and reviews, and the work runs in lanes, one
// long-lived subagent per model. A lane starts at the top effort it will need and each message lowers it (bench/lanes:
// a mod's effort on a resumed agent reaches the API and keeps the cache; lowering takes hold fully, raising only half).
import type { ModelEffort } from 'claude-code'
import type { GearboxLoop } from '../types'
import { family, isQueued, live } from './loops'
import { BRIEFING, EFFORTS, type FanPart, type Gear, type Handoff, MODELS as LADDER, type Model, type Part, type Plan, type Reading, RESUME_MS, RESUME_TOKENS, type Step, apartEdits, capXhigh, choreGear, driveHandoff, filesReach as scope, gearFor, mechanical, normPath as norm, pathFolder as folder, pins, staysPut, upFor, upTo } from './policy'

// The orchestrator's effort: a level, or `auto`, which sets the main conversation's effort per prompt (see orchestratorPlan).
export type OrchestratorEffort = ModelEffort | 'auto'
export const ORCHESTRATOR_EFFORTS: readonly OrchestratorEffort[] = ['auto', 'low', 'medium', 'high', 'xhigh']
// `on` orchestrates every session; `auto` is on, except in a session on Haiku, which keeps shifting models (see
// orchestratorOn); `off` turns it off.
export type OrchestratorMode = 'auto' | 'on' | 'off'
export const ORCHESTRATOR_MODES: readonly OrchestratorMode[] = ['auto', 'on', 'off']
export type OrchestratorSettings = { orchestrator: OrchestratorMode; orchestrator_model: 'haiku' | 'sonnet' | 'opus'; orchestrator_effort: OrchestratorEffort; orchestrator_agents: number }

// The orchestrator is on, in every session, Haiku ones included, unless the person turns it off or picks `auto`
// (see orchestratorOn), and the main conversation then runs on Opus at `auto` effort, unless the person picks another.
export const ORCHESTRATOR: { mode: OrchestratorMode; model: 'opus'; effort: OrchestratorEffort } = { mode: 'on', model: 'opus', effort: 'auto' }
const MODELS = ['haiku', 'sonnet', 'opus'] as const
// How many agents a request may fan out to at once: 1 to 6, 6 unless the person picks another; 1 is no fan-out.
export const AGENTS = 6
const agentsFrom = (v: unknown): number => {
  const n = typeof v === 'string' && /^[1-6]$/.test(v.trim()) ? Number(v.trim()) : v
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 6 ? n : AGENTS
}

// What /gearbox stored for the orchestrator, or the plugin option says: on, off or auto (a boolean is what an older
// version stored, and what the manifest's option is: true is on, false is off). The manifest's default, true, is the
// default mode, `on`, so Claude Code passing it in changes nothing; an `auto` is always the person's word, and nothing
// reads it as unset.
const modeOf = (v: unknown): OrchestratorMode | undefined => (v === true ? 'on' : v === false ? 'off' : ORCHESTRATOR_MODES.includes(v as OrchestratorMode) ? (v as OrchestratorMode) : undefined)

// Whether the orchestrator runs the main conversation: with `on` (the default) in every session, and with `auto` unless
// the session is on Haiku, whose person started there to shift models cheaply.
export const orchestratorOn = (mode: OrchestratorMode, haiku: boolean): boolean => mode === 'on' || (mode === 'auto' && !haiku)

// `options` are the plugin's, `stored` what /gearbox stored, which wins.
export const orchestratorFrom = (options: Record<string, unknown>, stored: Record<string, unknown> = {}): OrchestratorSettings => orchestratorOf({ ...options, ...stored }, modeOf(stored.orchestrator) ?? modeOf(options.orchestrator) ?? ORCHESTRATOR.mode)
const orchestratorOf = (o: Record<string, unknown>, mode: OrchestratorMode): OrchestratorSettings => ({
  orchestrator: mode,
  orchestrator_model: MODELS.includes(o.orchestrator_model as never) ? (o.orchestrator_model as OrchestratorSettings['orchestrator_model']) : ORCHESTRATOR.model,
  orchestrator_effort: ORCHESTRATOR_EFFORTS.includes(o.orchestrator_effort as OrchestratorEffort) ? (o.orchestrator_effort as OrchestratorEffort) : o.orchestrator_effort === 'max' ? 'xhigh' : ORCHESTRATOR.effort,
  orchestrator_agents: agentsFrom(o.orchestrator_agents),
})

// One `/gearbox orchestrator[-model|-effort|-agents] <value>`; undefined when the word or the value is not one it takes.
export const orchestratorPatch = (word: string, value: string | undefined): Partial<OrchestratorSettings> | undefined => {
  if (word === 'orchestrator' && ORCHESTRATOR_MODES.includes(value as OrchestratorMode)) return { orchestrator: value as OrchestratorMode }
  if (word === 'orchestrator-model' && MODELS.includes(value as never)) return { orchestrator_model: value as OrchestratorSettings['orchestrator_model'] }
  if (word === 'orchestrator-effort' && ORCHESTRATOR_EFFORTS.includes(value as OrchestratorEffort)) return { orchestrator_effort: value as OrchestratorEffort }
  if (word === 'orchestrator-agents' && value !== undefined && /^[1-6]$/.test(value)) return { orchestrator_agents: Number(value) }
  return undefined
}

// The effort a lane is started at: the top it will need, so each job can lower it. A job that asks for max starts the
// lane at max.
export const laneStart = (job: ModelEffort): ModelEffort => upTo(EFFORTS, 'xhigh', job)

// A lane: the agent that holds a model's work, with when its cache was last warmed and how big its context is.
export type Lane = { id: string; at: number; tokens: number }
export type Lanes = Partial<Record<Model, Lane>>
export const laneResumable = (l: Lane | undefined, now: number): l is Lane => l !== undefined && now - l.at < RESUME_MS && l.tokens < RESUME_TOKENS

// The lanes a session had, read back from the readout's record, which a plugin reload keeps while the lanes (in memory)
// are lost: per model, the newest agent the main conversation started that is not a skill's fork, a refused or stopped
// row, a part in a worktree of its own or Fable's. Its cache is as warm as its last activity (now, for an agent at
// work); its context is not recorded, so it counts as small.
export const lanesFrom = (loops: Record<string, GearboxLoop>, now: number): Lanes => {
  const lanes: Lanes = {}
  const at = (l: GearboxLoop) => (live(l) ? now : l.endedAt ?? l.since ?? 0)
  const rows = Object.entries(loops)
    .filter(([id, l]) => id !== 'main' && !isQueued(id) && l.parent === 'main' && !l.failed && !l.stopping && !l.worktree && !l.label.startsWith('/'))
    .sort(([, a], [, b]) => at(a) - at(b))
  for (const [id, l] of rows) {
    const model = family(l.asked)
    if (model && model !== 'fable') lanes[model] = { id, at: at(l), tokens: 0 }
  }
  return lanes
}

// Which parts of a fan-out the lanes take. The first part of each model goes to that model's lane when it is worth
// going back to and idle (`resume`), or its agent becomes the lane when there is none worth going back to (`lane`);
// a busy lane keeps its work and its place. Other parts, and parts that edit in a worktree of their own, which would
// leave a lane apart from the working tree, are fresh agents for this turn only. `fresh`: unrelated work, which
// goes back to no lane. The part a nod goes back to is the first that a lane takes.
// A part on Fable (code on a Fable coding model) is a fresh agent too: Fable's work is never a lane.
export const seatParts = (parts: readonly FanPart[], lanes: Lanes, now: number, busy: (id: string) => boolean, fresh = false): FanPart[] => {
  const apart = apartEdits(parts)
  const seated = new Set<Model>()
  return parts.map(p => {
    const m = p.gear.model
    if (m === 'fable' || seated.has(m) || (apart && p.edits)) return p
    seated.add(m)
    const lane = lanes[m]
    if (lane && busy(lane.id)) return p
    return laneResumable(lane, now) && !fresh ? { ...p, resume: lane.id } : { ...p, lane: true }
  })
}

// The part of a fan-out an Agent call is for: the one its description numbers ("part 2: ..."), else the first not
// started that no lane takes, else any not started; -1 when every part has started. `handed`: the parts started.
export const fanSlot = (parts: readonly FanPart[], handed: ReadonlySet<number>, description?: string): number => {
  const open = (k: number) => k >= 0 && k < parts.length && !handed.has(k)
  const named = Number(/^\s*part\s+(\d)\b/i.exec(description ?? '')?.[1] ?? 0) - 1
  const first = parts.findIndex((p, k) => open(k) && !p.resume)
  return open(named) ? named : first >= 0 ? first : parts.findIndex((_, k) => open(k))
}

// Fan-out: how many agents a request's parts go to, decided here from the survey's parts and never more of them.
// Paths are compared as `norm` gives them; `folder` is the folder a path's work sits in.
// One path is the other or inside it: "src/api" holds "src/api/orders.ts".
const within = (a: string, b: string) => a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`)
const files = (g: Part[]) => g.flatMap(p => p.files.map(norm))
const edits = (g: Part[]) => g.some(p => p.mode === 'code')
const deepest = (g: Part[]) => Math.max(...g.map(p => p.depth))
const kind = (g: Part[]): Part['mode'] => (edits(g) ? 'code' : g.find(p => p.mode === 'review')?.mode ?? g[0]!.mode)
// Two parts collide when one edits files the other touches, or both edit code in one folder; code that names no
// files may be anywhere. Parts that only read may share files: reviews of one change by angle still split.
const collide = (g: Part[], h: Part[]) => {
  if (!edits(g) && !edits(h)) return false
  const [a, b] = [files(g), files(h)]
  if (a.some(x => b.some(y => within(x, y)))) return true
  if (!edits(g) || !edits(h)) return false
  return !a.length || !b.length || a.some(x => b.some(y => within(folder(x), folder(y))))
}

// The survey's parts as agents, in groups of parts one agent takes: none when fewer than two are left, or with a
// cap under two. A depth-0 part is not worth an agent: it joins the part that touches its files, else its
// neighbour. Parts that collide are one agent, so editing agents never meet. Past the cap, the lightest part joins
// the one most like it (the same kind of work, else the one before it), until the cap holds.
export const fanOut = (parts: readonly Part[], cap: number): Part[][] => {
  if (cap < 2 || parts.filter(p => p.depth > 0).length < 2) return []
  const own = new Map<Part, Part[]>(parts.filter(p => p.depth > 0).map(p => [p, [p]]))
  const groups = [...own.values()]
  parts.forEach((p, i) => {
    if (p.depth > 0) return
    const before = parts.slice(0, i).reverse().find(q => q.depth > 0)
    const after = parts.slice(i + 1).find(q => q.depth > 0)
    const host = groups.find(g => files(g).some(x => p.files.some(y => within(x, norm(y))))) ?? own.get((before ?? after)!)!
    host.push(p)
  })
  const merge = (into: number, from: number) => {
    groups[into]!.push(...groups[from]!)
    groups.splice(from, 1)
  }
  const settle = () => {
    for (let changed = true; changed; ) {
      changed = false
      for (let i = 0; i < groups.length && !changed; i++)
        for (let j = i + 1; j < groups.length && !changed; j++)
          if (collide(groups[i]!, groups[j]!)) {
            merge(i, j)
            changed = true
          }
    }
  }
  settle()
  while (groups.length > cap) {
    const light = groups.reduce((k, g, i) => (deepest(g) <= deepest(groups[k]!) ? i : k), 0)
    const like = groups.findLastIndex((g, i) => i !== light && kind(g) === kind(groups[light]!))
    merge(like >= 0 ? like : light > 0 ? light - 1 : 1, light)
    settle()
  }
  return groups.length >= 2 ? groups : []
}

// Why parts do not split, in the person's terms; undefined when they do.
export const whyNoFan = (parts: readonly Part[], cap: number): string | undefined => {
  if (fanOut(parts, cap).length) return undefined
  if (parts.length < 2) return 'fewer than two parts'
  if (cap < 2) return 'orchestrator-agents is 1, so one agent at a time'
  if (parts.filter(p => p.depth > 0).length < 2) return 'fewer than two parts need real work: a depth-0 part is not worth an agent of its own'
  return 'the parts edit the same files, or code in one folder (or code that names no files), so one agent takes them all'
}

// The reading parts the main conversation names split on when its turn has none (a nod whose work could not be read,
// an unreadable prompt):
// ordinary reach and care, so each part's gear comes from its own kind and depth.
export const NEUTRAL: Reading = { reach: 'area', care: 'routine', depth: 1, mode: 'answer', aside: false, ahead: false, cont: false, ask: {}, sure: true, phases: [], parts: [] }

// A part's reach, from the files it names (`scope`, the rule in policy's filesReach), not the whole request's. A part
// that names no files takes the request's reach.
const REACHES: readonly Reading['reach'][] = ['point', 'area', 'system', 'frontier']
// A group's reach: the union of its files', never below any of its parts' own.
const groupReach = (r: Reading, g: Part[]): Reading['reach'] =>
  [scope(files(g)) ?? r.reach, ...g.map(p => scope(p.files) ?? r.reach)].reduce((a, b) => upTo(REACHES, a, b))

// A part's gear, by the same rules as a request's on its own reach: the model by that reach and the request's care,
// the effort by the part's own depth and kind, a review on at least Opus, and real work (depth 1 and up) never below
// Sonnet. The person's ask wins. Lookups and long commands run on Haiku at low. A part never runs on Fable (open-ended
// work is not split), save code on a Fable coding model: `code`, the model the person fixed for code, which a code
// part runs on exactly.
const partGear = (r: Reading, p: Part, reach: Reading['reach'], standing: ModelEffort, code?: Model): Gear => {
  if (p.mode === 'wait' || p.mode === 'lookup') return { model: 'haiku', effort: 'low' }
  const g = gearFor({ ...r, reach, mode: p.mode, depth: p.depth, ask: {}, phases: [], parts: [] }, standing)
  const effort = r.ask.effort ?? g.effort
  if (p.mode === 'code' && code && !r.ask.model) return { model: code, effort }
  const model = r.ask.model ?? (p.depth > 0 ? upTo(LADDER, g.model, 'sonnet') : g.model)
  return { model: upFor({ model, effort: g.effort }), effort }
}
// A group's gear: the highest model and effort of its parts, on the group's reach. Code merged with a review runs on
// the higher of the two, since a review is never below Opus.
const groupGear = (r: Reading, g: Part[], standing: ModelEffort, code?: Model): Gear => {
  const reach = groupReach(r, g)
  return g.map(p => partGear(r, p, reach, standing, code)).reduce((a, b) => ({ model: upTo(LADDER, a.model, b.model), effort: upTo(EFFORTS, a.effort, b.effort) }))
}

// The fan-out of a sure reading: each group as one part, on its gear. A group with a review says so: whatever model its
// call names, it never runs below Opus.
export const fanParts = (r: Reading, cap: number, standing: ModelEffort, code?: Model): FanPart[] =>
  fanOut(r.parts, cap).map(g => ({ what: g.map(p => p.what).join('; '), gear: groupGear(r, g, standing, code), edits: edits(g), ...(g.some(p => p.mode === 'review') ? { review: true } : {}) }))

// What the orchestrator keeps for itself: answers that need no deep look (one spot or one feature, ordinary care)
// and small code (one spot or one feature, mechanical or ordinary depth) the work calls for no stronger model than
// its own for, never costly work: a hand-off's brief, start and relay cost more than such work does. Code that
// needs smarter decisions still goes to its lane. A guess is never handed off, a review excepted. A sure request of
// independent parts goes out to one agent per part, all at once, up to `cap` of them. Everything else goes to the lane
// of the model the work calls for, at the effort it calls for, reviews included, sure or not (an unsure review's
// effort is its best guess); Fable's open-ended work is a fresh agent, not a lane, and never split. `code`: the model
// the person fixed for code (`want` is on it already): small code stays here only on that very model, or when it is a
// mechanical edit at one spot, else it goes to that model's lane (on Fable, a fresh agent), and each code part of a
// fan-out runs on it. `auto`: the orchestrator's effort is set per turn, not pinned (the plan's `main` carries it): what
// it keeps runs at the rules' effort for the reading (`want`), xhigh at most; a hand-off at BRIEFING, since briefing
// and later choosing the agent's effort is where it is won or lost, save a lane that only relays a command (a long
// command, a git chore), which runs low. `advice`: the coding effort is `auto`, so the hand-off is advice, and none is
// given for what stays put (staysPut): an answer at depth 0 or 1 of any reach or care, and any guess, a review's included.
// A browser check is no lane's: as in steer mode, the navigator (`navigator`) clicks and the orchestrator, a different
// model, judges the evidence at medium (a stronger model's subagent, when the check calls for one; see driveHandoff).
// Before 0.23.2 it fell through to a lane on the work's model, which navigated and judged its own clicks. A long
// command and a git chore still go to the lane that only relays them, marked `relay`: never advice, and the command
// itself is held to it.
export const orchestratorPlan = (r: Reading, want: Gear, main: Gear, cap = 1, standing: ModelEffort = 'xhigh', code?: Model, auto = false, advice = false, navigator: Model = 'sonnet'): Plan => {
  const keep = (): Plan => ({ main: auto ? { ...main, effort: capXhigh(want.effort) } : main })
  const hand = (handoff: Handoff, relay = false): Plan => ({ main: auto ? { ...main, effort: relay ? 'low' : BRIEFING } : main, handoff })
  if ((!r.sure && r.mode !== 'review') || (advice && staysPut(r))) return keep()
  if (r.mode === 'drive') return { main: auto ? { ...main, effort: 'medium' } : main, handoff: driveHandoff(r, want, main.model, navigator) }
  const small = r.reach === 'point' || r.reach === 'area'
  const ordinary = r.care !== 'costly'
  const pinned = pins(r, code)
  if (ordinary && r.mode === 'answer' && r.depth <= 1 && small) return keep()
  const open = want.model === 'fable' && (!pinned || r.reach === 'frontier')
  const fan = r.sure && !open ? fanParts(r, cap, standing, code) : []
  if (fan.length) return hand({ kind: 'fan', gear: fan[0]!.gear, parts: fan })
  const enough = pinned ? want.model === main.model || mechanical(r) : LADDER.indexOf(want.model) <= LADDER.indexOf(main.model)
  if (ordinary && r.mode === 'code' && r.depth <= 1 && small && enough) return keep()
  if (r.mode === 'wait') return hand({ kind: 'lane', gear: { model: 'haiku', effort: 'low' }, relay: 'wait' }, true)
  if (r.mode === 'commit') return hand({ kind: 'lane', gear: choreGear(r.depth), relay: 'chore' }, true)
  return hand({ kind: want.model === 'fable' ? 'deep' : 'lane', gear: want })
}

// A turn the orchestrator keeps still hands out its fetching, waiting and clicking: a sure reading of several steps,
// one of them a lookup, a long command or a browser check, becomes a route.
export const keepsRoute = (r: Reading, p: Plan): boolean =>
  !p.handoff && r.sure && r.phases.length >= 2 && r.phases.some(ph => ph.mode === 'lookup' || ph.mode === 'wait' || ph.mode === 'drive')
// The orchestrator does the route's other steps itself, at its own gear throughout: its effort does not follow the
// steps, and no step of work it kept goes up to a stronger model. `follow` (`auto`, no effort asked for): its effort
// follows each step's, as in steer mode, xhigh at most.
export const orchestratorRoute = (steps: Step[], main: Gear, follow = false): Step[] =>
  follow
    ? steps.map(s => ({ ...s, ...(s.by === 'main' ? { gear: { ...s.gear, effort: capXhigh(s.gear.effort) } } : {}), mainEffort: capXhigh(s.mainEffort) }))
    : steps.map(s => (s.by === 'main' ? { ...s, gear: main, mainEffort: main.effort } : { ...s, mainEffort: main.effort }))
