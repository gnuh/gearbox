import { expect, test } from 'claude-code/testing'
import { type FanPart, type Part, type Reading, ARTIFACT_MAX, BRIEFING_TOOLS, CHOOSE, CODE_EFFORTS, KEPT, keptReason, subagentAsk, htmlText, readingWhy, referencedFiles, staysPut, CODE_MODEL, CODE_MODELS, DIFF_REVIEW, MAIN_FLOOR, chosenEffort, effortLine, mechanical, standingOf, NOD, RESUME_MS, RESUME_TOKENS, SURVEY, NESTING, NESTED_READ, NESTED_WRITER, notesIn, typedLanguage, ownBrief, pinnedModel, pins, resumable, doesHandoffWork, escalated, fanReply, handoffLabel, handoffNote, isLongCommand, isReadOnlyCommand, isSkillFork, readParts, reviewGear, reviews, workEffort, gearFor, label, mainModel, needsConsent, nextFloor, plan, readReading, route, routeNote, stepDown, trimRequest, verifyAsk, filesReach, goAhead, namedFiles, workFloor } from './policy'

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

test('steering below Opus: a review goes to an Opus agent at any depth', () => {
  const r = reading({ mode: 'review', depth: 1 })
  const want = gearFor(r)
  expect(want).toEqual({ model: 'opus', effort: 'medium' })
  expect(plan(r, want, 'sonnet', true, 'sonnet')).toEqual({ main: { model: 'sonnet', effort: 'high' }, handoff: { kind: 'deep', gear: want } })
  expect(plan(reading({ mode: 'review', reach: 'point', depth: 0 }), { model: 'opus', effort: 'low' }, 'sonnet', true, 'sonnet').handoff).toEqual({ kind: 'deep', gear: { model: 'opus', effort: 'low' } })
  // An Opus session reviews itself; a Haiku session shifts up to Opus.
  expect(plan(r, want, 'opus', true, 'opus')).toEqual({ main: want })
  expect(plan(r, want, 'haiku', true)).toEqual({ main: want })
})

test('a review is handed up when the survey is unsure too, on its best guess; any other guess hands nothing up', () => {
  const r = reading({ mode: 'review', depth: 1, sure: false })
  const want = gearFor(r)
  expect(want).toEqual(gearFor({ ...r, sure: true })) // the same best guess for the effort
  expect(plan(r, want, 'sonnet', true, 'sonnet')).toEqual({ main: { model: 'sonnet', effort: 'high' }, handoff: { kind: 'deep', gear: want } })
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

test('handing up is always on (the escalate setting is gone): subtle questions, fixes, a hard check’s judging and Fable work all leave a session below them', () => {
  const opusHigh = { model: 'opus', effort: 'high' } as const
  const question = reading({ reach: 'system', depth: 2, mode: 'answer' })
  const fix = reading({ reach: 'system', depth: 1 })
  const check = reading({ reach: 'system', mode: 'drive', depth: 2 })
  // What escalate code kept here (a subtle question) and what escalate off kept here (everything) both go up.
  expect(plan(question, opusHigh, 'sonnet', true, 'sonnet')).toEqual({ main: { model: 'sonnet', effort: 'high' }, handoff: { kind: 'deep', gear: opusHigh } })
  expect(plan(fix, opusHigh, 'sonnet', true, 'sonnet').handoff?.kind).toBe('deep')
  expect(plan(check, opusHigh, 'sonnet', true, 'sonnet').handoff?.judge).toEqual(opusHigh)
  expect(plan(reading({ reach: 'frontier', depth: 2 }), { model: 'fable', effort: 'high' }, 'sonnet', true, 'sonnet').handoff?.kind).toBe('deep')
  const phases = [{ what: 'plan it', mode: 'answer', depth: 2 }, { what: 'build it', mode: 'code', depth: 2 }] as const
  expect(route([...phases], 'sonnet', 'xhigh', false, 'sonnet', false, 'opus').map(s => s.by)).toEqual(['agent', 'agent'])
})

test('a fixed coding model: code’s model is exactly it, whatever its reach or care; its effort, other work and the person’s ask are as before', () => {
  expect(CODE_MODELS).toEqual(['auto', 'sonnet', 'opus', 'fable'])
  expect(CODE_MODEL).toBe('sonnet') // what a new install fixes it to; auto is the person's word
  expect(pinnedModel('auto')).toBeUndefined()
  expect(pinnedModel(undefined)).toBeUndefined()
  expect(pinnedModel('opus')).toBe('opus')
  for (const code of ['sonnet', 'opus', 'fable'] as const) {
    for (const r of [reading({ reach: 'point', depth: 0 }), reading({ reach: 'system', depth: 2, care: 'costly' }), reading({ reach: 'frontier', depth: 3 })]) {
      const g = gearFor(r, 'high', code)
      expect(g.model).toBe(code)
      expect(g.effort).toBe(gearFor(r, 'high').effort) // the coding effort's rules, unchanged
    }
    // Answers, reviews, chores, browser checks and long commands keep the rules.
    for (const mode of ['answer', 'review', 'commit', 'drive', 'wait'] as const) {
      const r = reading({ mode, reach: 'system', depth: 2 })
      expect(gearFor(r, 'high', code)).toEqual(gearFor(r, 'high'))
    }
    // A model the person names for this request wins.
    expect(gearFor(reading({ ask: { model: 'haiku' } }), 'high', code).model).toBe('haiku')
  }
  expect(pins(reading(), 'opus')).toBe(true)
  expect(pins(reading(), undefined)).toBe(false)
  expect(pins(reading({ mode: 'answer' }), 'opus')).toBe(false)
  expect(pins(reading({ ask: { model: 'sonnet' } }), 'opus')).toBe(false)
})

test('a fixed coding model on a steered session: code stays here on that very model, else goes to an agent on it, up or down, past a mechanical edit', () => {
  const at = (model: 'sonnet' | 'opus' | 'fable', effort = 'xhigh' as const) => ({ model, effort })
  const small = reading({ reach: 'point', depth: 0 })
  const feature = reading({ reach: 'point', depth: 1 })
  const wide = reading({ reach: 'system', depth: 2 })
  // The session is on it: here, even for work the rules would hand up to Opus.
  expect(plan(wide, at('sonnet'), 'sonnet', true, 'sonnet', 'sonnet', false, true)).toEqual({ main: at('sonnet') })
  expect(plan(small, at('opus'), 'opus', true, 'opus', 'sonnet', false, true)).toEqual({ main: at('opus') })
  // Another model: an agent on it, briefed here at high, whichever way it goes.
  for (const [session, code] of [['opus', 'sonnet'], ['sonnet', 'opus'], ['fable', 'sonnet']] as const) {
    for (const r of [feature, wide]) expect(plan(r, at(code), session, true, session, 'sonnet', false, true)).toEqual({ main: { model: session, effort: 'high' }, handoff: { kind: 'deep', gear: at(code) } })
    // A mechanical edit at one spot stays here, at the code's effort: a hand-off costs more than the edit.
    expect(plan(small, at(code), session, true, session, 'sonnet', false, true)).toEqual({ main: { model: session, effort: 'xhigh' } })
    // Not when a mistake there would be costly.
    expect(plan({ ...small, care: 'costly' }, at(code), session, true, session, 'sonnet', false, true).handoff).toEqual({ kind: 'deep', gear: at(code) })
  }
  // Fable: always in a subagent, unless the session itself runs on Fable; a mechanical edit stays here all the same.
  expect(plan(feature, at('fable'), 'opus', true, 'opus', 'sonnet', false, true)).toEqual({ main: { model: 'opus', effort: 'high' }, handoff: { kind: 'deep', gear: at('fable') } })
  expect(plan(small, at('fable'), 'opus', true, 'opus', 'sonnet', false, true)).toEqual({ main: at('opus') })
  expect(plan(small, at('fable'), 'fable', true, 'fable', 'sonnet', false, true)).toEqual({ main: at('fable') })
  // A guess hands nothing off, as ever: the session's model at the guess's effort.
  expect(plan({ ...wide, sure: false }, at('sonnet'), 'opus', true, 'opus', 'sonnet', false, true)).toEqual({ main: at('opus') })
  // A side task still goes to its own agent, on the coding model.
  expect(plan({ ...wide, aside: true }, at('sonnet'), 'opus', true, 'opus', 'sonnet', false, true).handoff).toEqual({ kind: 'aside', gear: at('sonnet') })
})

test('a fixed coding model in shift mode: the main model moves up to it, hands down to it past it, and never becomes Fable', () => {
  const at = (model: 'sonnet' | 'opus' | 'fable') => ({ model, effort: 'xhigh' as const })
  const r = reading({ reach: 'point', depth: 0 })
  expect(plan(r, at('opus'), undefined, false, undefined, 'sonnet', false, true)).toEqual({ main: at('opus') })
  expect(plan(r, at('opus'), 'sonnet', true, undefined, 'sonnet', false, true)).toEqual({ main: at('opus') })
  // The floor has risen past it: an agent on it, rather than code above it.
  expect(plan(r, at('sonnet'), 'opus', true, undefined, 'sonnet', false, true)).toEqual({ main: { model: 'opus', effort: 'high' }, handoff: { kind: 'deep', gear: at('sonnet') } })
  expect(plan(r, at('fable'), 'sonnet', true, undefined, 'sonnet', false, true).handoff).toEqual({ kind: 'deep', gear: at('fable') })
  // An unsure reading hands nothing off; a pinned Fable then runs here on Opus, never Fable.
  expect(plan({ ...r, sure: false }, at('fable'), 'sonnet', true, undefined, 'sonnet', false, true)).toEqual({ main: { model: 'opus', effort: 'xhigh' } })
})

test('a fixed coding model in a route: code steps run on it, here when the main model is it, else in an agent; other steps keep the rules', () => {
  const phases = [
    { what: 'read the ticket', mode: 'lookup', depth: 0 },
    { what: 'plan it', mode: 'answer', depth: 2 },
    { what: 'rename it', mode: 'code', depth: 0 },
    { what: 'build it', mode: 'code', depth: 2 },
  ] as const
  const by = (steps: ReturnType<typeof route>) => steps.map(s => `${s.what} → ${s.by} ${label(s.gear)}`)
  // A Sonnet session that fixed Sonnet: code stays here, though the request calls for Opus; the plan still goes up.
  expect(by(route([...phases], 'sonnet', 'xhigh', false, 'sonnet', false, 'opus', 'sonnet'))).toEqual(['read the ticket → agent haiku·low', 'plan it → agent opus·high', 'rename it → main sonnet·xhigh', 'build it → main sonnet·xhigh'])
  // An Opus session that fixed Sonnet: code goes down to Sonnet agents past a mechanical edit, which stays here, as
  // does the plan.
  expect(by(route([...phases], 'opus', 'xhigh', false, 'sonnet', false, 'opus', 'sonnet'))).toEqual(['read the ticket → agent haiku·low', 'plan it → main opus·high', 'rename it → main opus·xhigh', 'build it → agent sonnet·xhigh'])
  // A costly request's mechanical step goes to the agent all the same.
  expect(by(route([...phases], 'opus', 'xhigh', true, 'sonnet', false, 'opus', 'sonnet'))[2]).toBe('rename it → agent sonnet·xhigh')
  const fable = route([...phases], 'opus', 'xhigh', false, 'sonnet', false, 'opus', 'fable')
  expect(by(fable).slice(2)).toEqual(['rename it → main opus·xhigh', 'build it → agent fable·xhigh'])
  expect(routeNote(fable)).toContain('4. build it: start a plain Agent (no subagent_type) with model "fable" and effort "xhigh"')
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
  const parts: Part[] = [{ what: 'a', mode: 'code', depth: 1, files: ['a'] }, { what: 'b', mode: 'code', depth: 1, files: ['b'] }]
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

test('where Claude Code cannot make a worktree, the fan-out note and the fan tool’s reply ask for no isolation and have each editing part make its own', () => {
  const sonnet = { model: 'sonnet', effort: 'high' } as const
  const parts: FanPart[] = [
    { what: 'orders: add paging', gear: sonnet, edits: true },
    { what: 'billing: fix rounding', gear: sonnet, edits: true },
    { what: 'review the retry change', gear: { model: 'opus', effort: 'xhigh' }, edits: false },
  ]
  const own = 'git -C <repo> worktree add <path> -b <branch>'
  for (const text of [handoffNote({ kind: 'fan', gear: sonnet, parts }, false, false), fanReply(parts, false, false)]) {
    expect(text).toContain(own)
    expect(text).toContain('Do not pass isolation "worktree"')
    expect(text).not.toContain('model "sonnet", isolation "worktree"')
    expect(text).not.toContain('and isolation "worktree"')
    expect(text).not.toContain('starts with isolation "worktree"')
    expect(text).toContain('the repository each was made in')
  }
  // Nothing to say about worktrees when one part edits, whichever way they are made.
  for (const isolate of [true, false]) expect(handoffNote({ kind: 'fan', gear: sonnet, parts: [parts[0]!, parts[2]!] }, false, isolate)).not.toContain('worktree')
  // The default is Claude Code's isolation, as before.
  expect(handoffNote({ kind: 'fan', gear: sonnet, parts })).toBe(handoffNote({ kind: 'fan', gear: sonnet, parts }, false, true))
  expect(fanReply(parts)).not.toContain(own)
})

test('a part’s brief carries the person’s words too, marked as context: the part is the agent’s alone', () => {
  const added = ownBrief(['add paging to orders and fix the rounding in billing'], true)
  expect(added).toContain('> add paging to orders and fix the rounding in billing')
  expect(added).toContain("this agent's part alone")
  expect(ownBrief(['x'])).not.toContain("this agent's part alone")
})

test('the coding effort auto: a choice for the main conversation, floored at medium for the rules', () => {
  expect(CODE_EFFORTS).toEqual(['medium', 'high', 'xhigh', 'auto'])
  expect(standingOf('auto')).toBe(MAIN_FLOOR)
  expect(MAIN_FLOOR).toBe('medium')
  expect(standingOf('xhigh')).toBe('xhigh')
  // What the main conversation names for a code agent, from the floor up to xhigh; anything else is no choice.
  expect(chosenEffort('high')).toBe('high')
  expect(chosenEffort('max')).toBe('xhigh')
  expect(chosenEffort('low')).toBe('medium')
  expect(chosenEffort('ludicrous')).toBeUndefined()
  expect(chosenEffort(undefined)).toBeUndefined()
  // xhigh is the top of what the main conversation is offered.
  expect(CHOOSE).not.toContain('max')
})

test('a follow-up names its effort on its first line, which gearbox takes off', () => {
  expect(effortLine('effort: high\nalso handle the empty page')).toEqual({ effort: 'high', message: 'also handle the empty page' })
  expect(effortLine('  Effort: XHIGH  \r\nfix it')).toEqual({ effort: 'xhigh', message: 'fix it' })
  expect(effortLine('effort: low\nrename it')).toEqual({ effort: 'medium', message: 'rename it' })
  expect(effortLine('effort: max')).toEqual({ effort: 'xhigh', message: '' })
  // Only a first line that is the effort alone counts.
  for (const text of ['go on\neffort: high', 'effort: high, and fix it', 'the effort: high part', 'effort: ludicrous\nfix it']) expect(effortLine(text)).toEqual({ message: text })
})

test('a code hand-off asks for its diff to be reviewed; with the coding effort auto, the deep and lane notes are advice whose default is to hand off, for the person’s choice', () => {
  const gear = { model: 'sonnet', effort: 'xhigh' } as const
  const deep = handoffNote({ kind: 'deep', gear, code: true })
  expect(deep).toContain(DIFF_REVIEW)
  expect(deep).toContain('effort "xhigh"')
  expect(deep).not.toContain('Hand it off.')
  const advice = handoffNote({ kind: 'deep', gear, code: true }, true, true, 'code · area · depth 2')
  // Without the orchestrator it claims none: only that the person routes such work through gearbox.
  expect(advice).toStartWith('The person uses gearbox to route work like this to an agent: sonnet at xhigh (code · area · depth 2). Hand it off. Keep it here only if it turns out to be a few tool calls, and then say so in one line starting "Keeping it here:". This preference overrides the default of doing work yourself when in doubt.\n')
  expect(advice).not.toContain('orchestrator')
  expect(advice).not.toContain('Decide after reading')
  expect(advice).toContain('naming its model and effort on the call (gearbox runs what you name: effort medium to xhigh, a review on Opus at least)')
  expect(advice).toContain('Send follow-ups to it by SendMessage, with "effort: <level>" as its first line.')
  expect(advice).not.toContain('effort "xhigh"')
  expect(advice).toContain('Review its diff (git diff on the files it reports)')
  // The brief is one sentence now, not the long list it was.
  expect(advice).toContain('a brief that stands on its own: the goal, the limits, what is decided here, the files to read, any listed skills that apply (have the agent load them with the Skill tool), and what to hand back.')
  expect(advice).not.toContain('what was tried and ruled out')
  // With the orchestrator on, the note says the person turned it on for this.
  const orchestrated = handoffNote({ kind: 'deep', gear, code: true }, true, true, 'code · area · depth 2', true)
  expect(orchestrated).toStartWith("The person turned on gearbox's orchestrator so that work like this goes to an agent: sonnet at xhigh (code · area · depth 2). Hand it off.")
  expect(orchestrated.slice(orchestrated.indexOf('\n'))).toBe(advice.slice(advice.indexOf('\n')))
  // Work that writes no code is advice too, with no diff to read.
  const answer = handoffNote({ kind: 'deep', gear }, true, true, 'answer · system · depth 2')
  expect(answer).toStartWith('The person uses gearbox to route work like this to an agent: sonnet at xhigh (answer · system · depth 2).')
  expect(answer).not.toContain('Review its diff')
  expect(handoffNote({ kind: 'deep', gear })).not.toContain(DIFF_REVIEW)
  const back = handoffNote({ kind: 'deep', gear, resume: 'a-1' }, true, true, 'x')
  expect(back).toContain('the sonnet agent a-1, which already holds this work, at xhigh (x). Hand it off.')
  expect(back).toContain('by SendMessage to "a-1" (load SendMessage with ToolSearch first if it is not loaded), with "effort: <level>" as its first line')
  // A lane's job, fresh or resumed: advice, and the lane is the one of the model the main conversation names.
  for (const resume of [undefined, 'lane-s']) {
    const lane = handoffNote({ kind: 'lane', gear, code: true, resume }, true, true, 'code · area · depth 2', true)
    expect(lane).toStartWith(`The person turned on gearbox's orchestrator so that work like this goes to an agent: the sonnet lane ${resume ? `${resume}, which already holds this work, ` : ''}at xhigh (code · area · depth 2). Hand it off.`)
    expect(lane).toContain('it becomes the lane of the model you name')
    expect(lane).toContain('mcp__gearbox__fan')
    expect(lane).not.toContain('gearbox sets the effort of each job')
    expect(lane).not.toContain('refused')
    expect(lane).toContain('Review its diff')
    expect(handoffNote({ kind: 'lane', gear, resume })).toContain('gearbox sets the effort of each job')
  }
  // A side task that writes code keeps its note, the effort the main conversation's.
  const aside = handoffNote({ kind: 'aside', gear, code: true }, true)
  expect(aside).toContain('the effort you choose')
  expect(aside).toContain(DIFF_REVIEW)
  // Browser checks, long commands and git chores stay hand-offs, and so does the orchestrator's lane that only relays a
  // long command or a git chore: under auto it says only the command itself is held to it, since strict holds nothing.
  for (const kind of ['drive', 'wait', 'chore'] as const) expect(handoffNote({ kind, gear: { model: 'haiku', effort: 'low' } }, true)).toStartWith('gearbox handoff')
  for (const [relay, what] of [['wait', 'long command'], ['chore', 'git chore']] as const)
    for (const resume of [undefined, 'lane-h']) {
      const lane = handoffNote({ kind: 'lane', gear: { model: 'haiku', effort: 'low' }, relay, resume }, true, true, 'x', true)
      expect(lane).toStartWith('gearbox handoff, lane')
      expect(lane).toContain(`The ${what} itself is refused here: it is the lane's.`)
      expect(lane).not.toContain('edits, commands and more reads are refused')
      // With a fixed coding effort it reads as any lane's.
      expect(handoffNote({ kind: 'lane', gear: { model: 'haiku', effort: 'low' }, relay, resume })).toBe(handoffNote({ kind: 'lane', gear: { model: 'haiku', effort: 'low' }, resume }))
    }
})

test('the advice is noticeably shorter than the 0.23.1 notes it replaces', () => {
  const gear = { model: 'opus', effort: 'high' } as const
  // The lengths of the 0.23.1 deep and fresh-lane advice for this hand-off, code and all.
  for (const [h, was] of [[{ kind: 'deep', gear, code: true }, 1433], [{ kind: 'lane', gear, code: true }, 1563]] as const) {
    const now = handoffNote(h, true, true, 'code · system · depth 2', true)
    expect(now.length).toBeLessThan(was * 0.7)
  }
})

test('a brief names any listed skills that apply: new and follow-up hand-offs to a lane, deep work, a side task, a fan-out, advice and a route step; a command, a git chore and a browser check carry no such clause', () => {
  const gear = { model: 'sonnet', effort: 'high' } as const
  const part = (what: string): FanPart => ({ what, gear, edits: false })
  const parts = [part('read the api'), part('read the web')]
  const skills = 'any listed skills that apply (have the agent load them with the Skill tool)'
  const briefs = [
    handoffNote({ kind: 'lane', gear }),
    handoffNote({ kind: 'lane', gear, resume: 'a1' }),
    handoffNote({ kind: 'deep', gear }),
    handoffNote({ kind: 'deep', gear, resume: 'a1' }),
    handoffNote({ kind: 'aside', gear }),
    handoffNote({ kind: 'fan', gear, parts }),
    fanReply(parts),
    handoffNote({ kind: 'lane', gear }, true, true, 'code · area · depth 2', true),
    handoffNote({ kind: 'lane', gear, resume: 'a1' }, true, true, 'code · area · depth 2', true),
    handoffNote({ kind: 'fan', gear, parts }, true, true, 'two parts', true),
  ]
  for (const note of briefs) expect(note).toContain(skills)
  for (const kind of ['wait', 'chore', 'drive'] as const) expect(handoffNote({ kind, gear })).not.toContain('Skill tool')
})

test('the reason the main conversation gives for keeping advised work: its "Keeping it here:" line, emphasis and all, 200 characters at most', () => {
  expect(keptReason('Keeping it here: a one-line rename in two files.')).toBe('a one-line rename in two files.')
  expect(keptReason('Read the files first.\n**Keeping it here:** it is three reads and an edit.\nThen…')).toBe('it is three reads and an edit.')
  expect(keptReason('> keeping it here: the fix is one line')).toBe('the fix is one line')
  expect(keptReason(`Keeping it here: ${'x'.repeat(300)}`)).toHaveLength(200)
  // Only a line that starts with it counts, and an empty one says nothing.
  for (const text of ['I am not keeping it here: an agent takes it.', 'Keeping it here:', '', 'Handing it to an Opus agent.']) expect(keptReason(text)).toBeUndefined()
  expect(KEPT).toBe('Keeping it here:')
})

test('a session started as another session’s sub-agent says so in its first prompt; a mention of someone else’s sub-agent does not count', () => {
  for (const text of [
    'Act as the test sub-agent for this task. The repo is at /w/app.',
    'Act as the implementation sub-agent for GAUNTLET-12: build the importer.',
    'act as a subagent: review the diff of src/quote.ts',
    'Act as an independent review sub-agent.',
  ])
    expect(subagentAsk(text)).toBeDefined()
  expect(subagentAsk('Act as the test sub-agent for this task…')).toBe('Act as the test sub-agent')
  for (const text of [
    'Fix the importer and add tests.',
    'Act as the reviewer of the sub-agent’s work.',
    "Act as the reviewer of the sub-agent's work.",
    'Act as the tech lead. Then start a sub-agent for the tests.',
    'Act as the person in charge of planning every big release of the sub-agent platform',
    'Write docs for the sub-agents feature.',
    `${'Context. '.repeat(40)}Act as the test sub-agent.`,
  ])
    expect(subagentAsk(text)).toBeUndefined()
})

test('with the coding effort auto, a route’s code agents take the main model’s effort, and a fan-out is advice: each part’s gear is a suggestion, and nothing is refused until they start', () => {
  const steps = route([{ what: 'plan it', mode: 'answer', depth: 2 }, { what: 'build it', mode: 'code', depth: 2 }], 'opus', 'medium', false, 'sonnet', false, 'opus', 'sonnet')
  const note = routeNote(steps, true)
  expect(note).toContain('2. build it: start a plain Agent (no subagent_type) with model "sonnet" and the effort you choose')
  expect(note).toContain('its diff included')
  expect(note).toContain(CHOOSE)
  expect(routeNote(steps)).toContain('2. build it: start a plain Agent (no subagent_type) with model "sonnet" and effort "high"')
  expect(routeNote(steps)).not.toContain(CHOOSE)
  const parts: FanPart[] = [
    { what: 'orders: add paging', gear: { model: 'sonnet', effort: 'high' }, edits: true },
    { what: 'review the retry change', gear: { model: 'opus', effort: 'medium' }, edits: false, review: true },
  ]
  const reply = fanReply(parts, true)
  expect(reply).toContain('part 1: orders: add paging: gearbox suggests model "sonnet" at high; edits files')
  expect(reply).toContain('part 2: review the retry change: gearbox suggests model "opus" at medium (a review: Opus at least); only reads')
  expect(reply).toContain('the model you choose for it')
  expect(reply).toContain('Name the model and effort on the Agent call')
  expect(reply).toContain('the diff of each part that edits included')
  expect(reply).not.toContain('refused')
  expect(fanReply(parts)).toContain('part 1: orders: add paging: model "sonnet", gearbox runs it at high')
  expect(fanReply(parts)).toContain('Until all 2 have started, edits, commands and more reads are refused here.')
  // The split is advice whose default is to hand the parts off, as for a single hand-off.
  const fan = handoffNote({ kind: 'fan', gear: parts[0]!.gear, parts }, true, true, 'code · area · depth 2', true)
  expect(fan).toStartWith("The person turned on gearbox's orchestrator so that work like this goes to agents: this request splits into 2 independent parts, one agent each, running at the same time (code · area · depth 2). Hand them off. If the parts turn out to need each other's results, give the work to one agent instead. Keep it here only if it turns out to be a few tool calls, and then say so in one line starting \"Keeping it here:\".")
  expect(fan).not.toContain('split it, give it to one agent, or do it here')
  expect(fan).toContain('1. Start every part in ONE message')
  expect(fan).toContain('2. review the retry change: model "opus", at medium (a review: Opus at least)')
  expect(fan).toContain('naming its model and effort on the call')
  expect(fan).toContain('the diff of each part that edits included')
  expect(fan).not.toContain('refused')
  // A part a lane takes goes by SendMessage, its effort on the first line.
  expect(handoffNote({ kind: 'fan', gear: parts[0]!.gear, parts: [{ ...parts[0]!, resume: 'lane-s' }, parts[1]!] }, true, true, 'x', true)).toContain('A part a lane takes goes to it by SendMessage, with "effort: <level>" as its first line.')
  expect(handoffNote({ kind: 'fan', gear: parts[0]!.gear, parts })).toContain("gearbox sets each agent's effort. Until all 2 have started")
})

test('with the coding effort auto, an answer that needs no deep look, and any guess, a review’s included, gets no hand-off; with a fixed one, as before', () => {
  const opus = { model: 'opus', effort: 'medium' } as const
  for (const r of [reading({ mode: 'answer', depth: 1, reach: 'system' }), reading({ mode: 'answer', depth: 0, care: 'costly' }), reading({ mode: 'review', sure: false }), reading({ mode: 'code', sure: false, reach: 'system', depth: 2 })]) {
    expect(staysPut(r)).toBe(true)
    expect(plan(r, opus, 'sonnet', true, 'sonnet', 'sonnet', false, false, true).handoff).toBeUndefined()
  }
  // As before with a fixed coding effort: a costly answer and an unsure review on Sonnet go to Opus.
  expect(plan(reading({ mode: 'answer', depth: 1, care: 'costly' }), opus, 'sonnet', true, 'sonnet').handoff?.kind).toBe('deep')
  expect(plan(reading({ mode: 'review', sure: false }), opus, 'sonnet', true, 'sonnet').handoff?.kind).toBe('deep')
  // Deeper answers, code and reviews are still advised to a stronger model.
  for (const r of [reading({ mode: 'answer', depth: 2, reach: 'system' }), reading({ mode: 'review' }), reading({ mode: 'code', reach: 'system' })]) {
    expect(staysPut(r)).toBe(false)
    expect(plan(r, opus, 'sonnet', true, 'sonnet', 'sonnet', false, false, true).handoff?.kind).toBe('deep')
  }
  expect(readingWhy(reading({ mode: 'code', reach: 'area', depth: 2 }))).toBe('code · area · depth 2')
  expect(readingWhy(reading({ mode: 'answer', reach: 'system', depth: 1, care: 'costly' }))).toBe('answer · system · depth 1 · costly')
})

test('the files a go-ahead’s proposal points to: an artifact first, then .md, .html and .mmd paths; HTML read as its text', () => {
  const reply = 'The spec is in [the artifact](/Users/me/claude-artifacts/gearbox-0.23/spec.html), the flow in `docs/flow.mmd:12` and the plan in ./PLAN.md. See https://example.com/x.html and Node.js, README.md#setup.'
  expect(referencedFiles(reply)).toEqual(['/Users/me/claude-artifacts/gearbox-0.23/spec.html', 'docs/flow.mmd', './PLAN.md', 'README.md'])
  expect(referencedFiles('nothing to read, a claude-artifacts/ folder alone')).toEqual([])
  const page = '<html><head><title>Spec</title><style>h1{color:red}</style><script>track()</script></head><body><h1>Main decides</h1><p>Delegation &amp; effort are the <b>main</b> model&#39;s.</p><!-- draft --></body></html>'
  const text = htmlText(page)
  expect(text).toContain('Main decides')
  expect(text).toContain("Delegation & effort are the main model's.")
  for (const gone of ['<', 'track()', 'color:red', 'draft']) expect(text).not.toContain(gone)
  expect(ARTIFACT_MAX).toBe(6000)
})

test('a mechanical edit is one spot, depth 0, nothing costly at stake', () => {
  expect(mechanical(reading({ reach: 'point', depth: 0 }))).toBe(true)
  expect(mechanical(reading({ reach: 'point', depth: 1 }))).toBe(false)
  expect(mechanical(reading({ reach: 'area', depth: 0 }))).toBe(false)
  expect(mechanical(reading({ reach: 'point', depth: 0, care: 'costly' }))).toBe(false)
  expect(mechanical(reading({ reach: 'point', depth: 0, mode: 'answer' }))).toBe(false)
})

test('the language the person types in is read from their last messages by common words and letters, and is none where it is unclear', () => {
  // The prompts that were seen live, and others.
  expect(typedLanguage(['vamos fazer'])).toBe('Portuguese')
  expect(typedLanguage(['dá uma olhada nesse PR'])).toBe('Portuguese')
  expect(typedLanguage(['por que o cache de cotação é por serviço?'])).toBe('Portuguese')
  expect(typedLanguage(['depois que terminar, traga a sugestão'])).toBe('Portuguese')
  expect(typedLanguage(['quiero que revises el servicio de precios y me digas qué falta'])).toBe('Spanish')
  expect(typedLanguage(['mañana lo vemos, ¿vale?'])).toBe('Spanish')
  expect(typedLanguage(['why do the quotes drift after a refund across services?'])).toBe('English')
  expect(typedLanguage(['add a test for the quote mapper'])).toBe('English')
  // Words two languages share do not tell them apart: Portuguese and Spanish "vamos", "para", "que".
  expect(typedLanguage(['para que'])).toBeUndefined()
  // A short or empty message says nothing.
  for (const none of [[], [''], ['ok'], ['👍'], ['bun test'], ['x'], ['   ']]) expect(typedLanguage(none)).toBeUndefined()
  // Code, paths and links are not read as the person's words.
  expect(typedLanguage(['```\nconst the = and(is, are, was, were)\n```', '`the and is are was` /src/the/and/is/are.ts https://the.and/is/are'])).toBeUndefined()
  // A notification that came as a message is not the person's.
  expect(typedLanguage(['vamos revisar o cache de cotação', '<task-notification>Agent "deploy" finished: the build is done and the tests are green with the report for you</task-notification>'])).toBe('Portuguese')
  // The last three count, the latest triple: a switch of language is followed.
  const pt = 'vamos revisar o cache de cotação'
  const en = 'please review the quote cache and tell me what is missing'
  expect(typedLanguage([en, pt, pt, pt])).toBe('Portuguese')
  expect(typedLanguage([pt, pt, en])).toBe('English')
  expect(typedLanguage([pt, pt, 'ok'])).toBe('Portuguese') // an acknowledgement does not turn it
  // Only the first 400 characters of a message are read: what is pasted after them does not outvote the ask.
  expect(typedLanguage([`${`${pt}. `.repeat(13)}\n${'the quote is not the same as it was in the cache and we have to fix that. '.repeat(30)}`])).toBe('Portuguese')
})

test('what gearbox adds to an agent names the language of its notes on one line, and says nothing where it is unknown', () => {
  expect(notesIn('Portuguese')).toBe(' Write the brief notes you give between steps in Portuguese.')
  expect(notesIn()).toBe('')
  expect(notesIn(undefined)).toBe('')
  expect(NESTING).not.toContain('Write the brief notes')
  expect(NESTING).not.toContain('language')
  expect(`${NESTING}${notesIn('English')}`.split('\n').at(-1)).toEndWith('between steps in English.')
})

test('the note an agent of the main conversation gets says what it may start: readers, work that is not code, one writer at a time, a split by the fan tool; and what its review needs', () => {
  for (const said of ['Explore', 'model "haiku"', 'a lookup', 'long command', 'not code', 'one such agent at a time', 'mcp__gearbox__fan', 'part N', 'orchestrator-agents', 'worktree', 'git diff', 'every file', 'cannot start agents of their own']) expect(NESTING).toContain(said)
  expect(NESTING).not.toContain('may only read')
})

test('the brief of an agent that reads another agent’s brief, and the line a writer gets, say what each is for', () => {
  expect(NESTED_READ).toContain('Generated output')
  expect(NESTED_READ).toContain('not code')
  expect(NESTED_WRITER).toStartWith('\n\n---\nAdded by gearbox:')
  expect(NESTED_WRITER).toContain('list every file you changed')
})

test('the fan tool’s answer to an agent of an agent holds nothing back, has no lane, and says its parts cannot start agents', () => {
  const sonnet = { model: 'sonnet', effort: 'high' } as const
  const parts = [{ what: 'orders: add paging', gear: sonnet, edits: true }, { what: 'billing: fix rounding', gear: sonnet, edits: true }, { what: 'review it', gear: { model: 'opus', effort: 'medium' }, edits: false, review: true }] as const
  const reply = fanReply([...parts], false, true, true)
  expect(reply).toContain('3 independent parts')
  expect(reply).toContain('isolation "worktree"')
  expect(reply).toContain('cannot start agents of their own')
  expect(reply).not.toContain('refused here')
  expect(reply).toContain('Wait for every result')
  // The main conversation's answer is as it was.
  expect(fanReply([...parts])).toContain('refused here')
  expect(fanReply([...parts])).not.toContain('cannot start agents of their own')
})
