import type { ModelEffort } from 'claude-code'
import { fanOut, whyNoFan } from './orchestrator'
import { type Gear, type Part, type Reading, needsConsent, stepDown } from './policy'

// Agents of agents: what an agent the main conversation started may start, one level deep. The rules live here and are
// pure; register.tsx holds the state they need (the agents running, the fan-outs declared) and does the starting.
//
//   - an agent that reads (Explore, Plan) starts on Sonnet at low effort, Haiku when it asks;
//   - the independent pieces of its own work start as a fan-out it declares with the fan tool, by the rules the main
//     conversation's fan-out follows, on the cap the agents already running leave;
//   - any other agent starts by what its brief reads as (the Haiku read the main conversation's plain agents get): work
//     that is not code, a long command, and one plain agent at a time that writes code;
//   - a browser check, a git chore, a brief that cannot be read, a typed agent that writes code and a second writer
//     beside a running one are refused, and an agent started by one of these starts nothing.

export const READERS = /^(Explore|Plan)$/

export const readerGear = (model: unknown): Gear => ({ model: model === 'haiku' ? 'haiku' : 'sonnet', effort: 'low' })

// How many agents an agent may split into now: orchestrator-agents less the agents running (the caller among them) and
// the parts promised (fan-outs declared whose agents have not started), never below zero.
export const nestedCap = (agents: number, running: number, promised: number): number => Math.max(0, agents - running - promised)

// Why parts do not split here; undefined when they do. `taken`: the agents running or promised.
export const whyNoNestedFan = (parts: readonly Part[], cap: number, agents: number, taken: number): string | undefined => {
  if (fanOut(parts, cap).length) return undefined
  if (parts.length >= 2 && cap < 2) return `orchestrator-agents is ${agents} and ${taken} agents are running or promised, so there is room for ${cap} more`
  return whyNoFan(parts, cap)
}

// Nothing nested asks the person, who is not at hand: what the main conversation would put to them (Fable, an effort above
// their coding effort `standing`) steps down, unless it is the model they fixed for code (`pinned`).
export const settle = (g: Gear, pinned: boolean, standing: ModelEffort): Gear => {
  const down = stepDown(g)
  return {
    model: needsConsent({ model: g.model, effort: 'low' }, pinned ? { model: g.model } : {}, undefined, standing) ? down.model : g.model,
    effort: needsConsent({ model: 'sonnet', effort: g.effort }, {}, undefined, standing) ? down.effort : g.effort,
  }
}

export type Refusal = 'depth' | 'typed' | 'writer' | 'unread' | 'other'
// What an agent is told when the agent it asked for is not started (gearbox: prefixes it).
export const REFUSED: Record<Refusal, string> = {
  depth: 'an agent started by another agent cannot start agents of its own. Do this work yourself.',
  typed: 'an agent that writes code is started as a plain Agent (no subagent_type), so gearbox can set its gear and follow its files. Start it that way, or make the change yourself.',
  writer: 'another agent of yours that writes code is still running in the working tree, and a second would edit it at the same time. Wait for it to end, or name the independent pieces with mcp__gearbox__fan first, so each works in a worktree of its own.',
  unread: 'gearbox could not tell what this agent is for (its brief did not read), so it did not start it. Do the work yourself, or say in the brief what the agent does and call again.',
  other: 'a browser check or a git chore is not work an agent hands to another agent; do it yourself.',
}

// What the fan tool tells an agent it will not split for.
export const SPLIT = {
  off: 'the orchestrator is off, so gearbox splits nothing here: start agents only to read or for work that is not code, and do the rest yourself.',
  fork: 'only the main conversation and the agents it started split work; carry on with your own brief.',
  writing: 'an agent of yours that writes code is still running in the working tree, so pieces that write code wait for it to end. Pieces that only read can be split now.',
}

// A brief as the Haiku read gave it: what it does and the gear the rules give that work. `pinned`: the gear's model is
// the coding model the person fixed.
export type BriefRead = { mode: Reading['mode']; gear: Gear; pinned: boolean }
export type Verdict = { gear: Gear; writes: boolean; reviews: boolean } | { refusal: Refusal }

// Whether an agent a depth-1 agent asks for starts, and on what gear, by what its brief reads as. `plain`: the call
// names no agent type. A second writer is not judged here: that depends on who is running.
export const briefVerdict = (read: BriefRead | undefined, o: { plain: boolean; standing: ModelEffort }): Verdict => {
  if (!read) return { refusal: 'unread' }
  if (read.mode === 'drive' || read.mode === 'commit') return { refusal: 'other' }
  if (read.mode === 'wait') return { gear: { model: 'haiku', effort: 'low' }, writes: false, reviews: false }
  const writes = read.mode === 'code'
  if (writes && !o.plain) return { refusal: 'typed' }
  return { gear: settle(read.gear, writes && read.pinned, o.standing), writes, reviews: read.mode === 'review' }
}
