import { expect, test } from 'claude-code/testing'
import { type Reading, NOD, doesHandoffWork, isLongCommand, workEffort, gearFor, label, mainModel, needsConsent, nextFloor, plan, readReading, route, routeNote, stepDown, trimRequest, verifyAsk } from './policy'

const reading = (o: Partial<Reading> = {}): Reading => ({ reach: 'area', care: 'routine', depth: 1, mode: 'code', aside: false, cont: false, ask: {}, sure: true, phases: [], ...o })

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

test('a standing coding effort lifts code turns, not answers or trivial edits', () => {
  const cases: [Partial<Reading>, string][] = [
    [{ reach: 'area', depth: 1 }, 'sonnet·xhigh'],
    [{ reach: 'system', depth: 2 }, 'opus·xhigh'],
    [{ reach: 'point', depth: 0 }, 'haiku·low'],
    [{ reach: 'area', depth: 1, mode: 'answer' }, 'sonnet·medium'],
    [{ reach: 'area', depth: 3, mode: 'answer' }, 'sonnet·xhigh'],
  ]
  for (const [r, want] of cases) expect(label(gearFor(reading(r), 'xhigh'))).toBe(want)
  expect(label(gearFor(reading({ reach: 'area', depth: 2 }), 'medium'))).toBe('sonnet·high')
  expect(needsConsent({ model: 'opus', effort: 'xhigh' }, {}, undefined, 'xhigh')).toBe(false)
})

test('steer mode keeps the session model and still hands work off', () => {
  expect(plan(reading({ reach: 'point', depth: 0 }), { model: 'haiku', effort: 'low' }, 'opus', true, 'opus')).toEqual({ main: { model: 'opus', effort: 'low' } })
  expect(plan(reading({ mode: 'drive', care: 'costly' }), { model: 'opus', effort: 'medium' }, 'sonnet', true, 'sonnet').main.model).toBe('sonnet')
  expect(plan(reading({ reach: 'frontier' }), { model: 'fable', effort: 'high' }, 'opus', false, 'opus').handoff?.kind).toBe('deep')
  expect(plan(reading({ reach: 'frontier' }), { model: 'fable', effort: 'high' }, 'fable', false, 'fable')).toEqual({ main: { model: 'fable', effort: 'high' } })
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
  expect(drive).toEqual({ main: { model: 'opus', effort: 'medium' }, handoff: { kind: 'drive', gear: { model: 'sonnet', effort: 'low' } } })
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

test('a multi-step request becomes a route: each step on its own executor and effort', () => {
  const r = readReading(JSON.stringify({
    reach: 'system', depth: 2, mode: 'code',
    phases: [
      { what: 'read the Jira task', mode: 'lookup', depth: 0 },
      { what: 'build the change', mode: 'code', depth: 2 },
      { what: 'check it in Chrome', mode: 'drive', depth: 1 },
      { what: 'run Playwright', mode: 'wait', depth: 0 },
      { what: 'commit', mode: 'commit', depth: 0 },
      { what: 'bogus', mode: 'dance', depth: 1 },
    ],
  }))!
  expect(r.phases).toHaveLength(5)
  const steps = route(r.phases, 'opus', 'xhigh', false)
  expect(steps.map(s => `${s.what} → ${s.by} ${label(s.gear)}`)).toEqual([
    'read the Jira task → agent haiku·low',
    'build the change → main opus·xhigh',
    'check it in Chrome: navigate → agent sonnet·low',
    'check it in Chrome: analyze → main opus·medium',
    'run Playwright → agent haiku·low',
    'commit → main opus·low',
  ])
  const note = routeNote(steps)
  expect(note).toContain('mcp__gearbox__phase')
  expect(note).toContain('3. check it in Chrome: navigate: start an Agent with model "sonnet"')
  expect(note).toContain('judge pass or fail')
  expect(note).toContain('4. check it in Chrome: analyze: judge the evidence yourself')
})

test('the navigator setting picks the model that clicks; analysis stays with the main model', () => {
  const steps = route([{ what: 'check it in Chrome', mode: 'drive', depth: 1 }], 'opus', 'medium', false, 'haiku')
  expect(steps.map(s => `${s.by} ${label(s.gear)}`)).toEqual(['agent haiku·low', 'main opus·medium'])
  expect(plan(reading({ mode: 'drive' }), { model: 'sonnet', effort: 'medium' }, 'opus', true, 'opus', 'haiku').handoff?.gear.model).toBe('haiku')
  expect(plan(reading({ mode: 'drive' }), { model: 'sonnet', effort: 'medium' }, 'opus', true, 'opus').handoff?.gear.model).toBe('sonnet')
})

test('a model named for a step wins over the navigator setting', () => {
  const [nav] = route([{ what: 'check it', mode: 'drive', depth: 1, ask: 'haiku' }], 'opus', 'medium', false, 'sonnet')
  expect(label(nav!.gear)).toBe('haiku·low')
  const [look] = route([{ what: 'read it', mode: 'lookup', depth: 0, ask: 'sonnet' }], 'opus', 'medium', false)
  expect(label(look!.gear)).toBe('sonnet·low')
  expect(plan(reading({ mode: 'drive', ask: { model: 'haiku' } }), { model: 'sonnet', effort: 'medium' }, 'opus', true, 'opus').handoff?.gear.model).toBe('haiku')
  expect(readReading('{"reach":"area","depth":1,"phases":[{"what":"x","mode":"drive","depth":1,"ask":"gpt"}]}')?.phases[0]?.ask).toBeUndefined()
})

test('workEffort is the highest main step; doesHandoffWork spots tools a subagent should run', () => {
  const steps = route([{ what: 'read', mode: 'lookup', depth: 0 }, { what: 'build', mode: 'code', depth: 1 }, { what: 'commit', mode: 'commit', depth: 0 }], 'opus', 'xhigh', false)
  expect(workEffort(steps)).toBe('xhigh')
  expect(['Bash', 'mcp__claude-in-chrome__navigate', 'mcp__playwright__browser_click'].every(doesHandoffWork)).toBe(true)
  expect(['Read', 'Edit', 'Agent', 'mcp__gearbox__phase'].some(doesHandoffWork)).toBe(false)
})

test('strict looks at the command, not its quoted text or heredocs', () => {
  expect(isLongCommand('npm run build')).toBe(true)
  expect(isLongCommand('npx playwright test --project=chromium')).toBe(true)
  expect(isLongCommand('git commit -m "gearbox: lição sobre o build e os tests"')).toBe(false)
  expect(isLongCommand("git commit -m 'deploy notes'")).toBe(false)
  expect(isLongCommand("git commit -F - <<'EOF'\nrun the e2e build\nEOF")).toBe(false)
  expect(isLongCommand('cat package.json')).toBe(false)
})
