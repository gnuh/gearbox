import type { GearboxLoop } from '../types'
import { isQueued, labelOf, live, treeOf } from './loops'

// Stopping agents one by one. The pure half: which agents can be stopped, which others stop with them (the agents they
// started, however deep, by the parent links of the loops), which agent a typed word means, and the words a stopped agent
// is told. What reaches the engine (TaskStop, the soft stop) is in register.tsx.

// An agent that can be stopped: a real agent (not main, not a fan-out part still queued) at work or waiting on its own work.
// One that is done or was refused has nothing left to stop.
export const stoppable = (id: string, l: GearboxLoop | undefined): boolean => id !== 'main' && !isQueued(id) && live(l)

// The agents at work, in the order they nest (each under the one that started it), by id.
export const stoppableIds = (loops: Record<string, GearboxLoop>): string[] => treeOf(loops, (id, l) => stoppable(id, l)).map(n => n.id)

// Every agent `id` started, however deep, nearest first: the loops whose parent is it, then theirs. Only those at work.
export const startedBy = (loops: Record<string, GearboxLoop>, id: string): string[] => {
  const out: string[] = []
  const seen = new Set([id])
  let level = [id]
  while (level.length) {
    level = Object.entries(loops)
      .filter(([k, l]) => !seen.has(k) && l.parent !== undefined && level.includes(l.parent))
      .map(([k]) => k)
    for (const k of level) seen.add(k)
    out.push(...level.filter(k => stoppable(k, loops[k])))
  }
  return out
}

// One stop to carry out: the agent, the agents stopped with it (`cascade`, for the log) and, for one of those, the agent
// whose stop it came with (`by`).
export type StopStep = { id: string; cascade: string[]; by?: string }

// The stops of `ids` and of everything they started, each agent once, an agent before the agents it started (so it can
// start no more while they are stopped). An id that cannot be stopped is left out, and so is an agent already being
// stopped (`stopping`): a second press or `/gearbox stop all` does not call TaskStop on it again.
export const stopPlan = (loops: Record<string, GearboxLoop>, ids: readonly string[]): StopStep[] => {
  const out: StopStep[] = []
  const planned = new Set<string>()
  const pending = (k: string) => !planned.has(k) && !loops[k]?.stopping
  for (const id of ids) {
    if (!pending(id) || !stoppable(id, loops[id])) continue
    const cascade = startedBy(loops, id).filter(pending)
    out.push({ id, cascade })
    planned.add(id)
    for (const k of cascade) {
      out.push({ id: k, cascade: [], by: id })
      planned.add(k)
    }
  }
  return out
}

// An agent as a person reads it: "part 1 · customers (a1b2c3)".
export const agentName = (loops: Record<string, GearboxLoop>, id: string): string => `${loops[id] ? labelOf(loops[id]) : id} (${id})`

// The agents at work that `word` names: an id or label exactly, else every one whose id or label begins with it (case
// ignored). Several come back when it is ambiguous; none when it names no agent at work.
export const findAgents = (loops: Record<string, GearboxLoop>, word: string): string[] => {
  const want = word.trim().toLowerCase()
  if (!want) return []
  const names = (id: string) => [id, loops[id]!.label, labelOf(loops[id]!)].map(s => s.toLowerCase())
  const ids = stoppableIds(loops)
  const exact = ids.filter(id => names(id).includes(want))
  return exact.length ? exact : ids.filter(id => names(id).some(n => n.startsWith(want)))
}

// What a stopped agent that gearbox ends itself (the engine's TaskStop was out of reach) is told when it calls a tool, and
// what its end of turn says to the agent that started it.
export const STOP_DENIED = 'gearbox: the person stopped this agent. It makes no more tool calls.'
export const STOP_ANSWER = 'The person stopped this agent from gearbox before it finished, so its work is incomplete. Do not start it again unless the person asks.'

// How long an agent gets, after the engine's TaskStop said yes, to show up as ended before gearbox stops it itself.
export const STOP_GRACE_MS = 10_000
