import { expect, test } from 'claude-code/testing'
import { NEUTRAL, ORCHESTRATOR, ORCHESTRATOR_EFFORTS, fanOut, fanParts, fanSlot, keepsRoute, laneResumable, laneStart, lanesFrom, orchestratorFrom, orchestratorOn, orchestratorPatch, orchestratorPlan, orchestratorRoute, seatParts, whyNoFan } from './orchestrator'
import { RESUME_MS, RESUME_TOKENS, type FanPart, type Gear, type Part, type Phase, type Reading, gearFor, handoffNote, label, plan, route, routeNote } from './policy'

const reading = (r: Partial<Reading> = {}): Reading => ({ reach: 'area', care: 'routine', depth: 1, mode: 'code', aside: false, ahead: false, cont: false, ask: {}, sure: true, phases: [], parts: [], ...r })
// A pinned orchestrator effort; `auto` is the default.
const MAIN: Gear = { model: 'sonnet', effort: 'medium' }
const part = (what: string, mode: Part['mode'], depth: Part['depth'], files: string[] = []): Part => ({ what, mode, depth, files })
const whats = (groups: Part[][]) => groups.map(g => g.map(p => p.what))

test('a new install has the orchestrator on, at an effort of auto, with up to 6 agents, and no model of its own', () => {
  expect(orchestratorFrom({})).toEqual({ orchestrator: 'on', orchestrator_effort: 'auto', orchestrator_agents: 6 })
  expect(ORCHESTRATOR).toEqual({ mode: 'on', effort: 'auto' })
  expect(ORCHESTRATOR_EFFORTS).toEqual(['auto', 'low', 'medium', 'high', 'xhigh'])
  // What the person set stays: off, another effort, another number of agents.
  expect(orchestratorFrom({}, { orchestrator: 'on', orchestrator_effort: 'high' })).toEqual({ orchestrator: 'on', orchestrator_effort: 'high', orchestrator_agents: 6 })
  expect(orchestratorFrom({ orchestrator_agents: 2 }, { orchestrator: 'off' })).toEqual({ orchestrator: 'off', orchestrator_effort: 'auto', orchestrator_agents: 2 })
  // The orchestrator_model an older version kept (plugin option or stored) is ignored, whatever it says.
  for (const model of ['haiku', 'sonnet', 'opus', 'fable', 'gpt', 42]) {
    expect(orchestratorFrom({ orchestrator_model: model }, { orchestrator_model: model, orchestrator: 'off' })).toEqual({ orchestrator: 'off', orchestrator_effort: 'auto', orchestrator_agents: 6 })
    expect('orchestrator_model' in orchestratorFrom({ orchestrator_model: model }, { orchestrator_model: model })).toBe(false)
  }
  // The plugin option is a boolean with a default of true, which Claude Code passes in: true is on, the default mode,
  // and false is off. What /gearbox stored is the person's, and wins: on, off or auto (never read as unset), or the
  // boolean an older version stored (true is on, false is off).
  expect(orchestratorFrom({ orchestrator: true }).orchestrator).toBe('on')
  expect(orchestratorFrom({ orchestrator: false }).orchestrator).toBe('off')
  expect(orchestratorFrom({ orchestrator: false }, { orchestrator: 'on' }).orchestrator).toBe('on')
  expect(orchestratorFrom({ orchestrator: false }, { orchestrator: 'auto' }).orchestrator).toBe('auto')
  expect(orchestratorFrom({ orchestrator: true }, { orchestrator: 'auto' }).orchestrator).toBe('auto') // the default is on, so a stored auto is told apart from it
  expect(orchestratorFrom({}, { orchestrator: 'auto' }).orchestrator).toBe('auto')
  expect(orchestratorFrom({ orchestrator: true }, { orchestrator: true }).orchestrator).toBe('on')
  expect(orchestratorFrom({ orchestrator: true }, { orchestrator: false }).orchestrator).toBe('off')
  // Values it does not take fall back to the defaults.
  expect(orchestratorFrom({ orchestrator: 'yes', orchestrator_effort: 'huge' }, { orchestrator: 'sometimes' })).toEqual({ orchestrator: 'on', orchestrator_effort: 'auto', orchestrator_agents: 6 })
  // max is no longer offered: a stored or plugin max is xhigh.
  expect(orchestratorFrom({ orchestrator_effort: 'max' }).orchestrator_effort).toBe('xhigh')
})

test('the orchestrator runs when set on, Haiku sessions included, and on auto unless the session is on Haiku, which shifts models', () => {
  expect(orchestratorOn('on', false)).toBe(true)
  expect(orchestratorOn('on', true)).toBe(true) // the default, a Haiku session included
  expect(orchestratorOn('auto', false)).toBe(true)
  expect(orchestratorOn('auto', true)).toBe(false)
  expect(orchestratorOn('off', false)).toBe(false)
  expect(orchestratorOn('off', true)).toBe(false)
})

test('the orchestrator starts up to 6 agents at once unless the person picks 1 to 6; 1 turns fan-out off', () => {
  expect(orchestratorFrom({}).orchestrator_agents).toBe(6)
  expect(orchestratorFrom({ orchestrator_agents: 5 }).orchestrator_agents).toBe(5)
  expect(orchestratorFrom({ orchestrator_agents: 1 }).orchestrator_agents).toBe(1)
  // A value kept as text, as a settings screen may store it.
  expect(orchestratorFrom({ orchestrator_agents: '2' }).orchestrator_agents).toBe(2)
  for (const bad of [0, 7, 2.5, 'many', true, '']) expect(orchestratorFrom({ orchestrator_agents: bad }).orchestrator_agents).toBe(6)
  expect(orchestratorPatch('orchestrator-agents', '4')).toEqual({ orchestrator_agents: 4 })
  expect(orchestratorPatch('orchestrator-agents', '1')).toEqual({ orchestrator_agents: 1 })
  for (const bad of ['0', '7', 'two', '3.5', '0x3', undefined]) expect(orchestratorPatch('orchestrator-agents', bad)).toBeUndefined()
})

test('fanOut: each part of real work gets an agent; a depth-0 part joins a neighbour instead of taking one', () => {
  const parts = [part('orders: add paging', 'code', 1, ['services/orders']), part('bump the version', 'code', 0, ['package.json']), part('billing: fix rounding', 'code', 2, ['services/billing'])]
  expect(whats(fanOut(parts, 3))).toEqual([['orders: add paging', 'bump the version'], ['billing: fix rounding']])
  // It joins the part that touches its files before its neighbour.
  const near = [part('orders: add paging', 'code', 1, ['services/orders']), part('billing: fix rounding', 'code', 2, ['services/billing']), part('billing: rename a const', 'code', 0, ['services/billing/money.ts'])]
  expect(whats(fanOut(near, 3))).toEqual([['orders: add paging'], ['billing: fix rounding', 'billing: rename a const']])
  // One part of real work is no fan-out.
  expect(fanOut([part('a', 'answer', 0), part('b', 'answer', 1)], 3)).toEqual([])
})

test('fanOut: parts that edit the same files, or code in the same folder, are one agent; parts that only read may share files', () => {
  // An edit and a read of the same files: one agent, so the reader never sees half an edit.
  const shared = [part('fix the mapper', 'code', 2, ['src/quote/mapper.ts']), part('explain the quote flow', 'answer', 1, ['src/quote']), part('review auth', 'review', 1, ['src/auth'])]
  expect(whats(fanOut(shared, 3))).toEqual([['fix the mapper', 'explain the quote flow'], ['review auth']])
  // Code in one folder, or code that names no files, goes to one agent: editing agents must not collide.
  expect(fanOut([part('a', 'code', 1, ['src/api/a.ts']), part('b', 'code', 1, ['src/api/b.ts']), part('c', 'answer', 1, ['docs'])], 3)).toHaveLength(2)
  expect(fanOut([part('a', 'code', 1), part('b', 'code', 1, ['web']), part('c', 'answer', 1)], 3)).toHaveLength(2)
  // Code in different services, and reviews of one change by angle, split.
  expect(fanOut([part('a', 'code', 1, ['services/orders']), part('b', 'code', 1, ['services/billing'])], 3)).toHaveLength(2)
  expect(fanOut([part('security review', 'review', 2, ['src/pay']), part('performance review', 'review', 2, ['src/pay'])], 3)).toHaveLength(2)
})

test('fanOut: never more agents than the cap; the lightest part joins the one most like it; under two, or a cap of 1, no fan-out', () => {
  const four = [part('a', 'code', 2, ['svc/a']), part('b', 'answer', 1, ['svc/b']), part('c', 'answer', 2, ['svc/c']), part('d', 'code', 1, ['svc/d'])]
  expect(fanOut(four, 6)).toHaveLength(4)
  expect(whats(fanOut(four, 3))).toEqual([['a', 'd'], ['b'], ['c']])
  expect(whats(fanOut(four, 2))).toEqual([['a', 'd'], ['c', 'b']])
  expect(fanOut(four, 1)).toEqual([])
  expect(fanOut([part('a', 'code', 2, ['svc/a'])], 3)).toEqual([])
  expect(fanOut([], 3)).toEqual([])
})

// Three independent pieces: a review and code in two services.
const PARTS = [part('review the retry change', 'review', 1, ['services/gateway']), part('orders: add paging', 'code', 1, ['services/orders']), part('billing: fix rounding', 'code', 3, ['services/billing'])]

test('a request of independent parts fans out when sure: one agent per part, on the gear the rules give that part', () => {
  const r = reading({ mode: 'code', reach: 'area', depth: 2, parts: PARTS })
  const want = gearFor(r, 'high')
  const opus = { model: 'opus', effort: 'medium' } as const
  expect(orchestratorPlan(r, want, MAIN, 3, 'high')).toEqual({
    main: MAIN,
    handoff: {
      kind: 'fan',
      gear: opus,
      parts: [
        { what: 'review the retry change', gear: opus, edits: false, review: true },
        { what: 'orders: add paging', gear: { model: 'sonnet', effort: 'high' }, edits: true },
        { what: 'billing: fix rounding', gear: { model: 'sonnet', effort: 'xhigh' }, edits: true },
      ],
    },
  })
  // A cap of 1, or no cap given, is one lane's work, as before.
  expect(orchestratorPlan(r, want, MAIN, 1, 'high')).toEqual({ main: MAIN, handoff: { kind: 'lane', gear: want } })
  expect(orchestratorPlan(r, want, MAIN)).toEqual({ main: MAIN, handoff: { kind: 'lane', gear: want } })
  // A cap of 2 merges the lightest part into the one most like it.
  expect(orchestratorPlan(r, want, MAIN, 2, 'high').handoff?.parts?.map(p => p.what)).toEqual(['review the retry change', 'billing: fix rounding; orders: add paging'])
  // A guess hands nothing off, parts or not; an unsure review is the Opus lane's, not a fan-out.
  expect(orchestratorPlan({ ...r, sure: false }, want, MAIN, 3, 'high')).toEqual({ main: MAIN })
  const unsure = reading({ mode: 'review', sure: false, parts: [part('security', 'review', 1), part('speed', 'review', 1)] })
  expect(orchestratorPlan(unsure, gearFor(unsure, 'high'), MAIN, 3, 'high').handoff).toEqual({ kind: 'lane', gear: { model: 'opus', effort: 'medium' } })
  // What the orchestrator keeps stays here, parts or not; Fable's open-ended work is not split.
  const small = reading({ mode: 'answer', reach: 'area', depth: 1, parts: [part('a', 'answer', 1), part('b', 'answer', 1)] })
  expect(orchestratorPlan(small, gearFor(small, 'high'), MAIN, 3, 'high')).toEqual({ main: MAIN })
  const open = reading({ mode: 'answer', reach: 'frontier', depth: 2, parts: [part('a', 'answer', 2), part('b', 'answer', 2)] })
  expect(orchestratorPlan(open, gearFor(open, 'high'), MAIN, 3, 'high').handoff?.kind).toBe('deep')
})

test('a review part runs on Opus whatever the reach; a costly request lifts every part, as it lifts a lane', () => {
  const point = reading({ mode: 'code', reach: 'point', depth: 1, parts: [part('fix the handler', 'code', 1, ['src/a.ts']), part('review the diff', 'review', 1, ['src/b'])] })
  // The code part is a one-file part of real work: Sonnet by its own scope, not Haiku by the request's point reach.
  expect(orchestratorPlan(point, gearFor(point, 'medium'), MAIN, 3, 'medium').handoff?.parts?.map(p => label(p.gear))).toEqual(['sonnet·medium', 'opus·medium'])
  const costly = reading({ mode: 'code', reach: 'area', depth: 1, care: 'costly', parts: [part('stripe webhook', 'code', 1, ['billing/webhook']), part('audit the refund path', 'answer', 1, ['billing/refunds'])] })
  expect(orchestratorPlan(costly, gearFor(costly, 'medium'), MAIN, 3, 'medium').handoff?.parts?.map(p => label(p.gear))).toEqual(['opus·medium', 'opus·medium'])
  expect(orchestratorPlan(costly, gearFor(costly, 'medium'), MAIN, 1, 'medium').handoff).toEqual({ kind: 'lane', gear: { model: 'opus', effort: 'medium' } })
  // Long commands and lookups in parallel run on Haiku at low.
  const waits = reading({ mode: 'wait', reach: 'area', depth: 1, parts: [part('unit tests', 'wait', 1, ['api']), part('e2e suite', 'wait', 1, ['web'])] })
  expect(orchestratorPlan(waits, gearFor(waits, 'medium'), MAIN, 3, 'medium').handoff?.parts?.map(p => label(p.gear))).toEqual(['haiku·low', 'haiku·low'])
})

test('the first part of each model goes to that model’s lane; other parts, and parts that edit in a worktree, are fresh agents for this turn', () => {
  const sonnet = { model: 'sonnet', effort: 'high' } as const
  const opus = { model: 'opus', effort: 'medium' } as const
  const seat = (p: FanPart) => (p.resume ? `resume ${p.resume}` : p.lane ? 'lane' : 'fresh')
  const reads: FanPart[] = [{ what: 'a', gear: sonnet, edits: false }, { what: 'b', gear: sonnet, edits: false }, { what: 'c', gear: opus, edits: false }]
  const now = 1_000_000
  const idle = () => false
  // No lanes yet: the first part of each model starts its lane.
  expect(seatParts(reads, {}, now, idle).map(seat)).toEqual(['lane', 'fresh', 'lane'])
  // A lane worth going back to takes its model's first part; a busy one is left alone and keeps its place.
  const lanes = { sonnet: { id: 'ls', at: now - 60_000, tokens: 1_000 }, opus: { id: 'lo', at: now - 60_000, tokens: 1_000 } }
  expect(seatParts(reads, lanes, now, idle).map(seat)).toEqual(['resume ls', 'fresh', 'resume lo'])
  expect(seatParts(reads, lanes, now, id => id === 'lo').map(seat)).toEqual(['resume ls', 'fresh', 'fresh'])
  // A lane too old to go back to gives way to the part's agent; unrelated work starts clean.
  expect(seatParts(reads, { sonnet: { ...lanes.sonnet, at: now - RESUME_MS } }, now, idle).map(seat)).toEqual(['lane', 'fresh', 'lane'])
  expect(seatParts(reads, lanes, now, idle, true).map(seat)).toEqual(['lane', 'fresh', 'lane'])
  // Two or more editing parts each work in a worktree of their own, so none of them is a lane; a reading part still is.
  const edits: FanPart[] = [{ what: 'a', gear: sonnet, edits: true }, { what: 'b', gear: sonnet, edits: true }, { what: 'c', gear: sonnet, edits: false }]
  expect(seatParts(edits, lanes, now, idle).map(seat)).toEqual(['fresh', 'fresh', 'resume ls'])
  // A single editing part works in the working tree, and may be its lane.
  expect(seatParts([edits[0]!, reads[2]!], {}, now, idle).map(seat)).toEqual(['lane', 'lane'])
})

test('/gearbox orchestrator, -effort and -agents each take only their own values; the orchestrator has no model of its own to set', () => {
  expect(orchestratorPatch('orchestrator', 'on')).toEqual({ orchestrator: 'on' })
  expect(orchestratorPatch('orchestrator', 'off')).toEqual({ orchestrator: 'off' })
  expect(orchestratorPatch('orchestrator', 'auto')).toEqual({ orchestrator: 'auto' })
  expect(orchestratorPatch('orchestrator-model', 'opus')).toBeUndefined()
  expect(orchestratorPatch('orchestrator-model', 'fable')).toBeUndefined()
  expect(orchestratorPatch('orchestrator-effort', 'high')).toEqual({ orchestrator_effort: 'high' })
  expect(orchestratorPatch('orchestrator-effort', 'auto')).toEqual({ orchestrator_effort: 'auto' })
  expect(orchestratorPatch('orchestrator-effort', 'max')).toBeUndefined()
  expect(orchestratorPatch('orchestrator-effort', 'huge')).toBeUndefined()
  expect(orchestratorPatch('orchestrator', 'maybe')).toBeUndefined()
  expect(orchestratorPatch('effort', 'high')).toBeUndefined()
})

test('a lane starts at the top effort it will need; the job lowers it per message', () => {
  expect(laneStart('low')).toBe('xhigh')
  expect(laneStart('high')).toBe('xhigh')
  // A job that asks for max (the person's own words) starts the lane at max: raising it later only half takes hold.
  expect(laneStart('max')).toBe('max')
})

test('small answers and small code stay on the orchestrator', () => {
  const want = { model: 'sonnet', effort: 'medium' } as const
  expect(orchestratorPlan(reading({ mode: 'answer', reach: 'point', depth: 0 }), want, MAIN)).toEqual({ main: MAIN })
  expect(orchestratorPlan(reading({ mode: 'answer', reach: 'area', depth: 1 }), want, MAIN)).toEqual({ main: MAIN })
  expect(orchestratorPlan(reading({ mode: 'code', reach: 'point', depth: 0 }), want, MAIN)).toEqual({ main: MAIN })
  // Ordinary code in one feature, on the orchestrator's own model: a hand-off would cost more than the work.
  expect(orchestratorPlan(reading({ mode: 'code', reach: 'area', depth: 1 }), { model: 'sonnet', effort: 'xhigh' }, MAIN)).toEqual({ main: MAIN })
  // The same code calling for a stronger model than the orchestrator's goes to that model's lane.
  expect(orchestratorPlan(reading({ mode: 'code', reach: 'area', depth: 1 }), { model: 'opus', effort: 'xhigh' }, MAIN).handoff).toEqual({ kind: 'lane', gear: { model: 'opus', effort: 'xhigh' } })
  // Nothing is handed off on a guess.
  expect(orchestratorPlan(reading({ sure: false, mode: 'code', reach: 'system', depth: 3 }), want, MAIN)).toEqual({ main: MAIN })
})

test('everything else goes to the lane of the model the work calls for, at the effort the work calls for', () => {
  expect(orchestratorPlan(reading({ mode: 'code', reach: 'area', depth: 2 }), { model: 'sonnet', effort: 'xhigh' }, MAIN)).toEqual({ main: MAIN, handoff: { kind: 'lane', gear: { model: 'sonnet', effort: 'xhigh' } } })
  expect(orchestratorPlan(reading({ mode: 'code', reach: 'system', depth: 1 }), { model: 'opus', effort: 'xhigh' }, MAIN).handoff?.kind).toBe('lane')
  expect(orchestratorPlan(reading({ mode: 'answer', reach: 'system', depth: 1 }), { model: 'opus', effort: 'medium' }, MAIN)).toEqual({ main: MAIN, handoff: { kind: 'lane', gear: { model: 'opus', effort: 'medium' } } })
  expect(orchestratorPlan(reading({ mode: 'answer', reach: 'area', depth: 2 }), { model: 'sonnet', effort: 'high' }, MAIN)).toEqual({ main: MAIN, handoff: { kind: 'lane', gear: { model: 'sonnet', effort: 'high' } } })
  // One-spot code is a lane when it is subtle.
  expect(orchestratorPlan(reading({ mode: 'code', reach: 'point', depth: 2 }), { model: 'haiku', effort: 'high' }, MAIN).handoff?.kind).toBe('lane')
  // A long command waits in Haiku's lane, a git chore in the chore gear's: lanes that only relay the command.
  expect(orchestratorPlan(reading({ mode: 'wait' }), { model: 'sonnet', effort: 'medium' }, MAIN).handoff).toEqual({ kind: 'lane', gear: { model: 'haiku', effort: 'low' }, relay: 'wait' })
  expect(orchestratorPlan(reading({ mode: 'commit', depth: 0 }), { model: 'haiku', effort: 'low' }, MAIN).handoff).toEqual({ kind: 'lane', gear: { model: 'haiku', effort: 'low' }, relay: 'chore' })
  expect(orchestratorPlan(reading({ mode: 'commit', depth: 1 }), { model: 'sonnet', effort: 'medium' }, MAIN).handoff).toEqual({ kind: 'lane', gear: { model: 'sonnet', effort: 'medium' }, relay: 'chore' })
})

test('a browser check is no lane’s: the navigator clicks at low and the orchestrator judges, or a stronger model’s agent when the check calls for one, as in steer mode', () => {
  const plain = reading({ mode: 'drive', reach: 'area', depth: 1 })
  // Before 0.23.2 a drive fell through to a lane on the work's model, which clicked and judged its own clicks.
  expect(orchestratorPlan(plain, gearFor(plain, 'xhigh'), MAIN)).toEqual({ main: MAIN, handoff: { kind: 'drive', gear: { model: 'sonnet', effort: 'low' } } })
  expect(orchestratorPlan(plain, gearFor(plain, 'xhigh'), MAIN, 3, 'xhigh', undefined, false, false, 'haiku').handoff).toEqual({ kind: 'drive', gear: { model: 'haiku', effort: 'low' } })
  // A subtle or costly check across the system, on a Sonnet orchestrator: an Opus agent judges the evidence.
  const hard = reading({ mode: 'drive', reach: 'system', depth: 2 })
  expect(orchestratorPlan(hard, gearFor(hard, 'xhigh'), MAIN).handoff).toEqual({ kind: 'drive', gear: { model: 'sonnet', effort: 'low' }, judge: { model: 'opus', effort: 'high' } })
  // On an Opus orchestrator, the orchestrator judges it itself: it is already that model.
  const opus: Gear = { model: 'opus', effort: 'high' }
  expect(orchestratorPlan(hard, gearFor(hard, 'xhigh'), opus).handoff).toEqual({ kind: 'drive', gear: { model: 'sonnet', effort: 'low' } })
  // A navigator the person names (Haiku or Sonnet) wins over the setting; another model does not.
  for (const [model, navigates] of [['haiku', 'haiku'], ['sonnet', 'sonnet'], ['opus', 'haiku']] as const) {
    const asked = reading({ mode: 'drive', ask: { model } })
    expect(orchestratorPlan(asked, gearFor(asked, 'xhigh'), opus, 3, 'xhigh', undefined, false, false, 'haiku').handoff?.gear).toEqual({ model: navigates, effort: 'low' })
  }
  // With the orchestrator's effort on auto it writes the checklist and judges at medium, as steer mode's main does.
  expect(orchestratorPlan(plain, gearFor(plain, 'xhigh'), opus, 3, 'xhigh', undefined, true).main).toEqual({ model: 'opus', effort: 'medium' })
  // The same hand-off steer mode gives, with the coding effort auto or not: it is never advice.
  expect(orchestratorPlan(hard, gearFor(hard, 'xhigh'), MAIN, 3, 'xhigh', undefined, false, true).handoff).toEqual(plan(hard, gearFor(hard, 'xhigh'), undefined, false, 'sonnet', 'sonnet', false, false, true).handoff)
  // A guess hands nothing off, a browser check's included.
  expect(orchestratorPlan({ ...plain, sure: false }, gearFor(plain, 'xhigh'), MAIN)).toEqual({ main: MAIN })
})

test('a review never stays on the orchestrator: it goes to the Opus lane, at the effort its depth calls for', () => {
  for (const [r, effort] of [[reading({ mode: 'review', reach: 'area', depth: 1 }), 'medium'], [reading({ mode: 'review', reach: 'point', depth: 0 }), 'low']] as const)
    expect(orchestratorPlan(r, gearFor(r, 'xhigh'), MAIN)).toEqual({ main: MAIN, handoff: { kind: 'lane', gear: { model: 'opus', effort } } })
})

test('an unsure review goes to the Opus lane too, at the effort its best guess gives; any other guess stays', () => {
  for (const [r, effort] of [[reading({ sure: false, mode: 'review', reach: 'area', depth: 1 }), 'medium'], [reading({ sure: false, mode: 'review', reach: 'point', depth: 0 }), 'low'], [reading({ sure: false, mode: 'review', reach: 'system', depth: 2 }), 'high']] as const) {
    expect(orchestratorPlan(r, gearFor(r, 'xhigh'), MAIN)).toEqual({ main: MAIN, handoff: { kind: 'lane', gear: { model: 'opus', effort } } })
    // The same lane and effort as when the survey is sure.
    expect(orchestratorPlan(r, gearFor(r, 'xhigh'), MAIN)).toEqual(orchestratorPlan({ ...r, sure: true }, gearFor(r, 'xhigh'), MAIN))
  }
  // Frontier is Fable's, a fresh agent and not a lane, as for a sure review.
  const frontier = reading({ sure: false, mode: 'review', reach: 'frontier', depth: 2 })
  expect(orchestratorPlan(frontier, gearFor(frontier, 'xhigh'), MAIN).handoff).toEqual({ kind: 'deep', gear: { model: 'fable', effort: 'high' } })
  // A guess about anything else is never handed off, however weighty.
  for (const mode of ['code', 'answer', 'drive', 'wait', 'commit'] as const) {
    const g = reading({ sure: false, mode, reach: 'system', depth: 3, care: 'costly' })
    expect(orchestratorPlan(g, gearFor(g, 'xhigh'), MAIN)).toEqual({ main: MAIN })
  }
})

// The main conversation runs on the model the session is on, so the plan's `main` can be any rung of the ladder.
const FABLE: Gear = { model: 'fable', effort: 'medium' }
const OPUS: Gear = { model: 'opus', effort: 'medium' }
const HAIKU: Gear = { model: 'haiku', effort: 'medium' }

test('on a Fable main, Fable-level work stays here: a fresh Fable agent is no stronger model, only a brief and a cold start', () => {
  const open = reading({ mode: 'answer', reach: 'frontier', depth: 2 })
  const want = gearFor(open, 'high')
  expect(want.model).toBe('fable')
  // Unchanged on an Opus (or any lower) main: Fable's open-ended work is a deep hand-off to a fresh Fable agent.
  for (const main of [OPUS, MAIN, HAIKU]) expect(orchestratorPlan(open, want, main)).toEqual({ main, handoff: { kind: 'deep', gear: want } })
  expect(orchestratorPlan(open, want, FABLE)).toEqual({ main: FABLE })
  // With `auto` its effort is the rules' for the work, xhigh at most, as for what any orchestrator keeps.
  expect(orchestratorPlan(open, { model: 'fable', effort: 'max' }, FABLE, 1, 'xhigh', undefined, true)).toEqual({ main: { model: 'fable', effort: 'xhigh' } })
  expect(orchestratorPlan(open, want, { model: 'fable', effort: 'high' }, 1, 'xhigh', undefined, true)).toEqual({ main: { model: 'fable', effort: want.effort } })
  // Frontier code, a costly frontier question and a frontier review are Fable's too.
  for (const mode of ['code', 'review'] as const) {
    const r = reading({ mode, reach: 'frontier', depth: 2 })
    expect(orchestratorPlan(r, gearFor(r, 'high'), OPUS).handoff?.kind).toBe('deep')
    expect(orchestratorPlan(r, gearFor(r, 'high'), FABLE).handoff).toBeUndefined()
  }
  // Code the person fixed to Fable, however big: the Fable main writes it, in no agent of its own (and a Fable agent is
  // a deep hand-off from any lower main, as before).
  const big = reading({ mode: 'code', reach: 'area', depth: 3 })
  expect(orchestratorPlan(big, { model: 'fable', effort: 'xhigh' }, OPUS, 1, 'xhigh', 'fable').handoff).toEqual({ kind: 'deep', gear: { model: 'fable', effort: 'xhigh' } })
  expect(orchestratorPlan(big, { model: 'fable', effort: 'xhigh' }, FABLE, 1, 'xhigh', 'fable').handoff).toBeUndefined()
})

test('a Fable main still hands the rest to lanes: what the rules give a lower model goes to that model’s lane, and a guess stays', () => {
  const code = reading({ mode: 'code', reach: 'area', depth: 2 })
  const sonnet = { model: 'sonnet', effort: 'xhigh' } as const
  // Never a Fable lane, never an agent on the main's own model for work a lower one does.
  expect(orchestratorPlan(code, sonnet, FABLE)).toEqual({ main: FABLE, handoff: { kind: 'lane', gear: sonnet } })
  expect(orchestratorPlan(reading({ mode: 'answer', reach: 'system', depth: 2 }), { model: 'opus', effort: 'high' }, FABLE).handoff).toEqual({ kind: 'lane', gear: { model: 'opus', effort: 'high' } })
  expect(orchestratorPlan(reading({ mode: 'wait' }), sonnet, FABLE).handoff).toEqual({ kind: 'lane', gear: { model: 'haiku', effort: 'low' }, relay: 'wait' })
  expect(orchestratorPlan(reading({ mode: 'commit', depth: 0 }), { model: 'haiku', effort: 'low' }, FABLE).handoff).toEqual({ kind: 'lane', gear: { model: 'haiku', effort: 'low' }, relay: 'chore' })
  // Small code a lower model does stays on the stronger main; on a Haiku main the same code goes to a lane.
  const small = reading({ mode: 'code', reach: 'area', depth: 1 })
  expect(orchestratorPlan(small, { model: 'sonnet', effort: 'xhigh' }, FABLE)).toEqual({ main: FABLE })
  expect(orchestratorPlan(small, { model: 'sonnet', effort: 'xhigh' }, OPUS)).toEqual({ main: OPUS })
  expect(orchestratorPlan(small, { model: 'sonnet', effort: 'xhigh' }, HAIKU).handoff).toEqual({ kind: 'lane', gear: { model: 'sonnet', effort: 'xhigh' } })
  expect(orchestratorPlan(reading({ sure: false, mode: 'code', reach: 'frontier', depth: 3 }), { model: 'fable', effort: 'high' }, FABLE)).toEqual({ main: FABLE })
  // A sure request of independent parts still fans out from a Fable main, at the parts' own gear.
  const r = reading({ mode: 'code', reach: 'area', depth: 2, parts: PARTS })
  const fan = orchestratorPlan(r, gearFor(r, 'high'), FABLE, 3, 'high')
  expect(fan.main).toEqual(FABLE)
  expect(fan.handoff?.kind).toBe('fan')
  expect(fan.handoff?.parts?.map(p => label(p.gear))).toEqual(['opus·medium', 'sonnet·high', 'sonnet·xhigh'])
})

test('the effort of the plan’s main follows the rules whichever model the main is on: kept, a hand-off, a relay and a drive', () => {
  const want = { model: 'sonnet', effort: 'xhigh' } as const
  for (const main of [FABLE, OPUS, MAIN, HAIKU]) {
    expect(orchestratorPlan(reading({ mode: 'answer', reach: 'point', depth: 0 }), { model: 'haiku', effort: 'low' }, main, 1, 'xhigh', undefined, true).main).toEqual({ model: main.model, effort: 'low' })
    expect(orchestratorPlan(reading({ mode: 'code', reach: 'area', depth: 2 }), want, main, 1, 'xhigh', undefined, true).main).toEqual({ model: main.model, effort: 'high' })
    expect(orchestratorPlan(reading({ mode: 'wait' }), want, main, 1, 'xhigh', undefined, true).main).toEqual({ model: main.model, effort: 'low' })
    expect(orchestratorPlan(reading({ mode: 'drive' }), want, main, 1, 'xhigh', undefined, true).main).toEqual({ model: main.model, effort: 'medium' })
  }
})

test('costly work goes to a lane: the orchestrator keeps only work of ordinary care', () => {
  const answer = reading({ mode: 'answer', reach: 'point', depth: 0, care: 'costly' })
  expect(orchestratorPlan(answer, gearFor(answer, 'xhigh'), MAIN).handoff).toEqual({ kind: 'lane', gear: { model: 'opus', effort: 'medium' } })
  const edit = reading({ mode: 'code', reach: 'point', depth: 0, care: 'costly' })
  expect(orchestratorPlan(edit, gearFor(edit, 'xhigh'), MAIN).handoff).toEqual({ kind: 'lane', gear: { model: 'opus', effort: 'xhigh' } })
})

test('a turn the orchestrator keeps hands out its lookups, long commands and browser checks, and does the rest at its own gear', () => {
  const phases: Phase[] = [{ what: 'fetch issue 1846', mode: 'lookup', depth: 0 }, { what: 'explain what was done', mode: 'answer', depth: 2 }]
  const r = reading({ mode: 'answer', reach: 'area', depth: 1, phases })
  expect(keepsRoute(r, { main: MAIN })).toBe(true)
  // A lane takes all of a request; a guess hands nothing out; steps with nothing to hand out are no route.
  expect(keepsRoute(r, { main: MAIN, handoff: { kind: 'lane', gear: MAIN } })).toBe(false)
  expect(keepsRoute({ ...r, sure: false }, { main: MAIN })).toBe(false)
  expect(keepsRoute({ ...r, phases: [phases[1]!, { what: 'plan it', mode: 'answer', depth: 1 }] }, { main: MAIN })).toBe(false)
  expect(keepsRoute({ ...r, phases: [{ what: 'check it', mode: 'drive', depth: 1 }, phases[1]!] }, { main: MAIN })).toBe(true)
  // The subtle step stays at the orchestrator's effort, not its depth's.
  const steps = orchestratorRoute(route(phases, 'sonnet', 'xhigh', false, 'sonnet', false, 'sonnet'), MAIN)
  expect(steps.map(s => `${s.by} ${label(s.gear)} ${s.mainEffort}`)).toEqual(['agent haiku·low medium', 'main sonnet·medium medium'])
  expect(routeNote(steps)).toContain('2. explain what was done: do it yourself (effort medium)')
  // Under auto its effort follows each step's instead, xhigh at most.
  const follows = orchestratorRoute(route(phases, 'sonnet', 'xhigh', false, 'sonnet', false, 'sonnet'), MAIN, true)
  expect(follows.map(s => `${s.by} ${label(s.gear)} ${s.mainEffort}`)).toEqual(['agent haiku·low low', 'main sonnet·high high'])
  const code: Phase[] = [{ what: 'fetch issue 1846', mode: 'lookup', depth: 0 }, { what: 'fix it', mode: 'code', depth: 3 }]
  expect(orchestratorRoute(route(code, 'sonnet', 'max', false, 'sonnet', false, 'sonnet'), MAIN, true).map(s => `${s.by} ${label(s.gear)} ${s.mainEffort}`)).toEqual(['agent haiku·low low', 'main sonnet·xhigh xhigh'])
})

test('Fable work is not a lane: it is a fresh deep hand-off', () => {
  expect(orchestratorPlan(reading({ mode: 'answer', reach: 'frontier', depth: 2 }), { model: 'fable', effort: 'high' }, MAIN)).toEqual({ main: MAIN, handoff: { kind: 'deep', gear: { model: 'fable', effort: 'high' } } })
})

test('a lane is worth going back to while its cache is warm and its context small', () => {
  const lane = { id: 'a', at: 1_000_000, tokens: 40_000 }
  expect(laneResumable(lane, lane.at + 60_000)).toBe(true)
  expect(laneResumable(lane, lane.at + RESUME_MS)).toBe(false)
  expect(laneResumable({ ...lane, tokens: RESUME_TOKENS }, lane.at + 60_000)).toBe(false)
  expect(laneResumable(undefined, lane.at)).toBe(false)
})

test('the lane note sends follow-ups to the lane that holds the work, and says what is refused until it starts', () => {
  const gear = { model: 'sonnet', effort: 'high' } as const
  const fresh = handoffNote({ kind: 'lane', gear })
  expect(fresh).toContain('model "sonnet"')
  expect(fresh).toContain('refused')
  expect(fresh).not.toContain('effort "') // gearbox sets the job's effort, not the brief
  const again = handoffNote({ kind: 'lane', gear, resume: 'a-lane' })
  expect(again).toContain('SendMessage to "a-lane"')
  expect(again).toContain('Start no new agent')
  // Work that turns out to split into independent pieces is put to the fan tool first, fresh lane or not.
  for (const note of [fresh, again]) expect(note).toContain('independent pieces: then call mcp__gearbox__fan first')
})

test('fanOut keeps any cap it is given, and a smaller cap loses no part', () => {
  const six = Array.from({ length: 6 }, (_, i) => part(`p${i}`, 'answer', 1, [`svc/${i}`]))
  for (const cap of [2, 3, 4, 5, 6]) expect(fanOut(six, cap)).toHaveLength(cap)
  // Merged groups still hold every part: nothing is lost by a smaller cap.
  expect(fanOut(six, 2).flat().map(p => p.what).sort()).toEqual(six.map(p => p.what))
})

// The QA deploy of a real session: one long command per repo, each in its own folder.
const DEPLOYS = ['integration-malha', 'prepost-services', 'prepost', 'backend'].map(repo => part(`deploy ${repo} on QA`, 'wait', 1, [repo]))

test('parts the main conversation names split on the turn’s reading, or on a plain one when the turn has none', () => {
  expect(NEUTRAL).toMatchObject({ reach: 'area', care: 'routine', sure: true, parts: [] })
  // Long commands run on Haiku at low, one agent each, whatever the turn was read as.
  expect(fanParts({ ...NEUTRAL, parts: DEPLOYS }, 6, 'xhigh').map(p => `${label(p.gear)} ${p.edits}`)).toEqual(Array(4).fill('haiku·low false'))
  // Other parts take their gear from their own kind and depth, on the turn's reach and care.
  const pieces = [part('orders: add paging', 'code', 1, ['services/orders']), part('trace billing', 'answer', 2, ['services/billing'])]
  expect(fanParts({ ...NEUTRAL, parts: pieces }, 3, 'high').map(p => label(p.gear))).toEqual(['sonnet·high', 'sonnet·high'])
  expect(fanParts(reading({ reach: 'system', care: 'costly', parts: pieces }), 3, 'high').map(p => label(p.gear))).toEqual(['opus·high', 'opus·high'])
})

test('a split that is not worth it says why: one agent at a time, depth-0 parts, shared files', () => {
  expect(whyNoFan(DEPLOYS, 3)).toBeUndefined()
  expect(whyNoFan(DEPLOYS.slice(0, 1), 3)).toContain('fewer than two parts')
  expect(whyNoFan(DEPLOYS, 1)).toContain('orchestrator-agents is 1')
  expect(whyNoFan([part('bump the version', 'code', 0, ['package.json']), part('orders: add paging', 'code', 1, ['services/orders'])], 3)).toContain('depth-0')
  const shared = [part('orders: add paging', 'code', 1, ['services/orders/list.ts']), part('orders: add sorting', 'code', 1, ['services/orders/list.ts'])]
  expect(whyNoFan(shared, 3)).toContain('same files')
})

// The six parts of a live run (session f3c009ef), word for word: the survey read the README part as depth 0.
const LIVE = [
  part('explain policy.ts and edge cases', 'answer', 1, ['hooks/policy.ts']),
  part('explain orchestrator.ts and edge cases', 'answer', 1, ['hooks/orchestrator.ts']),
  part('explain register.tsx and edge cases', 'answer', 1, ['hooks/register.tsx']),
  part('explain lanes/run.ts and edge cases', 'answer', 1, ['bench/lanes/run.ts']),
  part('explain escalation/obey.ts and edge cases', 'answer', 1, ['bench/escalation/obey.ts']),
  part('explain README and edge cases', 'answer', 0, ['README.md']),
]

test('fanOut on a live run’s six parts at a cap of 6: the depth-0 README joins its neighbour; at depth 1 it is an agent of its own', () => {
  const groups = fanOut(LIVE, 6)
  expect(groups).toHaveLength(5)
  expect(whats(groups).at(-1)).toEqual(['explain escalation/obey.ts and edge cases', 'explain README and edge cases'])
  // Nothing edits and no files overlap: with the README at depth 1 every part keeps its own agent.
  const deep = LIVE.map(p => ({ ...p, depth: 1 as const }))
  expect(whats(fanOut(deep, 6))).toEqual(deep.map(p => [p.what]))
})

test('fanOut: a root-level file sits in the root folder alone; reads never merge, edits merge only in one folder or on one file', () => {
  // Two reads of one folder, and a root-level read next to folder files, split.
  expect(fanOut([part('a', 'answer', 1, ['hooks/policy.ts']), part('b', 'answer', 1, ['hooks/register.tsx'])], 6)).toHaveLength(2)
  expect(fanOut([part('a', 'answer', 1, ['README.md']), part('b', 'answer', 1, ['hooks/policy.ts']), part('c', 'answer', 1, ['bench/lanes/run.ts'])], 6)).toHaveLength(3)
  // A read and an edit of one file are one agent.
  expect(whats(fanOut([part('fix', 'code', 1, ['hooks/policy.ts']), part('explain', 'answer', 1, ['hooks/policy.ts']), part('docs', 'answer', 1, ['README.md'])], 6))).toEqual([['fix', 'explain'], ['docs']])
  // Edits in different folders split; a root-level edit is in no folder but the root's, so it splits from them too.
  expect(fanOut([part('a', 'code', 1, ['hooks/policy.ts']), part('b', 'code', 1, ['bench/lanes/run.ts'])], 6)).toHaveLength(2)
  expect(fanOut([part('a', 'code', 1, ['README.md']), part('b', 'code', 1, ['hooks/policy.ts'])], 6)).toHaveLength(2)
  // Two edits at the root are code in one folder: one agent.
  expect(fanOut([part('a', 'code', 1, ['README.md']), part('b', 'code', 1, ['package.json'])], 6)).toEqual([])
})

test('a part’s model follows its own scope, not the whole request’s; its effort, its own depth', () => {
  const system = (parts: Part[], r: Partial<Reading> = {}) => fanParts(reading({ mode: 'answer', reach: 'system', depth: 1, parts, ...r }), 6, 'xhigh').map(p => label(p.gear))
  // One file each: Sonnet at the effort of depth 1, though the request names six files.
  expect(system(LIVE)).toEqual(Array(5).fill('sonnet·medium'))
  // Files in three top-level folders, or more than three files, are a system's: Opus.
  const wide = part('trace the flow', 'answer', 1, ['hooks/policy.ts', 'bench/lanes/run.ts', 'README.md'])
  const many = part('explain the hooks', 'answer', 1, ['hooks/a.ts', 'hooks/b.ts', 'hooks/c.ts', 'hooks/d.ts'])
  const one = part('explain run.ts', 'answer', 1, ['bench/lanes/run.ts'])
  expect(system([wide, many, one])).toEqual(['opus·medium', 'opus·medium', 'sonnet·medium'])
  // A part that names no files takes the request's reach.
  expect(system([part('explain the design', 'answer', 2), one])).toEqual(['opus·high', 'sonnet·medium'])
  // A one-file part of real work is never below Sonnet, even on a request of one spot.
  expect(system([part('explain a.ts', 'answer', 1, ['src/a.ts']), part('explain b.ts', 'answer', 1, ['lib/b.ts'])], { reach: 'point' })).toEqual(['sonnet·medium', 'sonnet·medium'])
  // A review is Opus's; a costly request lifts every part to at least opus·medium; long commands and lookups stay on Haiku.
  expect(system([part('review the diff', 'review', 1, ['hooks/policy.ts']), one])).toEqual(['opus·medium', 'sonnet·medium'])
  expect(system([part('explain run.ts', 'answer', 0, ['bench/lanes/run.ts']), one, part('explain obey.ts', 'answer', 1, ['bench/escalation/obey.ts'])], { care: 'costly' })).toEqual(['opus·medium', 'opus·medium'])
  expect(system([part('unit tests', 'wait', 1, ['hooks']), part('fetch the issue', 'lookup', 1, ['gh'])])).toEqual(['haiku·low', 'haiku·low'])
  // The person's ask still wins.
  expect(system([one, part('explain obey.ts', 'answer', 1, ['bench/escalation/obey.ts'])], { ask: { model: 'opus', effort: 'high' } })).toEqual(['opus·high', 'opus·high'])
  expect(system([one, part('explain obey.ts', 'answer', 1, ['bench/escalation/obey.ts'])], { ask: { model: 'haiku' } })).toEqual(['haiku·medium', 'haiku·medium'])
})

test('a merged part’s model follows the union of its files, never below its members’ own', () => {
  const a = part('explain a', 'answer', 1, ['svc/a.ts'])
  const b = part('explain b', 'answer', 1, ['lib/b.ts'])
  // A depth-0 part spanning two more folders joins a: together they span three, a system's.
  const spread = part('note c and d', 'answer', 0, ['web/c.ts', 'docs/d.md'])
  expect(fanParts(reading({ mode: 'answer', reach: 'area', parts: [a, spread, b] }), 6, 'xhigh').map(p => `${p.what} ${label(p.gear)}`)).toEqual(['explain a; note c and d opus·medium', 'explain b sonnet·medium'])
  // A member that names no files keeps the request's reach in the group it joins.
  const loose = part('note the rest', 'answer', 0)
  expect(fanParts(reading({ mode: 'answer', reach: 'system', parts: [a, loose, b] }), 6, 'xhigh').map(p => label(p.gear))).toEqual(['opus·medium', 'sonnet·medium'])
})

test('a fixed coding model under the orchestrator: small code stays here only on that very model, else goes to its lane; Fable is a fresh agent', () => {
  const small = reading({ mode: 'code', reach: 'point', depth: 1 })
  const at = (model: 'sonnet' | 'opus' | 'fable') => ({ model, effort: 'xhigh' as const })
  // The orchestrator runs Sonnet: Sonnet code stays, Opus code (even one spot) goes to the Opus lane.
  expect(orchestratorPlan(small, at('sonnet'), MAIN, 3, 'xhigh', 'sonnet')).toEqual({ main: MAIN })
  expect(orchestratorPlan(small, at('opus'), MAIN, 3, 'xhigh', 'opus')).toEqual({ main: MAIN, handoff: { kind: 'lane', gear: at('opus') } })
  // An Opus orchestrator keeps no Sonnet code: it goes down to the Sonnet lane.
  const opusMain = { model: 'opus', effort: 'medium' } as const
  expect(orchestratorPlan(small, at('sonnet'), opusMain, 3, 'xhigh', 'sonnet')).toEqual({ main: opusMain, handoff: { kind: 'lane', gear: at('sonnet') } })
  expect(orchestratorPlan(small, at('fable'), MAIN, 3, 'xhigh', 'fable')).toEqual({ main: MAIN, handoff: { kind: 'deep', gear: at('fable') } })
  // A mechanical edit at one spot stays on any orchestrator, whatever model code is fixed to; not a costly one.
  const mechanical = reading({ mode: 'code', reach: 'point', depth: 0 })
  for (const code of ['sonnet', 'opus', 'fable'] as const) expect(orchestratorPlan(mechanical, at(code), opusMain, 3, 'xhigh', code)).toEqual({ main: opusMain })
  expect(orchestratorPlan({ ...mechanical, care: 'costly' }, at('sonnet'), opusMain, 3, 'xhigh', 'sonnet').handoff?.kind).toBe('lane')
  // Answers keep the rules, coding model or not.
  const question = reading({ mode: 'answer', reach: 'system', depth: 2 })
  const want = gearFor(question, 'xhigh', 'sonnet')
  expect(orchestratorPlan(question, want, MAIN, 3, 'xhigh', 'sonnet')).toEqual(orchestratorPlan(question, gearFor(question, 'xhigh'), MAIN, 3, 'xhigh'))
})

test('a fixed coding model in a fan-out: each code part runs on it, a Fable one as a fresh agent; reads and reviews keep their rules', () => {
  const r = reading({ mode: 'code', reach: 'area', depth: 2, parts: PARTS })
  for (const code of ['sonnet', 'opus', 'fable'] as const) {
    const plan = orchestratorPlan(r, gearFor(r, 'high', code), MAIN, 3, 'high', code)
    expect(plan.handoff?.parts?.map(p => `${p.what} ${label(p.gear)}`)).toEqual(['review the retry change opus·medium', `orders: add paging ${code}·high`, `billing: fix rounding ${code}·xhigh`])
  }
  const fable = fanParts(r, 3, 'high', 'fable')
  // A Fable part never becomes a lane, nor goes back to one.
  const seated = seatParts(fable, { fable: { id: 'f1', at: 1000, tokens: 10 } }, 2000, () => false)
  expect(seated.map(p => [p.gear.model, !!p.lane, p.resume ?? null])).toEqual([['opus', true, null], ['fable', false, null], ['fable', false, null]])
  // Code merged with a review of the same files runs on the higher model: a review is never below Opus.
  const merged = [part('review the mapper', 'review', 1, ['src/quote/mapper.ts']), part('fix the mapper', 'code', 1, ['src/quote/mapper.ts']), part('explain auth', 'answer', 1, ['src/auth'])]
  expect(fanParts(reading({ mode: 'code', parts: merged }), 3, 'high', 'sonnet').map(p => label(p.gear))).toEqual(['opus·high', 'sonnet·medium'])
})

// `auto`: the plan's main effort follows the turn instead of being pinned.
test('auto: what the orchestrator keeps runs at the rules’ effort, at most xhigh; a hand-off at high; a lane that only relays a command at low', () => {
  const auto = (r: Reading, want: Gear) => orchestratorPlan(r, want, { model: 'sonnet', effort: 'high' }, 1, 'xhigh', undefined, true)
  // Kept: the effort the reading's gear gives it.
  expect(auto(reading({ mode: 'answer', reach: 'point', depth: 0 }), gearFor(reading({ mode: 'answer', reach: 'point', depth: 0 }))).main.effort).toBe('low')
  expect(auto(reading({ mode: 'answer', reach: 'area', depth: 1 }), { model: 'sonnet', effort: 'medium' }).main.effort).toBe('medium')
  expect(auto(reading({ mode: 'code', reach: 'point', depth: 0 }), { model: 'haiku', effort: 'xhigh' }).main.effort).toBe('xhigh')
  // A guess is kept too, at its best guess, and never above xhigh (a person's max ask is theirs to make for the turn).
  expect(auto(reading({ sure: false, mode: 'code', reach: 'system', depth: 3 }), { model: 'opus', effort: 'xhigh' })).toEqual({ main: { model: 'sonnet', effort: 'xhigh' } })
  expect(auto(reading({ sure: false, mode: 'answer', depth: 3 }), { model: 'sonnet', effort: 'max' }).main.effort).toBe('xhigh')
  // A hand-off: the brief and the review of the agent are the work.
  expect(auto(reading({ mode: 'code', reach: 'area', depth: 2 }), { model: 'sonnet', effort: 'xhigh' })).toEqual({ main: { model: 'sonnet', effort: 'high' }, handoff: { kind: 'lane', gear: { model: 'sonnet', effort: 'xhigh' } } })
  expect(auto(reading({ mode: 'answer', reach: 'frontier', depth: 2 }), { model: 'fable', effort: 'high' }).main.effort).toBe('high')
  expect(auto(reading({ mode: 'review', depth: 0 }), { model: 'opus', effort: 'low' }).main.effort).toBe('high')
  // A lane that only relays a command (a long command, a git chore) needs no more than low.
  expect(auto(reading({ mode: 'wait' }), { model: 'sonnet', effort: 'medium' }).main.effort).toBe('low')
  expect(auto(reading({ mode: 'commit', depth: 1 }), { model: 'sonnet', effort: 'medium' }).main.effort).toBe('low')
  // Pinned (not auto), the plan's main is the orchestrator's own gear whatever the turn.
  expect(orchestratorPlan(reading({ mode: 'wait' }), { model: 'sonnet', effort: 'medium' }, MAIN).main).toBe(MAIN)
})

test('with the coding effort auto, the orchestrator advises no hand-off for an answer that needs no deep look, or for a guess, a review’s included', () => {
  const advise = (r: Reading) => orchestratorPlan(r, gearFor(r, 'medium'), MAIN, 3, 'medium', undefined, false, true)
  // An answer at depth 0 or 1 stays whatever its reach or care: with a fixed coding effort a system-wide or costly one
  // goes to a lane, and so does an unsure review.
  for (const r of [reading({ mode: 'answer', reach: 'system', depth: 1 }), reading({ mode: 'answer', care: 'costly', depth: 1 }), reading({ mode: 'review', sure: false })]) {
    expect(orchestratorPlan(r, gearFor(r, 'medium'), MAIN, 3, 'medium').handoff?.kind).toBe('lane')
    expect(advise(r)).toEqual({ main: MAIN })
  }
  // Deeper answers, code past what it keeps and sure reviews are still advised to a lane.
  for (const r of [reading({ mode: 'answer', reach: 'system', depth: 2 }), reading({ mode: 'review' }), reading({ mode: 'code', reach: 'system', depth: 2 })]) expect(advise(r).handoff?.kind).toBe('lane')
  // A part that reviews says so, merged or not: it never runs below Opus.
  const parts = [part('fix the handler', 'code', 1, ['src/a']), part('review the diff', 'review', 1, ['src/b'])]
  expect(fanParts(reading({ mode: 'code', parts }), 3, 'medium').map(p => p.review ?? false)).toEqual([false, true])
})

test('fanSlot: the part a call names by number, else the first not started that no lane takes, else any not started; none when all have', () => {
  const parts: FanPart[] = [
    { what: 'a', gear: MAIN, edits: false, resume: 'lane-1' },
    { what: 'b', gear: MAIN, edits: true },
    { what: 'c', gear: MAIN, edits: true },
  ]
  expect(fanSlot(parts, new Set(), 'part 3: c')).toBe(2)
  expect(fanSlot(parts, new Set(), 'Part 1: a')).toBe(0)
  expect(fanSlot(parts, new Set(), 'whatever')).toBe(1) // the first that no lane takes
  expect(fanSlot(parts, new Set([1]), 'whatever')).toBe(2)
  expect(fanSlot(parts, new Set([1, 2]), 'whatever')).toBe(0) // only the lane’s part is left
  expect(fanSlot(parts, new Set([2]), 'part 3: c')).toBe(1) // a number already started: the first open
  expect(fanSlot(parts, new Set(), 'part 9: x')).toBe(1) // past the parts
  expect(fanSlot(parts, new Set(), undefined)).toBe(1)
  expect(fanSlot(parts, new Set([0, 1, 2]), 'part 1: a')).toBe(-1)
  expect(fanSlot([], new Set(), 'part 1')).toBe(-1)
})

test('lanesFrom: per model, the newest agent the main conversation started; not a fork, a refused or stopped row, a worktree part, an agent of an agent or Fable', () => {
  const row = (asked: string, extra: object = {}) => ({ label: 'analyze', parent: 'main', asked, state: 'done' as const, steps: 3, since: 100, endedAt: 200, ...extra })
  const now = 1_000_000
  const lanes = lanesFrom(
    {
      main: { label: 'main', asked: 'opus', state: 'working', steps: 1 },
      old: row('claude-sonnet-5-5', { endedAt: 300 }),
      new: row('claude-sonnet-5-5', { endedAt: 900 }),
      busy: row('claude-opus-5-5', { state: 'working', endedAt: undefined, since: 500 }),
      fork: row('claude-haiku-5-5', { label: '/review', endedAt: 950 }),
      refused: row('claude-haiku-5-5', { failed: 'refused', endedAt: 960 }),
      stopped: row('claude-haiku-5-5', { failed: 'stopped', endedAt: 970 }),
      part: row('claude-haiku-5-5', { worktree: 'feat/x', endedAt: 980 }),
      nested: row('claude-haiku-5-5', { parent: 'new', endedAt: 990 }),
      fable: row('claude-fable-5-5', { endedAt: 995 }),
    },
    now,
  )
  // An agent at work is as warm as now; one that ended, as its last activity; context is not recorded.
  expect(lanes).toEqual({ sonnet: { id: 'new', at: 900, tokens: 0 }, opus: { id: 'busy', at: now, tokens: 0 } })
  expect(lanesFrom({}, now)).toEqual({})
})
