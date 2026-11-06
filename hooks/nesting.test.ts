import { expect, test } from 'claude-code/testing'
import { READERS, REFUSED, briefVerdict, nestedCap, readerGear, whyNoNestedFan } from './nesting'
import type { Gear, Part, Reading } from './policy'

const part = (what: string, mode: Part['mode'], depth: Part['depth'], files: string[] = []): Part => ({ what, mode, depth, files })
const SONNET_MEDIUM: Gear = { model: 'sonnet', effort: 'medium' }
const read = (mode: Reading['mode'], gear: Gear = SONNET_MEDIUM, pinned = false) => ({ mode, gear, pinned })

test('readers: Explore and Plan only, on Sonnet at low, Haiku when the agent asks', () => {
  expect(['Explore', 'Plan'].every(t => READERS.test(t))).toBe(true)
  for (const t of ['', 'general-purpose', 'ExplorePlus', 'explore', 'claude-code-guide']) expect(READERS.test(t)).toBe(false)
  expect(readerGear(undefined)).toEqual({ model: 'sonnet', effort: 'low' })
  expect(readerGear('haiku')).toEqual({ model: 'haiku', effort: 'low' })
  for (const named of ['opus', 'fable', 'sonnet', 3]) expect(readerGear(named)).toEqual({ model: 'sonnet', effort: 'low' })
})

test('the cap an agent splits on is orchestrator-agents less the agents running and the parts promised, never below zero', () => {
  expect(nestedCap(6, 1, 0)).toBe(5)
  expect(nestedCap(6, 1, 3)).toBe(2)
  expect(nestedCap(4, 5, 0)).toBe(0)
  expect(nestedCap(1, 1, 0)).toBe(0)
})

test('a split that has no room says so in numbers; otherwise it says why as the main conversation’s does', () => {
  const two = [part('a', 'code', 1, ['svc/a']), part('b', 'code', 1, ['svc/b'])]
  expect(whyNoNestedFan(two, 2, 6, 4)).toBeUndefined()
  expect(whyNoNestedFan(two, 0, 6, 6)).toBe('orchestrator-agents is 6 and 6 agents are running or promised, so there is room for 0 more')
  expect(whyNoNestedFan(two, 1, 4, 3)).toBe('orchestrator-agents is 4 and 3 agents are running or promised, so there is room for 1 more')
  expect(whyNoNestedFan([two[0]!], 5, 6, 1)).toBe('fewer than two parts')
  expect(whyNoNestedFan([part('a', 'code', 1, ['svc/x']), part('b', 'code', 1, ['svc/x'])], 5, 6, 1)).toContain('edit the same files')
  expect(whyNoNestedFan([part('a', 'answer', 0), part('b', 'answer', 1)], 5, 6, 1)).toContain('depth-0')
})

test('what a brief reads as decides an agent’s start: work that is not code and one writer start on a gear, a browser check, a git chore or an unreadable brief do not', () => {
  const plain = { plain: true, standing: 'high' } as const
  expect(briefVerdict(undefined, plain)).toEqual({ refusal: 'unread' })
  for (const mode of ['drive', 'commit'] as const) expect(briefVerdict(read(mode), plain)).toEqual({ refusal: 'other' })
  // A long command is Haiku's, whatever its reach.
  expect(briefVerdict(read('wait', { model: 'opus', effort: 'high' }), plain)).toMatchObject({ gear: { model: 'haiku', effort: 'low' }, writes: false, reviews: false })
  expect(briefVerdict(read('answer', { model: 'haiku', effort: 'low' }), plain)).toMatchObject({ gear: { model: 'haiku', effort: 'low' }, writes: false })
  expect(briefVerdict(read('review', { model: 'opus', effort: 'medium' }), plain)).toMatchObject({ gear: { model: 'opus', effort: 'medium' }, reviews: true })
  // Code is a plain agent’s job, on the gear the brief calls for.
  expect(briefVerdict(read('code', { model: 'sonnet', effort: 'high' }), plain)).toMatchObject({ gear: { model: 'sonnet', effort: 'high' }, writes: true })
  expect(briefVerdict(read('code'), { ...plain, plain: false })).toEqual({ refusal: 'typed' })
  expect(briefVerdict(read('answer'), { ...plain, plain: false })).toMatchObject({ gear: SONNET_MEDIUM })
})

test('nothing nested asks the person: Fable and an effort above their coding effort step down, unless the model is the coding model they fixed', () => {
  const plain = { plain: true, standing: 'high' } as const
  expect(briefVerdict(read('answer', { model: 'fable', effort: 'xhigh' }), plain)).toMatchObject({ gear: { model: 'opus', effort: 'high' } })
  // xhigh is theirs when their coding effort is xhigh.
  expect(briefVerdict(read('answer', { model: 'opus', effort: 'xhigh' }), { ...plain, standing: 'xhigh' })).toMatchObject({ gear: { model: 'opus', effort: 'xhigh' } })
  // Code on a Fable they fixed stays on it.
  expect(briefVerdict(read('code', { model: 'fable', effort: 'high' }, true), plain)).toMatchObject({ gear: { model: 'fable', effort: 'high' } })
  expect(briefVerdict(read('code', { model: 'fable', effort: 'high' }, false), plain)).toMatchObject({ gear: { model: 'opus', effort: 'high' } })
})

test('the refusals say what to do instead', () => {
  expect(REFUSED.depth).toContain('cannot start agents of its own')
  expect(REFUSED.writer).toContain('still running')
  expect(REFUSED.writer).toContain('mcp__gearbox__fan')
  expect(REFUSED.typed).toContain('plain Agent')
  expect(REFUSED.unread).toContain('could not tell what this agent is for')
  expect(REFUSED.other).toContain('browser check or a git chore')
})
