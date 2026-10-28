// The orchestrator: the main conversation only plans, briefs and reviews, and the work runs in lanes, one
// long-lived subagent per model. A lane starts at the top effort it will need and each message lowers it (bench/lanes:
// a mod's effort on a resumed agent reaches the API and keeps the cache; lowering takes hold fully, raising only half).
import type { ModelEffort } from 'claude-code'
import { EFFORTS, type FanPart, type Gear, MODELS as LADDER, type Model, type Part, type Plan, type Reading, RESUME_MS, RESUME_TOKENS, type Step, apartEdits, choreGear, gearFor, upFor, upTo } from './policy'

export type OrchestratorSettings = { orchestrator: boolean; orchestrator_model: 'haiku' | 'sonnet' | 'opus'; orchestrator_effort: ModelEffort; orchestrator_agents: number }

// What the main conversation runs on while the orchestrator is on, unless the person picks another.
export const ORCHESTRATOR: Gear = { model: 'sonnet', effort: 'medium' }
const MODELS = ['haiku', 'sonnet', 'opus'] as const
// How many agents a request may fan out to at once: 1 to 6, 3 unless the person picks another; 1 is no fan-out.
export const AGENTS = 3
const agentsFrom = (v: unknown): number => {
  const n = typeof v === 'string' && /^[1-6]$/.test(v.trim()) ? Number(v.trim()) : v
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 6 ? n : AGENTS
}

export const orchestratorFrom = (o: Record<string, unknown>): OrchestratorSettings => ({
  orchestrator: o.orchestrator === true,
  orchestrator_model: MODELS.includes(o.orchestrator_model as never) ? (o.orchestrator_model as OrchestratorSettings['orchestrator_model']) : ORCHESTRATOR.model as 'sonnet',
  orchestrator_effort: EFFORTS.includes(o.orchestrator_effort as ModelEffort) ? (o.orchestrator_effort as ModelEffort) : ORCHESTRATOR.effort,
  orchestrator_agents: agentsFrom(o.orchestrator_agents),
})

// One `/gearbox orchestrator[-model|-effort|-agents] <value>`; undefined when the word or the value is not one it takes.
export const orchestratorPatch = (word: string, value: string | undefined): Partial<OrchestratorSettings> | undefined => {
  if (word === 'orchestrator' && (value === 'on' || value === 'off')) return { orchestrator: value === 'on' }
  if (word === 'orchestrator-model' && MODELS.includes(value as never)) return { orchestrator_model: value as OrchestratorSettings['orchestrator_model'] }
  if (word === 'orchestrator-effort' && EFFORTS.includes(value as ModelEffort)) return { orchestrator_effort: value as ModelEffort }
  if (word === 'orchestrator-agents' && value !== undefined && /^[1-6]$/.test(value)) return { orchestrator_agents: Number(value) }
  return undefined
}

// The effort a lane is started at: the top it will need, so each job can lower it. A job that asks for max, or a max
// coding effort, starts the lane at max.
export const laneStart = (job: ModelEffort, standing: ModelEffort): ModelEffort => upTo(EFFORTS, standing === 'max' ? 'max' : 'xhigh', job)

// A lane: the agent that holds a model's work, with when its cache was last warmed and how big its context is.
export type Lane = { id: string; at: number; tokens: number }
export type Lanes = Partial<Record<Model, Lane>>
export const laneResumable = (l: Lane | undefined, now: number): l is Lane => l !== undefined && now - l.at < RESUME_MS && l.tokens < RESUME_TOKENS

// Which parts of a fan-out the lanes take. The first part of each model goes to that model's lane when it is worth
// going back to and idle (`resume`), or its agent becomes the lane when there is none worth going back to (`lane`);
// a busy lane keeps its work and its place. Other parts, and parts that edit in a worktree of their own, which would
// leave a lane apart from the working tree, are fresh agents for this turn only. `fresh`: unrelated work, which
// goes back to no lane. The part a nod goes back to is the first that a lane takes.
export const seatParts = (parts: readonly FanPart[], lanes: Lanes, now: number, busy: (id: string) => boolean, fresh = false): FanPart[] => {
  const apart = apartEdits(parts)
  const seated = new Set<Model>()
  return parts.map(p => {
    const m = p.gear.model
    if (seated.has(m) || (apart && p.edits)) return p
    seated.add(m)
    const lane = lanes[m]
    if (lane && busy(lane.id)) return p
    return laneResumable(lane, now) && !fresh ? { ...p, resume: lane.id } : { ...p, lane: true }
  })
}

// Fan-out: how many agents a request's parts go to, decided here from the survey's parts and never more of them.
// A path as compared: lower case, no leading "./" or trailing "/".
const norm = (f: string) => f.trim().toLowerCase().replace(/^\.\//, '').replace(/\/+$/, '')
// One path is the other or inside it: "src/api" holds "src/api/orders.ts".
const within = (a: string, b: string) => a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`)
// The folder a path's work sits in: a file's folder, or the path itself when it names no file.
const folder = (f: string) => (/\.[a-z0-9]+$/.test(f.split('/').pop() ?? '') ? f.split('/').slice(0, -1).join('/') : f)
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

// A part's gear, by the same rules as a request's: the model by the reach and care of the whole request, the effort
// by the part's own depth and kind, a review on at least Opus. Lookups and long commands run on Haiku at low. A part
// never runs on Fable: open-ended work is not split.
const partGear = (r: Reading, p: Part, standing: ModelEffort): Gear =>
  p.mode === 'wait' || p.mode === 'lookup'
    ? { model: 'haiku', effort: 'low' }
    : (g => ({ model: upFor(g), effort: g.effort }))(gearFor({ ...r, mode: p.mode, depth: p.depth, phases: [], parts: [] }, standing))
// A group's gear: the highest model and effort of its parts.
const groupGear = (r: Reading, g: Part[], standing: ModelEffort): Gear =>
  g.map(p => partGear(r, p, standing)).reduce((a, b) => ({ model: upTo(LADDER, a.model, b.model), effort: upTo(EFFORTS, a.effort, b.effort) }))

// The fan-out of a sure reading: each group as one part, on its gear.
export const fanParts = (r: Reading, cap: number, standing: ModelEffort): FanPart[] =>
  fanOut(r.parts, cap).map(g => ({ what: g.map(p => p.what).join('; '), gear: groupGear(r, g, standing), edits: edits(g) }))

// What the orchestrator keeps for itself: answers that need no deep look (one spot or one feature, ordinary care)
// and one-spot mechanical edits, never costly work. A guess is never handed off, a review excepted. A sure request of
// independent parts goes out to one agent per part, all at once, up to `cap` of them. Everything else goes to the lane
// of the model the work calls for, at the effort it calls for, reviews included, sure or not (an unsure review's
// effort is its best guess); Fable's open-ended work is a fresh agent, not a lane, and never split.
export const orchestratorPlan = (r: Reading, want: Gear, main: Gear, cap = 1, standing: ModelEffort = 'xhigh'): Plan => {
  if (!r.sure && r.mode !== 'review') return { main }
  const small = r.reach === 'point' || r.reach === 'area'
  const ordinary = r.care !== 'costly'
  if (ordinary && r.mode === 'answer' && r.depth <= 1 && small) return { main }
  if (ordinary && r.mode === 'code' && r.depth === 0 && r.reach === 'point') return { main }
  const fan = r.sure && want.model !== 'fable' ? fanParts(r, cap, standing) : []
  if (fan.length) return { main, handoff: { kind: 'fan', gear: fan[0]!.gear, parts: fan } }
  if (r.mode === 'wait') return { main, handoff: { kind: 'lane', gear: { model: 'haiku', effort: 'low' } } }
  if (r.mode === 'commit') return { main, handoff: { kind: 'lane', gear: choreGear(r.depth) } }
  return { main, handoff: { kind: want.model === 'fable' ? 'deep' : 'lane', gear: want } }
}

// A turn the orchestrator keeps still hands out its fetching, waiting and clicking: a sure reading of several steps,
// one of them a lookup, a long command or a browser check, becomes a route.
export const keepsRoute = (r: Reading, p: Plan): boolean =>
  !p.handoff && r.sure && r.phases.length >= 2 && r.phases.some(ph => ph.mode === 'lookup' || ph.mode === 'wait' || ph.mode === 'drive')
// The orchestrator does the route's other steps itself, at its own gear throughout: its effort does not follow the
// steps, and no step of work it kept goes up to a stronger model.
export const orchestratorRoute = (steps: Step[], main: Gear): Step[] =>
  steps.map(s => (s.by === 'main' ? { ...s, gear: main, mainEffort: main.effort } : { ...s, mainEffort: main.effort }))
