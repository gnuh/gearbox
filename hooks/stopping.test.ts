import { expect, test } from 'claude-code/testing'
import type { GearboxLoop } from '../types'
import { agentName, findAgents, startedBy, stopPlan, stoppable, stoppableIds } from './stopping'

const loop = (extra: Partial<GearboxLoop> = {}): GearboxLoop => ({ label: 'agent', asked: 'sonnet', state: 'working', steps: 0, ...extra })

// main, two parts, an Explore under part 2, a reader under that one, a finished part and a refused start.
const crew = (): Record<string, GearboxLoop> => ({
  main: loop({ label: 'main', state: 'working' }),
  p1: loop({ label: 'part 1: customers', parent: 'main' }),
  p2: loop({ label: 'part 2: README', parent: 'main' }),
  e1: loop({ label: 'Explore · paginate', parent: 'p2' }),
  e2: loop({ label: 'Explore · money', parent: 'e1', state: 'waiting' }),
  p3: loop({ label: 'part 3: review', parent: 'main', state: 'done', endedAt: 1 }),
  'refused:t9': loop({ label: 'writer', parent: 'p2', state: 'done', failed: 'refused' }),
})

test('only a real agent at work can be stopped: not main, not a queued part, not one that ended or was refused', () => {
  const all = crew()
  expect(stoppable('p1', all.p1)).toBe(true)
  expect(stoppable('e2', all.e2)).toBe(true) // waiting on its own work is alive
  expect(stoppable('main', all.main)).toBe(false)
  expect(stoppable('queued:0', loop({ state: 'idle' }))).toBe(false)
  expect(stoppable('queued:1', loop({ state: 'working' }))).toBe(false)
  expect(stoppable('p3', all.p3)).toBe(false)
  expect(stoppable('refused:t9', all['refused:t9'])).toBe(false)
  expect(stoppable('gone', undefined)).toBe(false)
  expect(stoppableIds(all)).toEqual(['p1', 'p2', 'e1', 'e2'])
})

test('the agents an agent started are found through the parent links, nearest first, and only those at work', () => {
  const all = crew()
  expect(startedBy(all, 'p2')).toEqual(['e1', 'e2'])
  expect(startedBy(all, 'e1')).toEqual(['e2'])
  expect(startedBy(all, 'p1')).toEqual([])
  expect(startedBy(all, 'main')).toEqual(['p1', 'p2', 'e1', 'e2']) // p3 and the refused start are not at work
  // A done agent in between does not cut the line: what it started may still run.
  const gap = { ...all, e1: { ...all.e1!, state: 'done' as const } }
  expect(startedBy(gap, 'p2')).toEqual(['e2'])
  // A loop that names itself, or a ring of parents, does not loop forever.
  expect(startedBy({ a: loop({ parent: 'a' }), b: loop({ parent: 'c' }), c: loop({ parent: 'b' }) }, 'b')).toEqual(['c'])
})

test('a stop takes the agents it started with it, an agent once, before the agents it started', () => {
  const all = crew()
  expect(stopPlan(all, ['p2'])).toEqual([
    { id: 'p2', cascade: ['e1', 'e2'] },
    { id: 'e1', cascade: [], by: 'p2' },
    { id: 'e2', cascade: [], by: 'p2' },
  ])
  // A leaf alone; an id that cannot be stopped is left out.
  expect(stopPlan(all, ['e2', 'p3', 'main', 'nope'])).toEqual([{ id: 'e2', cascade: [] }])
  // Two asked for, one under the other: the lower one is not stopped twice, and not named in the cascade twice.
  expect(stopPlan(all, ['p2', 'e1']).map(s => s.id)).toEqual(['p2', 'e1', 'e2'])
  expect(stopPlan(all, ['e1', 'p2'])).toEqual([
    { id: 'e1', cascade: ['e2'] },
    { id: 'e2', cascade: [], by: 'e1' },
    { id: 'p2', cascade: [] },
  ])
  // Everything at work, in the order it nests.
  expect(stopPlan(all, stoppableIds(all)).map(s => s.id)).toEqual(['p1', 'p2', 'e1', 'e2'])
  expect(stopPlan(all, [])).toEqual([])
  // An agent already being stopped is not stopped again, and the agents beneath it that are too are left out of a cascade.
  const going = { ...all, p2: { ...all.p2!, stopping: 'task' as const }, e1: { ...all.e1!, stopping: 'task' as const } }
  expect(stopPlan(going, ['p2'])).toEqual([])
  expect(stopPlan(going, ['p1', 'p2', 'e1', 'e2']).map(s => s.id)).toEqual(['p1', 'e2'])
  expect(stopPlan({ ...all, e1: { ...all.e1!, stopping: 'soft' as const } }, ['p2'])).toEqual([
    { id: 'p2', cascade: ['e2'] },
    { id: 'e2', cascade: [], by: 'p2' },
  ])
})

test('a word names the agent at work whose id or name it is, or the only one whose id or name begins with it, case ignored', () => {
  const all = crew()
  expect(findAgents(all, 'p1')).toEqual(['p1'])
  expect(findAgents(all, 'PART 1')).toEqual(['p1'])
  expect(findAgents(all, 'part 1 · cust')).toEqual(['p1']) // as the band and the panel spell it
  expect(findAgents(all, 'part 2: readme')).toEqual(['p2']) // and as the call was described
  expect(findAgents(all, 'part')).toEqual(['p1', 'p2']) // ambiguous: both come back
  expect(findAgents(all, 'explore')).toEqual(['e1', 'e2'])
  expect(findAgents(all, 'part 3')).toEqual([]) // it ended
  expect(findAgents(all, 'main')).toEqual([])
  expect(findAgents(all, '  ')).toEqual([])
  // An exact name wins over longer names that begin with it.
  const near = { ...all, p10: loop({ label: 'part 10: docs', parent: 'main' }) }
  expect(findAgents(near, 'p1')).toEqual(['p1'])
  expect(findAgents(near, 'part 1')).toEqual(['p1', 'p10'])
  expect(findAgents({ x: loop({ label: 'part 1' }), y: loop({ label: 'part 1 · more' }) }, 'part 1')).toEqual(['x'])
})

test('an agent is named as the panel names it, with its id', () => {
  expect(agentName(crew(), 'p1')).toBe('part 1 · customers (p1)')
  expect(agentName(crew(), 'unknown')).toBe('unknown (unknown)')
})
