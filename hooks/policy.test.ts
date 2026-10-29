import { expect, test } from 'claude-code/testing'
import { type FanPart, type Reading, BRIEFING_TOOLS, NOD, RESUME_MS, RESUME_TOKENS, SURVEY, ownBrief, resumable, doesHandoffWork, escalated, fanReply, handoffLabel, handoffNote, isLongCommand, isReadOnlyCommand, isSkillFork, readParts, reviewGear, reviews, workEffort, gearFor, label, mainModel, needsConsent, nextFloor, plan, readReading, route, routeNote, stepDown, trimRequest, verifyAsk, filesReach, goAhead, namedFiles, workFloor } from './policy'

const reading = (o: Partial<Reading> = {}): Reading => ({ reach: 'area', care: 'routine', depth: 1, mode: 'code', aside: false, ahead: false, cont: false, ask: {}, sure: true, phases: [], parts: [], ...o })

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

test('a review is read by at least Opus; its effort follows its depth as an answer’s, never the coding effort', () => {
  expect(SURVEY).toContain('review (look over a change, diff, pull request or code for bugs and problems, without changing it)')
  expect(readReading('{"reach":"area","depth":1,"mode":"review"}')?.mode).toBe('review')
  const cases: [Partial<Reading>, string][] = [
    [{ mode: 'review', reach: 'point', depth: 0 }, 'opus·low'],
    [{ mode: 'review', reach: 'area', depth: 1 }, 'opus·medium'],
    [{ mode: 'review', reach: 'system', depth: 2 }, 'opus·high'],
    [{ mode: 'review', reach: 'area', depth: 3 }, 'opus·xhigh'],
    [{ mode: 'review', reach: 'frontier', depth: 2 }, 'fable·high'],
    [{ mode: 'review', reach: 'point', depth: 0, care: 'costly' }, 'opus·medium'],
    [{ mode: 'review', reach: 'area', depth: 1, ask: { model: 'sonnet', effort: 'high' } }, 'sonnet·high'],
  ]
  for (const [r, want] of cases) expect(label(gearFor(reading(r), 'xhigh'))).toBe(want)
  // One rule for a review prompt and a reviewing skill's fork: the model at least Opus, the effort as it comes.
  expect(reviewGear({ model: 'sonnet', effort: 'low' })).toEqual({ model: 'opus', effort: 'low' })
  expect(reviewGear({ model: 'fable', effort: 'high' })).toEqual({ model: 'fable', effort: 'high' })
  // A review step in a route is an answer step, not one dropped.
  const steps = readReading('{"reach":"area","depth":1,"phases":[{"what":"fetch the PR","mode":"lookup","depth":0},{"what":"review it","mode":"review","depth":1}]}')?.phases
  expect(steps?.map(p => p.mode)).toEqual(['lookup', 'answer'])
})

test('steering below Opus: a review goes to an Opus agent at any depth, unless escalate is off', () => {
  const r = reading({ mode: 'review', depth: 1 })
  const want = gearFor(r)
  expect(want).toEqual({ model: 'opus', effort: 'medium' })
  expect(plan(r, want, 'sonnet', true, 'sonnet')).toEqual({ main: { model: 'sonnet', effort: 'high' }, handoff: { kind: 'deep', gear: want } })
  expect(plan(reading({ mode: 'review', reach: 'point', depth: 0 }), { model: 'opus', effort: 'low' }, 'sonnet', true, 'sonnet').handoff).toEqual({ kind: 'deep', gear: { model: 'opus', effort: 'low' } })
  // `code` hands up what changes files and every review, which is never an answer; only `off` keeps one here.
  expect(plan(r, want, 'sonnet', true, 'sonnet', 'sonnet', false, 'code')).toEqual({ main: { model: 'sonnet', effort: 'high' }, handoff: { kind: 'deep', gear: want } })
  expect(plan(r, want, 'sonnet', true, 'sonnet', 'sonnet', false, 'off')).toEqual({ main: { model: 'sonnet', effort: 'medium' } })
  // An Opus session reviews itself; a Haiku session shifts up to Opus.
  expect(plan(r, want, 'opus', true, 'opus')).toEqual({ main: want })
  expect(plan(r, want, 'haiku', true)).toEqual({ main: want })
})

test('a review is handed up when the survey is unsure too, on its best guess; any other guess hands nothing up', () => {
  const r = reading({ mode: 'review', depth: 1, sure: false })
  const want = gearFor(r)
  expect(want).toEqual(gearFor({ ...r, sure: true })) // the same best guess for the effort
  for (const escalate of ['on', 'code'] as const)
    expect(plan(r, want, 'sonnet', true, 'sonnet', 'sonnet', false, escalate)).toEqual({ main: { model: 'sonnet', effort: 'high' }, handoff: { kind: 'deep', gear: want } })
  expect(plan(r, want, 'sonnet', true, 'sonnet', 'sonnet', false, 'off')).toEqual({ main: { model: 'sonnet', effort: 'medium' } })
  // An Opus session reviews itself, a Haiku session shifts up to Opus, as for a sure review.
  expect(plan(r, want, 'opus', true, 'opus')).toEqual({ main: want })
  expect(plan(r, want, 'haiku', true)).toEqual({ main: want })
  // A guess about anything else stays home, however weighty it would be: effort only.
  for (const mode of ['code', 'answer', 'drive', 'wait', 'commit'] as const) {
    const g = reading({ mode, reach: 'system', depth: 3, care: 'costly', sure: false })
    const call = gearFor(g, 'xhigh')
    expect(plan(g, call, 'sonnet', true, 'sonnet')).toEqual({ main: { model: 'sonnet', effort: call.effort } })
    expect(plan(g, call, 'haiku', true)).toEqual({ main: call })
  }
})

test('a reviewing skill is known by its name, and its fork by how the engine lists it', () => {
  expect(['code-review', 'security-review', 'github:code-review', 'Review'].every(reviews)).toBe(true)
  expect(['simplify', 'graphify', 'commit'].some(reviews)).toBe(false)
  // As the real fork's transcript meta named it: "name":"code-review", "description":"/code-review https://…".
  expect(isSkillFork({ name: 'code-review', description: '/code-review https://github.com/acme/shop/pull/68' }, 'code-review')).toBe(true)
  expect(isSkillFork({ description: '/code-review https://github.com/acme/shop/pu…' }, 'code-review')).toBe(true)
  expect(isSkillFork({ description: '/code-review' }, 'code-review')).toBe(true)
  expect(isSkillFork({ name: 'code-review' }, 'github:code-review')).toBe(true)
  expect(isSkillFork({ name: 'reviewer', description: 'review the diff' }, 'code-review')).toBe(false)
  expect(isSkillFork({ description: '/code-reviewer x' }, 'code-review')).toBe(false)
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
  // The brief carries what the subagent cannot see; its report reaches the person as it comes back, so the main
  // model adds its review, not a copy.
  const note = handoffNote({ kind: 'deep', gear: opusHigh })
  expect(note).toContain('model "opus" and effort "high"')
  expect(note).toContain('tried and ruled out')
  expect(note).toContain('reply with your review only')
  expect(note).not.toContain('in full, not cut down')
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
    'tidy up → agent opus·xhigh',
    'check it in Chrome: navigate → agent sonnet·low',
    'check it in Chrome: analyze → agent opus·high',
    'commit → main sonnet·low',
  ])
  expect(steps.filter(escalated).map(s => s.mainEffort)).toEqual(['high', 'high', 'high', 'high'])
  // Code goes up past a mechanical edit, as a single request's does; a mechanical step stays here.
  expect(route([{ what: 'rename it', mode: 'code', depth: 0 }], 'sonnet', 'xhigh', false, 'sonnet', false, 'opus').map(s => `${s.by} ${label(s.gear)}`)).toEqual(['main sonnet·xhigh'])
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

test('the escalate setting: code hands up work that changes files and reviews, not answers; off keeps everything on the session', () => {
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
  // A proposal read as the work it lays out gets more room.
  const proposal = trimRequest(`START${'.'.repeat(20000)}go ahead?`, 8000)
  expect(proposal.length).toBeLessThan(8100)
  expect(proposal.startsWith('START')).toBe(true)
  expect(proposal.endsWith('go ahead?')).toBe(true)
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

test('the survey lists parts that can run side by side, kept only when well formed, at most six; in doubt it does not split', () => {
  expect(SURVEY).toContain('"parts":[]')
  expect(SURVEY).toContain('When in doubt, do not split')
  const r = readReading(JSON.stringify({
    reach: 'system', depth: 2, mode: 'code',
    parts: [
      { what: 'orders: add paging', mode: 'code', depth: 1, files: ['services/orders', 3, '  ', ' services/orders/api.ts '] },
      { what: 'review the retry change', mode: 'review', depth: 1 },
      { what: 'tap dance', mode: 'dance', depth: 1, files: [] },
      { what: 'too deep', mode: 'code', depth: 5 },
      { what: 'click around', mode: 'drive', depth: 1 },
      { mode: 'lookup', depth: 0, files: 'docs' },
      null,
    ],
  }))!
  expect(r.parts).toEqual([
    { what: 'orders: add paging', mode: 'code', depth: 1, files: ['services/orders', 'services/orders/api.ts'] },
    { what: 'review the retry change', mode: 'review', depth: 1, files: [] },
    { what: 'lookup', mode: 'lookup', depth: 0, files: [] },
  ])
  // Steps one after another stay phases; parts are a list of their own.
  expect(r.phases).toEqual([])
  const many = Array.from({ length: 9 }, (_, i) => ({ what: `part ${i}`, mode: 'answer', depth: 1 }))
  expect(readReading(JSON.stringify({ reach: 'area', depth: 1, parts: many }))?.parts).toHaveLength(6)
  expect(readReading('{"reach":"area","depth":1}')?.parts).toEqual([])
  expect(readReading('{"reach":"area","depth":1,"parts":"all of it"}')?.parts).toEqual([])
  // The fan tool's parts are read by the same rules.
  expect(readParts([{ what: 'deploy prepost', mode: 'wait', depth: 1, files: ['prepost'] }, { what: 'x', mode: 'drive', depth: 1 }, 'part'])).toEqual([{ what: 'deploy prepost', mode: 'wait', depth: 1, files: ['prepost'] }])
  expect(readParts(undefined)).toEqual([])
})

test('a go-ahead is read as the work it approves: the survey takes the assistant’s proposal as the request, and the message only says whether it goes ahead', () => {
  expect(SURVEY).toContain('When "approved" is true, "request" is not a message but the work the assistant proposed or has left to do, which the person has just approved')
  expect(SURVEY).toContain('approves or asks to go on with work the assistant proposed or is doing')
  expect(SURVEY).toContain("takes that work's mode, not answer, and that work's reach, care and depth, which \"reply\" lays out, not those of its own few words")
  expect(SURVEY).toContain('"aside":false,"ahead":false,"cont":false')
  expect(SURVEY).toContain('- ahead: true if the request approves, accepts or asks to go on with work the assistant proposed or is doing in "reply", with or without changes of its own.')
  // Whether a go-ahead adds anything is all cont says; the work's gear comes from the work.
  expect(SURVEY).toContain('- cont: true if the request only continues, approves or repeats the previous turn and adds nothing new.\n')
  // A schema migration and an audit trail are costly mistakes; a shared module is a system's reach.
  expect(SURVEY).toContain('audit trails, deleting or migrating data, database schema changes')
  expect(SURVEY).toContain('a change to a shared module much of the project depends on')
  expect(readReading('{"reach":"area","depth":1,"ahead":true}')).toMatchObject({ ahead: true, cont: false })
})

// What the assistant proposed in the session where "lets do it" ran on Sonnet.
const PLAN = `Plan for GAUNTLET-1200:
1. Add the SQL migration \`db/migrations/V45__audit_entries.sql\` (a new \`audit_entries\` table).
2. Record audit events in \`core/src/audit/AuditService.kt\` and \`core/src/audit/AuditRepository.kt\`.
3. New routes in the shared Core module: \`core/src/routes/AdminRoutes.kt\`.
4. Tests in \`core/src/test/AuditServiceTest.kt\`.
Want me to go ahead?`

test('what a proposal shows for sure: a schema or data migration is costly, whatever words name it', () => {
  expect(workFloor(PLAN)).toEqual({ care: 'costly', reach: 'system' })
  for (const costly of ['ALTER TABLE orders ADD COLUMN actor_id uuid', '`alter table orders add column actor_id uuid`', 'create table if not exists audit_entries (id uuid)', 'CREATE INDEX idx_audit ON audit(at)', 'a new file `prisma/migrations/2026_audit/migration.sql`', 'add `V12_1__audit.sql`', '1. **Migration `0260_account_notes.sql`:** a new table with RLS', '`000001_init.up.sql`', 'write a SQL migration for it', 'a Flyway migration', 'then run `prisma migrate dev`', 'a data migration to backfill actors', 'the migration file'])
    expect(workFloor(costly).care).toBe('costly')
  // A bare "migration" may be a framework's or a codemod's, a bare .sql file a query's, lower-case SQL words a UI's;
  // words in passing never count.
  for (const routine of ['migrate the page to React 19', 'write a migration guide for v3', 'a migration script with jscodeshift', 'create type definitions for the client', 'create index.ts re-exporting the helpers', 'add column sorting to the orders grid', 'drag and drop table rows', 'alter table styling for dark mode', 'tweak `reports/monthly.sql`', 'handle the migration/upgrade path', 'the auth middleware stays as it is'])
    expect(workFloor(routine).care).toBeUndefined()
})

test('the files a proposal names: code spans only, each once, tests aside, by the rule a fan-out part’s files follow', () => {
  expect(namedFiles('see `src/a.ts:12`, `src/a.ts`, `a.ts` and `https://x.dev/b.ts`; Node.js and Next.js are prose')).toEqual(['src/a.ts'])
  expect(namedFiles('`bun test src/quote.test.ts` then `src/quote.ts#L3-L9`')).toEqual(['src/quote.test.ts', 'src/quote.ts'])
  // Three files and their tests are a feature's; a fourth source file, or three top-level folders, a system's.
  expect(workFloor('`src/a.ts` `src/b.ts` `src/c.ts` `src/a.test.ts` `src/b.spec.ts` `tests/c.py`').reach).toBeUndefined()
  expect(workFloor('`src/a.ts` `src/b.ts` `src/c.ts` `src/d.ts`').reach).toBe('system')
  expect(workFloor('`api/a.ts` `web/b.ts` `core/c.kt`').reach).toBe('system')
  expect(workFloor('`FooTest.kt` `BarTests.cs` `baz_test.go` `test_qux.py` `latest.ts`')).toEqual({})
  expect(filesReach([])).toBeUndefined()
})

test('a go-ahead is read by the work it approves, raised by what the proposal shows and by its own words, never lowered', () => {
  const work = reading({ phases: [{ what: 'migration', mode: 'code', depth: 1 }, { what: 'routes', mode: 'code', depth: 1 }] })
  // A nod: the work alone, lifted by the proposal's sure signs; the proposal's steps are one piece of work, in order.
  expect(goAhead(work, undefined, { care: 'costly', reach: 'system' })).toEqual(reading({ reach: 'system', care: 'costly', ahead: true }))
  // "lets do it", read on its own few words as a small routine continuation, lowers nothing.
  const lets = reading({ reach: 'point', depth: 0, cont: true, ahead: true })
  expect(goAhead(reading({ reach: 'system', care: 'costly', depth: 2 }), lets, {})).toEqual(reading({ reach: 'system', care: 'costly', depth: 2, ahead: true }))
  // That session's turn: an area-sized reading of the plan still runs on Opus, by what the plan shows.
  expect(gearFor(goAhead(reading(), lets, workFloor(PLAN))!, 'xhigh')).toEqual({ model: 'opus', effort: 'xhigh' })
  // A message that adds something keeps its own mode, steps and asks.
  const but = reading({ mode: 'answer', depth: 2, ahead: true, ask: { model: 'opus' }, phases: [{ what: 'explain the rollback', mode: 'answer', depth: 2 }] })
  expect(goAhead(work, but, {})).toMatchObject({ mode: 'answer', depth: 2, ask: { model: 'opus' }, phases: but.phases })
  // Its parts are the person's, else the work's.
  const parts = [{ what: 'a', mode: 'code', depth: 1, files: ['a'] }, { what: 'b', mode: 'code', depth: 1, files: ['b'] }] as const
  expect(goAhead(reading({ parts: [...parts] }), lets, {})?.parts).toEqual([...parts])
  // Unread, the work is code at the proposal's sure signs; with none, there is nothing to go by.
  expect(goAhead(undefined, undefined, { care: 'costly' })).toEqual(reading({ care: 'costly', ahead: true }))
  expect(goAhead(undefined, lets, {})).toBeUndefined()
})

test('the fan tool answers each part’s agent and asks for all of them in one message', () => {
  const haiku = { model: 'haiku', effort: 'low' } as const
  const sonnet = { model: 'sonnet', effort: 'high' } as const
  const reads = fanReply([{ what: 'deploy prepost', gear: haiku, edits: false, resume: 'lane-h' }, { what: 'deploy backend', gear: haiku, edits: false }])
  expect(reads).toContain('2 independent parts')
  expect(reads).toContain('part 1: deploy prepost: SendMessage to "lane-h", the haiku lane')
  expect(reads).toContain('part 2: deploy backend: model "haiku", gearbox runs it at low; only reads')
  expect(reads).toContain('in ONE message')
  expect(reads).toContain('run_in_background false')
  expect(reads).toContain('for that part alone')
  expect(reads).not.toContain('worktree')
  expect(reads).not.toContain('effort "') // gearbox sets each part's effort, not the call
  const edits = fanReply([{ what: 'orders: add paging', gear: sonnet, edits: true }, { what: 'billing: fix rounding', gear: sonnet, edits: true }])
  expect(edits).toContain('part 1: orders: add paging: model "sonnet", gearbox runs it at high; edits files, isolation "worktree"')
  expect(edits).toContain('merge the worktree branches')
  expect(edits).not.toContain('SendMessage')
  // The main conversation may call it while a hand-off is owed: it only plans.
  expect(BRIEFING_TOOLS.test('mcp__gearbox__fan')).toBe(true)
})

test('the fan-out note starts every part in one message, says what each hands back, and asks for worktrees only when two or more edit', () => {
  const sonnet = { model: 'sonnet', effort: 'high' } as const
  const opus = { model: 'opus', effort: 'xhigh' } as const
  const parts: FanPart[] = [
    { what: 'orders: add paging', gear: sonnet, edits: true },
    { what: 'billing: fix rounding', gear: sonnet, edits: true },
    { what: 'review the retry change', gear: opus, edits: false },
  ]
  const two = handoffNote({ kind: 'fan', gear: sonnet, parts })
  expect(two).toContain('3 independent parts')
  expect(two).toContain('in ONE message')
  expect(two).toContain('run_in_background false')
  expect(two).toContain('part N')
  expect(two).toContain('1. orders: add paging: model "sonnet", isolation "worktree"')
  expect(two).toContain('3. review the retry change: model "opus";')
  expect(two).toContain('hands back its findings in full')
  expect(two).toContain('the files it changed')
  expect(two).toContain('merge')
  expect(two).toContain('Until all 3 have started')
  expect(two).toContain('not a copy of the reports')
  expect(two).toContain('Wait for every result')
  expect(two).not.toContain('effort "') // gearbox sets each part's effort, not the brief
  // One editing part works in the working tree: no worktree at all.
  const one = handoffNote({ kind: 'fan', gear: sonnet, parts: [parts[0]!, parts[2]!] })
  expect(one).toContain('2 independent parts')
  expect(one).not.toContain('worktree')
  // A part a lane takes goes to it by SendMessage, in that same message.
  const lane = handoffNote({ kind: 'fan', gear: sonnet, parts: [{ ...parts[2]!, gear: sonnet, resume: 'lane-s' }, parts[0]!] })
  expect(lane).toContain('1. review the retry change: send it with SendMessage to "lane-s"')
  expect(handoffLabel({ kind: 'fan', gear: sonnet, parts: [parts[0]!, parts[2]!, { what: 'run e2e', gear: { model: 'haiku', effort: 'low' }, edits: false }] })).toBe('fan × 3 → sonnet·high, opus·xhigh, haiku·low')
  expect(handoffLabel({ kind: 'fan', gear: sonnet, parts: [{ ...parts[0]!, resume: 'lane-s' }, parts[2]!] })).toBe('fan × 2 → sonnet·high (same agent), opus·xhigh')
})

test('a part’s brief carries the person’s words too, marked as context: the part is the agent’s alone', () => {
  const added = ownBrief(['add paging to orders and fix the rounding in billing'], true)
  expect(added).toContain('> add paging to orders and fix the rounding in billing')
  expect(added).toContain("this agent's part alone")
  expect(ownBrief(['x'])).not.toContain("this agent's part alone")
})
