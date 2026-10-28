import { expect, test } from 'claude-code/testing'
import { type Reading, NOD, RESUME_MS, RESUME_TOKENS, ownBrief, resumable, doesHandoffWork, escalated, handoffLabel, handoffNote, isLongCommand, isReadOnlyCommand, keepsScout, readKind, scouts, workEffort, gearFor, label, mainModel, needsConsent, nextFloor, plan, readReading, route, routeNote, stepDown, trimRequest, verifyAsk } from './policy'

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
    [{ reach: 'point', depth: 0, mode: 'answer' }, 'haiku·low'],
    [{ reach: 'point', depth: 0 }, 'haiku·medium'], // code: never below the coding effort (medium here)
    [{ reach: 'area', depth: 1 }, 'sonnet·medium'],
    [{ reach: 'system', depth: 2 }, 'opus·high'],
    [{ reach: 'frontier', depth: 3 }, 'fable·xhigh'],
    [{ reach: 'point', depth: 0, care: 'costly' }, 'opus·medium'],
    [{ reach: 'frontier', depth: 2, care: 'costly' }, 'fable·high'],
    [{ reach: 'system', depth: 2, ask: { model: 'sonnet', effort: 'max' } }, 'sonnet·max'],
  ]
  for (const [r, want] of cases) expect(label(gearFor(reading(r)))).toBe(want)
})

test('a standing coding effort lifts all code, small edits too, but not answers', () => {
  const cases: [Partial<Reading>, string][] = [
    [{ reach: 'area', depth: 1 }, 'sonnet·xhigh'],
    [{ reach: 'system', depth: 2 }, 'opus·xhigh'],
    [{ reach: 'point', depth: 0 }, 'haiku·xhigh'],
    [{ reach: 'point', depth: 0, mode: 'answer' }, 'haiku·low'],
    [{ reach: 'area', depth: 1, mode: 'answer' }, 'sonnet·medium'],
    [{ reach: 'area', depth: 3, mode: 'answer' }, 'sonnet·xhigh'],
  ]
  for (const [r, want] of cases) expect(label(gearFor(reading(r), 'xhigh'))).toBe(want)
  expect(label(gearFor(reading({ reach: 'area', depth: 2 }), 'medium'))).toBe('sonnet·high')
  expect(needsConsent({ model: 'opus', effort: 'xhigh' }, {}, undefined, 'xhigh')).toBe(false)
})

test('git chores follow their depth, never the coding effort; max stays for subtle code', () => {
  expect(label(gearFor(reading({ mode: 'commit', reach: 'point', depth: 0 }), 'xhigh'))).toBe('haiku·low')
  expect(label(gearFor(reading({ mode: 'commit', reach: 'point', depth: 1 }), 'xhigh'))).toBe('haiku·medium')
  expect(label(gearFor(reading({ reach: 'point', depth: 0 }), 'max'))).toBe('haiku·xhigh')
  expect(label(gearFor(reading({ reach: 'area', depth: 2 }), 'max'))).toBe('sonnet·max')
  const phases = [{ what: 'fix it', mode: 'code', depth: 1 }, { what: 'commit', mode: 'commit', depth: 0 }] as const
  expect(route([...phases], 'opus', 'xhigh', false).map(s => `${s.by} ${label(s.gear)}`)).toEqual(['main opus·xhigh', 'main opus·low'])
  expect(route([...phases], 'opus', 'xhigh', false, 'sonnet', true).map(s => `${s.by} ${label(s.gear)}`)).toEqual(['main opus·xhigh', 'agent haiku·low'])
  expect(plan(reading({ mode: 'commit', depth: 1 }), { model: 'opus', effort: 'medium' }, 'opus', true, 'opus', 'sonnet', true).handoff).toEqual({ kind: 'chore', gear: { model: 'sonnet', effort: 'medium' } })
  expect(plan(reading({ mode: 'commit', depth: 0 }), { model: 'opus', effort: 'low' }, 'opus', true, 'opus').handoff).toBeUndefined()
})

test('steer mode keeps the session model and still hands work off', () => {
  expect(plan(reading({ reach: 'point', depth: 0 }), { model: 'haiku', effort: 'low' }, 'opus', true, 'opus')).toEqual({ main: { model: 'opus', effort: 'low' } })
  expect(plan(reading({ mode: 'drive', care: 'costly' }), { model: 'opus', effort: 'medium' }, 'sonnet', true, 'sonnet').main.model).toBe('sonnet')
  expect(plan(reading({ reach: 'frontier' }), { model: 'fable', effort: 'high' }, 'opus', false, 'opus').handoff?.kind).toBe('deep')
  expect(plan(reading({ reach: 'frontier' }), { model: 'fable', effort: 'high' }, 'fable', false, 'fable')).toEqual({ main: { model: 'fable', effort: 'high' } })
})

test('steering a session below the work: weighty work goes to a subagent on the model the reading calls for', () => {
  const opusHigh = { model: 'opus', effort: 'high' } as const
  const opusXhigh = { model: 'opus', effort: 'xhigh' } as const
  // An analysis across the system, on Sonnet: an Opus subagent at the reading's effort; Sonnet briefs and judges.
  expect(plan(reading({ reach: 'system', depth: 2, mode: 'answer' }), opusHigh, 'sonnet', true, 'sonnet')).toEqual({ main: { model: 'sonnet', effort: 'high' }, handoff: { kind: 'deep', gear: opusHigh } })
  // Code across the system, at the coding effort; costly work, even small; never mechanical work.
  expect(plan(reading({ reach: 'system', depth: 1 }), opusXhigh, 'sonnet', true, 'sonnet').handoff).toEqual({ kind: 'deep', gear: opusXhigh })
  expect(plan(reading({ reach: 'point', depth: 1, mode: 'answer', care: 'costly' }), { model: 'opus', effort: 'medium' }, 'sonnet', true, 'sonnet').handoff?.kind).toBe('deep')
  expect(plan(reading({ reach: 'point', depth: 0, mode: 'code', care: 'costly' }), { model: 'opus', effort: 'medium' }, 'sonnet', true, 'sonnet').handoff).toBeUndefined()
  expect(plan(reading({ reach: 'system', depth: 0 }), opusXhigh, 'sonnet', true, 'sonnet').handoff).toBeUndefined()
  // A plain answer about the system stays here, and so does work Sonnet is enough for.
  expect(plan(reading({ reach: 'system', depth: 1, mode: 'answer' }), { model: 'opus', effort: 'medium' }, 'sonnet', true, 'sonnet')).toEqual({ main: { model: 'sonnet', effort: 'medium' } })
  expect(plan(reading({ reach: 'area', depth: 2 }), { model: 'sonnet', effort: 'xhigh' }, 'sonnet', true, 'sonnet').handoff).toBeUndefined()
  // A git chore stays a chore.
  expect(plan(reading({ mode: 'commit', care: 'costly' }), { model: 'opus', effort: 'medium' }, 'sonnet', true, 'sonnet').handoff).toBeUndefined()
  // An Opus session does it itself; an ask for Opus moves the turn instead; shift mode moves the main model.
  expect(plan(reading({ reach: 'system', depth: 2 }), opusXhigh, 'opus', true, 'opus').handoff).toBeUndefined()
  expect(plan(reading({ reach: 'system', depth: 2, ask: { model: 'opus' } }), opusXhigh, 'sonnet', true, 'sonnet').handoff).toBeUndefined()
  expect(plan(reading({ reach: 'system', depth: 2 }), opusXhigh, 'sonnet', true).handoff).toBeUndefined()
  // A side task keeps its own hand-off.
  expect(plan(reading({ reach: 'system', depth: 2, aside: true }), opusXhigh, 'sonnet', true, 'sonnet').handoff?.kind).toBe('aside')
  // The brief carries what the subagent cannot see, and the findings come back in full.
  const note = handoffNote({ kind: 'deep', gear: opusHigh })
  expect(note).toContain('model "opus" and effort "high"')
  expect(note).toContain('tried and ruled out')
  expect(note).toContain('in full')
})

test('a hard browser check below Opus is judged by an Opus subagent, not the main model', () => {
  const nav = { model: 'sonnet', effort: 'low' } as const
  const hard = plan(reading({ reach: 'system', mode: 'drive', depth: 2 }), { model: 'opus', effort: 'xhigh' }, 'sonnet', true, 'sonnet')
  expect(hard).toEqual({ main: { model: 'sonnet', effort: 'medium' }, handoff: { kind: 'drive', gear: nav, judge: { model: 'opus', effort: 'high' } } })
  expect(handoffNote(hard.handoff!)).toContain('3. Start a plain Agent (no subagent_type) with model "opus" and effort "high"')
  expect(handoffLabel(hard.handoff!)).toBe('drive → sonnet·low, judge opus·high')
  // Sonnet is enough for it, or the main model is Opus already: the main model judges, as before.
  expect(plan(reading({ mode: 'drive', depth: 2 }), { model: 'sonnet', effort: 'xhigh' }, 'sonnet', true, 'sonnet').handoff).toEqual({ kind: 'drive', gear: nav })
  expect(plan(reading({ reach: 'system', mode: 'drive', depth: 2 }), { model: 'opus', effort: 'xhigh' }, 'opus', true, 'opus').handoff).toEqual({ kind: 'drive', gear: nav })
  expect(handoffNote({ kind: 'drive', gear: nav })).toContain('3. Analyze that evidence here')
})

test('a route below the model it calls for hands its subtle and costly steps to subagents on it', () => {
  const phases = [
    { what: 'read the ticket', mode: 'lookup', depth: 0 },
    { what: 'plan it', mode: 'answer', depth: 2 },
    { what: 'build it', mode: 'code', depth: 2 },
    { what: 'tidy up', mode: 'code', depth: 1 },
    { what: 'check it in Chrome', mode: 'drive', depth: 2 },
    { what: 'commit', mode: 'commit', depth: 0 },
  ] as const
  const steps = route([...phases], 'sonnet', 'xhigh', false, 'sonnet', false, 'opus')
  expect(steps.map(s => `${s.what} → ${s.by} ${label(s.gear)}`)).toEqual([
    'read the ticket → agent haiku·low',
    'plan it → agent opus·high',
    'build it → agent opus·xhigh',
    'tidy up → main sonnet·xhigh',
    'check it in Chrome: navigate → agent sonnet·low',
    'check it in Chrome: analyze → agent opus·high',
    'commit → main sonnet·low',
  ])
  expect(steps.filter(escalated).map(s => s.mainEffort)).toEqual(['high', 'high', 'high'])
  const note = routeNote(steps)
  expect(note).toContain('3. build it: start a plain Agent (no subagent_type) with model "opus" and effort "xhigh" with a brief that stands on its own')
  expect(note).toContain('6. check it in Chrome: analyze: start a plain Agent (no subagent_type) with model "opus" and effort "high"')
  // A costly request lifts even its ordinary code; work that only calls for the main model stays with it.
  expect(route([{ what: 'fix the refund', mode: 'code', depth: 1 }], 'sonnet', 'xhigh', true, 'sonnet', false, 'opus').map(s => `${s.by} ${label(s.gear)}`)).toEqual(['agent opus·xhigh'])
  expect(route([...phases], 'sonnet', 'xhigh', false).filter(escalated)).toHaveLength(0)
  expect(route([...phases], 'opus', 'xhigh', false, 'sonnet', false, 'opus').filter(escalated)).toHaveLength(0)
  // A route whose only main work is a subagent's still starts at the effort of briefing it.
  expect(workEffort(route([{ what: 'read', mode: 'lookup', depth: 0 }, { what: 'build', mode: 'code', depth: 3 }], 'sonnet', 'xhigh', false, 'sonnet', false, 'opus'))).toBe('high')
})

test('the escalate setting: code hands up only work that changes files; off keeps everything on the session', () => {
  const opusHigh = { model: 'opus', effort: 'high' } as const
  const question = reading({ reach: 'system', depth: 2, mode: 'answer' })
  const fix = reading({ reach: 'system', depth: 1 })
  const check = reading({ reach: 'system', mode: 'drive', depth: 2 })
  expect(plan(question, opusHigh, 'sonnet', true, 'sonnet', 'sonnet', false, 'code')).toEqual({ main: { model: 'sonnet', effort: 'high' } })
  expect(plan(fix, opusHigh, 'sonnet', true, 'sonnet', 'sonnet', false, 'code').handoff?.kind).toBe('deep')
  expect(plan(check, opusHigh, 'sonnet', true, 'sonnet', 'sonnet', false, 'code').handoff?.judge).toEqual(opusHigh)
  for (const r of [question, fix]) expect(plan(r, opusHigh, 'sonnet', true, 'sonnet', 'sonnet', false, 'off').handoff).toBeUndefined()
  expect(plan(check, opusHigh, 'sonnet', true, 'sonnet', 'sonnet', false, 'off').handoff?.judge).toBeUndefined()
  // Off on a steered session also keeps Fable work here; a Haiku session that shifts models is not steered.
  expect(plan(reading({ reach: 'frontier', depth: 2 }), { model: 'fable', effort: 'high' }, 'sonnet', true, 'sonnet', 'sonnet', false, 'off').handoff).toBeUndefined()
  expect(plan(reading({ reach: 'frontier', depth: 2 }), { model: 'fable', effort: 'high' }, 'opus', true, undefined, 'sonnet', false, 'off').handoff?.kind).toBe('deep')
  const phases = [{ what: 'plan it', mode: 'answer', depth: 2 }, { what: 'build it', mode: 'code', depth: 2 }] as const
  expect(route([...phases], 'sonnet', 'xhigh', false, 'sonnet', false, 'opus', 'code').map(s => s.by)).toEqual(['main', 'agent'])
  expect(route([...phases], 'sonnet', 'xhigh', false, 'sonnet', false, 'opus', 'off').map(s => s.by)).toEqual(['main', 'main'])
})

test('deep work goes on in the agent that holds it, while that is worth it', () => {
  const gear = { model: 'opus', effort: 'high' } as const
  const note = handoffNote({ kind: 'deep', gear, resume: 'a42' })
  expect(note).toContain('SendMessage to "a42"')
  expect(note).toContain('Start no new agent unless that one no longer answers')
  expect(note).toContain('model "opus" and effort "high"')
  expect(handoffLabel({ kind: 'deep', gear, resume: 'a42' })).toBe('deep (same agent) → opus·high')
  const agent = { id: 'a42', gear, at: 1_000, tokens: 80_000 }
  expect(resumable(agent, 1_000 + RESUME_MS - 1)).toBe(true)
  expect(resumable(agent, 1_000 + RESUME_MS)).toBe(false) // its cache has gone cold
  expect(resumable({ ...agent, tokens: RESUME_TOKENS }, 2_000)).toBe(false) // a fresh brief would read less
  expect(resumable(undefined, 2_000)).toBe(false)
})

test('a stronger model’s brief carries the person’s own recent words, latest last, long ones cut to their end', () => {
  expect(ownBrief([])).toBe('')
  const added = ownBrief(['first', 'second', 'the gateway quotes differ', '', `${'x'.repeat(2000)}why do they differ?`])
  expect(added).toContain("the person's own recent messages")
  expect(added).not.toContain('> first')
  expect(added.indexOf('> the gateway quotes differ')).toBeLessThan(added.indexOf('why do they differ?'))
  expect(added).toContain('> […] x')
  expect(added.length).toBeLessThan(2000)
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

test('a reply that corrects itself is read by its correction; echoed keys and a top-level lookup are tolerated', () => {
  // Word for word what Haiku sent in a real desktop session (from the gearbox log).
  const reply = `{"reach":"system","point":null,"area":null,"system":"many files","frontier":null,"care":"routine","depth":2,"mode":"code","aside":false,"cont":true,"ask":{},"sure":false,"phases":[]}

Wait, the output above has a problem: it uses "system" as both the reach key's value and a separate key. Here is the corrected object:

{"reach":"system","care":"routine","depth":2,"mode":"code","aside":false,"cont":false,"ask":{},"sure":true,"phases":[]}`
  expect(readReading(reply)).toMatchObject({ reach: 'system', depth: 2, cont: false, sure: true })
  expect(readReading('{"reach":"point","point":"look up the PR url","care":"routine","depth":0,"mode":"lookup","sure":true}')?.mode).toBe('answer')
  expect(readReading('{"reach":"area","depth":1} and a stray } brace')?.reach).toBe('area')
  expect(readReading('Here: {"reach":"area","depth":1,"note":"a } inside a string"}')?.reach).toBe('area')
})

test('isReadOnlyCommand passes only commands that read', () => {
  for (const c of [
    'gh pr checks 333 --repo mdfcvp/swanson 2>&1 | head -30',
    'gh run view 40587716288 --repo mdfcvp/swanson --job 1 --log-failed 2>&1 | grep -E "FAIL|✗|×" | head -40',
    "cd /repo/worktree && sed -n 670,720p scripts/lib/a.integration.test.ts",
    'git -C /repo log --oneline -5 && git status -sb',
    "for r in 405 406; do echo \"== $r\"; gh run view $r --repo x/y --json jobs -q '.jobs[]'; done",
    'grep -rn "invalid_duration" services/core/src --include=*.ts | grep -v test | head -10',
    'gh api repos/gnuh/gearbox/pulls/14 2>/dev/null',
    'git branch -a',
  ])
    expect(isReadOnlyCommand(c)).toBe(true)
  for (const c of [
    'cp scripts/a.ts /tmp/b.ts',
    'sed -i s/a/b/ f.ts',
    'git stash',
    'git branch -D old',
    'git commit -m "read only"',
    'gh pr edit 333 --body-file notes.md',
    'gh api -X POST repos/x/y/issues',
    'echo hi > f.txt',
    'npm test',
    'find . -name "*.tmp" -delete',
    'cat $(ls)',
    "python3 -c 'print(1)'",
  ])
    expect(isReadOnlyCommand(c)).toBe(false)
})

test('a run of reads ignores plan updates; Haiku keeps only replies that read and say little', () => {
  const read = { name: 'Bash', input: { command: 'gh pr checks 1' } }
  const plan = { name: 'mcp__ccd_turn__update_plan', input: {} }
  expect(readKind([plan, read])).toBe('read')
  expect(readKind([plan])).toBe('aside')
  expect(readKind([read, { name: 'Edit', input: {} }])).toBe('other')
  expect(readKind([])).toBe('other')
  const reply = { stopReason: 'tool_use', answer: 'Reading the log.', toolUses: [read] }
  expect(keepsScout(reply)).toBe(true)
  expect(keepsScout({ ...reply, toolUses: [plan, read] })).toBe(false)
  expect(keepsScout({ ...reply, answer: 'x'.repeat(700) })).toBe(false)
  expect(keepsScout({ stopReason: 'end_turn', answer: 'Done.', toolUses: [] })).toBe(false)
  expect(scouts(1, false)).toBe(false)
  expect(scouts(2, false)).toBe(true)
  expect(scouts(1, true)).toBe(true)
})
