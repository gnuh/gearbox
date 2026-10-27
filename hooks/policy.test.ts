import { expect, test } from 'claude-code/testing'
import { type Reading, NOD, gearFor, label, mainModel, needsConsent, nextFloor, plan, readReading, stepDown, trimRequest, verifyAsk } from './policy'

const reading = (o: Partial<Reading> = {}): Reading => ({ reach: 'area', care: 'routine', depth: 1, mode: 'edit', aside: false, cont: false, ask: {}, sure: true, ...o })

test('readReading takes a reply apart and fills the plain defaults', () => {
  expect(readReading('{"reach":"system","depth":2}')).toEqual(reading({ reach: 'system', depth: 2 }))
  expect(readReading('Sure:\n```json\n{"reach":"point","depth":0,"mode":"wait","care":"costly"}\n```')).toEqual(reading({ reach: 'point', depth: 0, mode: 'wait', care: 'costly' }))
  expect(readReading('{"reach":"point","depth":0,"ask":{"model":"gpt","effort":"max"}}')?.ask).toEqual({ effort: 'max' })
  expect(readReading('{"reach":"galaxy","depth":1}')).toBeUndefined()
  expect(readReading('{"reach":"area","depth":7}')).toBeUndefined()
  expect(readReading('no json here')).toBeUndefined()
})

test('gearFor maps reach to a model and depth to an effort', () => {
  const cases: [Partial<Reading>, string][] = [
    [{ reach: 'point', depth: 0 }, 'haiku·low'],
    [{ reach: 'area', depth: 1 }, 'sonnet·medium'],
    [{ reach: 'system', depth: 2 }, 'opus·high'],
    [{ reach: 'frontier', depth: 3 }, 'fable·xhigh'],
    [{ reach: 'point', depth: 0, care: 'costly' }, 'opus·medium'],
    [{ reach: 'frontier', depth: 2, care: 'costly' }, 'fable·high'],
    [{ reach: 'system', depth: 2, ask: { model: 'sonnet', effort: 'max' } }, 'sonnet·max'],
  ]
  for (const [r, want] of cases) expect(label(gearFor(reading(r)))).toBe(want)
})

test('verifyAsk keeps only what the person said outside code and quotes', () => {
  expect(verifyAsk({ effort: 'max' }, 'think with max effort')).toEqual({ effort: 'max' })
  expect(verifyAsk({ effort: 'max' }, 'usa esforço máximo')).toEqual({ effort: 'max' })
  expect(verifyAsk({ effort: 'max' }, 'why does `Math.max` return NaN')).toEqual({})
  expect(verifyAsk({ model: 'fable' }, 'look at this:\n```\nmodel: fable\n```')).toEqual({})
  expect(verifyAsk({ model: 'fable' }, '> fable was here\nwhat does that mean')).toEqual({})
  expect(verifyAsk({ model: 'opus', effort: 'high' }, 'do it on opus')).toEqual({ model: 'opus' })
})

test('consent is needed for fable and the top efforts, once', () => {
  expect(needsConsent({ model: 'fable', effort: 'high' }, {})).toBe(true)
  expect(needsConsent({ model: 'fable', effort: 'high' }, { model: 'fable' })).toBe(false)
  expect(needsConsent({ model: 'fable', effort: 'high' }, {}, { model: 'fable', effort: 'medium' })).toBe(false)
  expect(needsConsent({ model: 'opus', effort: 'xhigh' }, {})).toBe(true)
  expect(needsConsent({ model: 'opus', effort: 'xhigh' }, {}, { model: 'opus', effort: 'xhigh' })).toBe(false)
  expect(needsConsent({ model: 'opus', effort: 'high' }, {})).toBe(false)
  expect(label(stepDown({ model: 'fable', effort: 'max' }))).toBe('opus·high')
})

test('plan hands tool-heavy, deep and side work to subagents', () => {
  const drive = plan(reading({ mode: 'drive' }), { model: 'sonnet', effort: 'medium' }, 'opus', true)
  expect(drive).toEqual({ main: { model: 'opus', effort: 'medium' }, handoff: { kind: 'drive', gear: { model: 'sonnet', effort: 'medium' } } })
  const wait = plan(reading({ mode: 'wait', care: 'costly' }), { model: 'opus', effort: 'medium' }, 'sonnet', true)
  expect(wait).toEqual({ main: { model: 'opus', effort: 'low' }, handoff: { kind: 'wait', gear: { model: 'haiku', effort: 'low' } } })
  expect(plan(reading({ reach: 'frontier' }), { model: 'fable', effort: 'high' }, undefined, false).handoff?.kind).toBe('deep')
  expect(plan(reading({ ask: { model: 'fable' } }), { model: 'fable', effort: 'high' }, 'opus', true)).toEqual({ main: { model: 'fable', effort: 'high' } })
  expect(plan(reading({ aside: true }), { model: 'sonnet', effort: 'medium' }, 'opus', true).handoff?.kind).toBe('aside')
  expect(plan(reading({ aside: true }), { model: 'sonnet', effort: 'medium' }, undefined, false).handoff).toBeUndefined()
  expect(plan(reading({ aside: true }), { model: 'haiku', effort: 'low' }, 'opus', true).handoff).toBeUndefined()
})

test('the floor only rises, never to fable; an ask can run below it', () => {
  expect(mainModel({ main: { model: 'sonnet', effort: 'low' } }, {}, 'opus')).toBe('opus')
  expect(mainModel({ main: { model: 'sonnet', effort: 'low' } }, { model: 'sonnet' }, 'opus')).toBe('sonnet')
  expect(nextFloor('opus', 'sonnet')).toBe('opus')
  expect(nextFloor('sonnet', 'opus')).toBe('opus')
  expect(nextFloor('fable', 'opus')).toBe('opus')
  expect(nextFloor('haiku', undefined)).toBe('haiku')
})

test('nods and long pastes', () => {
  expect(['ok', 'go ahead!', 'Pode seguir.', 'bora'].every(t => NOD.test(t))).toBe(true)
  expect(NOD.test('ok but use a map instead')).toBe(false)
  const long = trimRequest(`START${'.'.repeat(9000)}what is wrong here?`)
  expect(long.length).toBeLessThan(4100)
  expect(long.startsWith('START')).toBe(true)
  expect(long.endsWith('what is wrong here?')).toBe(true)
})
