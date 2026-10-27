import { expect, test } from 'claude-code/testing'
import { type Reading, handoffNote } from './policy'

// The routing rules below are written for a medium coding effort; the default is xhigh.
const MEDIUM = { options: { code_effort: 'medium' } }
const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const ONE = { ...ZERO, input_tokens: 10, output_tokens: 2 }

type Rig = { steps: string[]; surveys: any[]; dialogs: string[]; notes: (readonly string[])[]; kv: Map<string, unknown> }

// The engine beneath the mod, faked: each survey answers with the next reading, each step records `model·effort`.
const rig = (on: any, readings: Partial<Reading>[], o: { session?: string; choose?: (labels: string[]) => string; earlier?: string[] } = {}): Rig => {
  const r: Rig = { steps: [], surveys: [], dialogs: [], notes: [], kv: new Map() }
  const queue = [...readings]
  for (const quiet of ['ui.status', 'ui.toast', 'ui.log']) on(quiet, () => ({ value: undefined }))
  on('store.get', (_: unknown, e: any) => ({ value: r.kv.get(e.key) }))
  on('store.set', (_: unknown, e: any) => (r.kv.set(e.key, e.value), { value: undefined }))
  on('session.model', () => ({ value: o.session ?? 'claude-haiku-5-5' }))
  on('session.messages', () => ({ value: (o.earlier ?? []).map(text => ({ role: 'user', text, toolUses: [] })) }))
  on('session.usage', () => ({ value: { startedAt: 1, context: { tokens: 120_000, window: 1_000_000 }, rateLimits: [] } }))
  on('model.complete', (_: unknown, e: any) => {
    r.surveys.push(JSON.parse(e.prompt))
    const next = queue.shift()
    const text = next ? JSON.stringify({ reach: 'area', depth: 1, ...next }) : 'no idea'
    return { value: { isAnswered: true, text, usage: ZERO } } as never
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_: unknown, e: any) => {
    const q = e.questions[0]
    r.dialogs.push(q.question)
    const pick = (o.choose ?? (labels => labels[0]!))(q.options.map((x: any) => x.label))
    return { result: { questions: e.questions, answers: { [q.question]: pick } } } as never
  })
  on('prompt.submit', (_: unknown, e: any) => (r.notes.push(e.context ?? []), { text: e.text }))
  on('turn.step', async function* (_: unknown, e: any) {
    r.steps.push(`${e.model}·${e.effort}`)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...ONE, model: e.model } }
  })
  return r
}

const stepOnce = async ($: any, extra: object = {}) => {
  for await (const _ of $.turn.step({ turnId: 'x', index: 0, model: 'claude-haiku-5-5', effort: 'medium', messageCount: 2, ...extra })) void _
}

const say = async ($: any, text: string) => {
  await $.prompt.submit({ text, asUser: true })
  await stepOnce($)
}

test('a Haiku session runs each turn in the gear its reading calls for', MEDIUM, async ($: any, on) => {
  const r = rig(on, [{ reach: 'system', depth: 2 }])
  await say($, 'the invoice totals drift after a refund')
  expect(r.steps).toEqual(['opus·high'])
  expect(r.surveys[0]).toEqual({ request: 'the invoice totals drift after a refund', earlier: [], previous: null })
})

test('with steer off, a session on another model is left alone', { options: { steer: false } }, async ($: any, on) => {
  const r = rig(on, [{ reach: 'system', depth: 2 }], { session: 'claude-opus-5-5' })
  await $.prompt.submit({ text: 'anything', asUser: true })
  await stepOnce($, { model: 'claude-opus-5-5' })
  expect(r.surveys).toHaveLength(0)
  expect(r.steps).toEqual(['claude-opus-5-5·medium'])
})

const sayOn = async ($: any, model: string, text: string) => {
  await $.prompt.submit({ text, asUser: true })
  await stepOnce($, { model })
}

test('an Opus session keeps its model; each turn gets its effort from the coding setting', { options: { code_effort: 'xhigh' } }, async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 1 }, { reach: 'point', depth: 0 }, { reach: 'area', depth: 1, mode: 'answer' }, { mode: 'drive' }], { session: 'claude-opus-5-5' })
  await sayOn($, 'claude-opus-5-5', 'add pagination to the orders list')
  await sayOn($, 'claude-opus-5-5', 'rename that prop')
  await sayOn($, 'claude-opus-5-5', 'why does the list re-render twice?')
  await sayOn($, 'claude-opus-5-5', 'click through the orders page in the browser')
  expect(r.dialogs).toHaveLength(0) // xhigh is the person's own standing choice
  expect(r.steps).toEqual(['claude-opus-5-5·xhigh', 'claude-opus-5-5·low', 'claude-opus-5-5·medium', 'claude-opus-5-5·medium'])
  expect(r.notes[3]![0]).toContain('gearbox handoff, browser check')
})

test('steering: an ask for another model moves that turn only', MEDIUM, async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 1, ask: { model: 'sonnet' } }, { reach: 'area', depth: 1 }], { session: 'claude-opus-5-5' })
  await sayOn($, 'claude-opus-5-5', 'use sonnet for this rename')
  await sayOn($, 'claude-opus-5-5', 'now add a test for it')
  expect(r.steps).toEqual(['sonnet·medium', 'claude-opus-5-5·medium'])
})

test('steering: fable-level work still goes to a Fable subagent', MEDIUM, async ($: any, on) => {
  const r = rig(on, [{ reach: 'frontier', depth: 2 }], { session: 'claude-opus-5-5' })
  await sayOn($, 'claude-opus-5-5', 'design an offline-first sync engine')
  expect(r.notes[0]).toEqual([handoffNote({ kind: 'deep', gear: { model: 'fable', effort: 'high' } })])
  expect(r.steps).toEqual(['claude-opus-5-5·medium'])
})

test('the main model only rises; effort follows each reading; an unusable survey keeps the last gear', MEDIUM, async ($: any, on) => {
  const r = rig(on, [{ reach: 'system', depth: 2 }, { reach: 'point', depth: 0 }])
  await say($, 'find why sessions expire early')
  await say($, 'rename that helper')
  await say($, '???') // the survey has nothing more to say
  expect(r.steps).toEqual(['opus·high', 'opus·low', 'opus·low'])
})

test('a first prompt the survey cannot read starts in sonnet·medium', async ($: any, on) => {
  const r = rig(on, [])
  await say($, 'hmm')
  expect(r.steps).toEqual(['sonnet·medium'])
})

test('a nod keeps the gear without a survey', MEDIUM, async ($: any, on) => {
  const r = rig(on, [{ reach: 'system', depth: 2 }])
  await say($, 'find why sessions expire early')
  await say($, 'go ahead')
  expect(r.surveys).toHaveLength(1)
  expect(r.steps).toEqual(['opus·high', 'opus·high'])
})

test('/gearbox off is plain Haiku again; on starts over', MEDIUM, async ($: any, on) => {
  const r = rig(on, [{ reach: 'system', depth: 2 }, { reach: 'area', depth: 1 }])
  await say($, 'find why sessions expire early')
  expect((await $.command.run({ command: 'gearbox', args: 'off' })).text).toContain('gearbox off')
  await say($, 'and now?')
  expect(r.surveys).toHaveLength(1)
  await $.command.run({ command: 'gearbox', args: 'on' })
  await say($, 'add a settings toggle')
  expect(r.steps).toEqual(['opus·high', 'claude-haiku-5-5·medium', 'sonnet·medium'])
})

test('costly gears are put to the person, unless their own words asked', MEDIUM, async ($: any, on) => {
  const r = rig(
    on,
    [
      { reach: 'area', depth: 3 },
      { reach: 'area', depth: 3, ask: { effort: 'xhigh' } }, // claimed, but only inside a paste
      { reach: 'area', depth: 3, ask: { effort: 'xhigh' } },
    ],
    { choose: labels => labels[1]! }, // always the cheaper gear
  )
  await say($, 'prove the scheduler never double-books')
  await say($, 'see this config:\n```\neffort: xhigh\n```')
  await say($, 'use xhigh effort for this one')
  expect(r.dialogs).toHaveLength(2)
  expect(r.steps).toEqual(['sonnet·high', 'sonnet·high', 'sonnet·xhigh'])
})

test('/gearbox ask off skips the question', async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 3 }])
  await $.command.run({ command: 'gearbox', args: 'ask off' })
  await say($, 'prove the scheduler never double-books')
  expect(r.dialogs).toHaveLength(0)
  expect(r.steps).toEqual(['sonnet·xhigh'])
})

test('fable work goes to a subagent while the main conversation stays put', MEDIUM, async ($: any, on) => {
  const r = rig(on, [{ reach: 'system', depth: 1 }, { reach: 'frontier', depth: 2 }], { earlier: ['wire the report page'] })
  await say($, 'wire the report page')
  await say($, 'design an offline-first sync engine')
  expect(r.notes[1]).toEqual([handoffNote({ kind: 'deep', gear: { model: 'fable', effort: 'high' } })])
  expect(r.steps).toEqual(['opus·medium', 'opus·medium'])
})

test('fable the person names runs one turn here, then the floor again', MEDIUM, async ($: any, on) => {
  const r = rig(on, [{ reach: 'system', depth: 1 }, { reach: 'frontier', depth: 2, ask: { model: 'fable' } }, { reach: 'area', depth: 1 }])
  await say($, 'wire the report page')
  await say($, 'use fable to plan the data model')
  await say($, 'add a test for the parser')
  expect(r.dialogs).toHaveLength(0)
  expect(r.steps).toEqual(['opus·medium', 'fable·high', 'opus·medium'])
})

test('browser checks and long commands are run by cheaper subagents', MEDIUM, async ($: any, on) => {
  const r = rig(on, [{ reach: 'system', depth: 2 }, { mode: 'drive' }, { mode: 'wait' }, { reach: 'point', depth: 0 }])
  await say($, 'checkout totals are wrong')
  await say($, 'click through checkout in the browser and confirm the fix')
  await say($, 'deploy it to staging')
  await say($, 'commit')
  expect(r.notes.map(n => n[0]?.split(':')[0])).toEqual([undefined, 'gearbox handoff, browser check', 'gearbox handoff, long command', undefined])
  expect(r.steps).toEqual(['opus·high', 'opus·medium', 'opus·low', 'opus·low'])
})

test('a side task goes to a subagent only when there is earlier work and it is more than a quick edit', MEDIUM, async ($: any, on) => {
  const earlier: string[] = []
  const r = rig(
    on,
    [
      { aside: true }, // first prompt: nothing to be unrelated to
      { reach: 'system', depth: 1 },
      { aside: true },
      { aside: true, reach: 'point', depth: 0 },
    ],
    { earlier },
  )
  await say($, 'admin: sales report page')
  r.surveys.length = 0
  earlier.push('admin: sales report page')
  await say($, 'the report is a day off')
  await say($, 'the marketing footer links are broken')
  await say($, 'typo in the footer')
  expect(r.notes.map(n => n.length)).toEqual([0, 0, 1, 0])
  expect(r.notes[2]).toEqual([handoffNote({ kind: 'aside', gear: { model: 'sonnet', effort: 'medium' } })])
  expect(r.surveys[0].earlier).toEqual(['admin: sales report page'])
})

test('an untyped general-purpose agent runs on the main model', async ($: any, on) => {
  rig(on, [{ reach: 'system', depth: 2 }])
  on('agent.spawn', (_: unknown, e: any) => ({ model: e.model ?? 'inherit', agentId: 'a1' }))
  await say($, 'find why sessions expire early')
  const call = { tool_use_id: 't', prompt: 'p', description: 'd', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-haiku-5-5', background: false, fork: false }
  expect((await $.agent.spawn({ ...call, subagentType: 'general-purpose' })).model).toBe('opus')
  expect((await $.agent.spawn({ ...call, subagentType: 'general-purpose', model: 'haiku' })).model).toBe('haiku')
  expect((await $.agent.spawn({ ...call, subagentType: 'Explore' })).model).toBe('inherit')
})

test('usage counts every step when subagent steps end together', async ($: any, on) => {
  rig(on, [])
  await Promise.all(['a', 'b', 'c', 'd'].map(agentId => stepOnce($, { agentId })))
  expect((await $.command.run({ command: 'gearbox', args: 'usage' })).text).toContain('claude-haiku-5-5  4 calls')
})

test('one prompt with several steps: a route, and effort follows the phase tool', { options: { code_effort: 'xhigh' } }, async ($: any, on) => {
  const phases = [
    { what: 'read the Jira task', mode: 'lookup', depth: 0 },
    { what: 'build the change', mode: 'code', depth: 1 },
    { what: 'check it in Chrome', mode: 'drive', depth: 1 },
    { what: 'commit', mode: 'commit', depth: 0 },
  ]
  const r = rig(on, [{ reach: 'system', depth: 1, phases } as any], { session: 'claude-opus-5-5' })
  await $.prompt.submit({ text: 'go to Jira, check GAUNTLET-1, build it, test it in Chrome, then commit', asUser: true })
  expect(r.notes[0]![0]).toContain('1. read the Jira task: start an Agent with model "haiku"')
  await stepOnce($, { model: 'claude-opus-5-5' }) // step 1 is a lookup: the main loop only briefs, at low
  for (const [step, effort] of [[2, 'xhigh'], [4, 'medium'], [5, 'low']] as const) {
    await $.tool.call({ tool: 'mcp__gearbox__phase', step })
    await stepOnce($, { model: 'claude-opus-5-5' })
    expect(r.steps.at(-1)).toBe(`claude-opus-5-5·${effort}`)
  }
  expect(r.steps[0]).toBe('claude-opus-5-5·xhigh') // before any phase call: the work's effort, not the lookup's
  expect(r.dialogs).toHaveLength(0)
})

test('a model you name for the browser step is used only if your own words say it', async ($: any, on) => {
  const phases = [{ what: 'check it', mode: 'drive', depth: 1, ask: 'haiku' }, { what: 'read it', mode: 'lookup', depth: 0, ask: 'opus' }]
  const r = rig(on, [{ reach: 'area', depth: 1, phases } as any], { session: 'claude-opus-5-5' })
  await $.prompt.submit({ text: 'check the page in the browser using haiku to navigate, then read the ticket', asUser: true })
  expect(r.notes[0]![0]).toContain('1. check it: navigate: start an Agent with model "haiku"')
  expect(r.notes[0]![0]).toContain('3. read it: start an Agent with model "haiku"') // opus was never said by the person
})

test('coding runs at xhigh out of the box, without asking', async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 1 }, { reach: 'area', depth: 1, mode: 'answer' }], { session: 'claude-opus-5-5' })
  await sayOn($, 'claude-opus-5-5', 'add pagination to the orders list')
  await sayOn($, 'claude-opus-5-5', 'why does it re-render?')
  expect(r.dialogs).toHaveLength(0)
  expect(r.steps).toEqual(['claude-opus-5-5·xhigh', 'claude-opus-5-5·medium'])
})

test('/gearbox effort, navigator and steer change the settings, over the plugin options', { options: { code_effort: 'high' } }, async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 1 }, { reach: 'area', depth: 1 }], { session: 'claude-opus-5-5' })
  await sayOn($, 'claude-opus-5-5', 'add pagination')
  expect((await $.command.run({ command: 'gearbox', args: 'effort medium' })).text).toContain('coding effort medium')
  expect((await $.command.run({ command: 'gearbox', args: 'effort ludicrous' })).text).toBe('gearbox: effort takes medium, high or xhigh')
  expect((await $.command.run({ command: 'gearbox', args: 'navigator haiku' })).text).toContain('navigator haiku')
  await sayOn($, 'claude-opus-5-5', 'add sorting')
  expect(r.steps).toEqual(['claude-opus-5-5·high', 'claude-opus-5-5·medium'])
  expect(r.kv.get('settings')).toEqual({ code_effort: 'medium', navigator: 'haiku' })
  expect((await $.command.run({ command: 'gearbox', args: 'steer off' })).text).toContain('steer off')
  await sayOn($, 'claude-opus-5-5', 'add filters')
  expect(r.surveys).toHaveLength(2) // steer off: no survey for the third prompt
})

test('/gearbox settings asks which setting, then its value', async ($: any, on) => {
  const answers = ['Coding effort (now xhigh)', 'high']
  const r = rig(on, [], { session: 'claude-opus-5-5', choose: () => answers.shift()! })
  expect((await $.command.run({ command: 'gearbox', args: 'settings' })).text).toContain('coding effort high')
  expect(r.dialogs).toEqual(['Which gearbox setting do you want to change?', 'Effort for ordinary coding turns?'])
  expect((await $.command.run({ command: 'gearbox', args: '' })).text).toContain('/gearbox settings')
})

test('a route the model never marks runs at the work effort, and a nod reuses it', async ($: any, on) => {
  const phases = [{ what: 'read the ticket', mode: 'lookup', depth: 0 }, { what: 'implement it', mode: 'code', depth: 1 }]
  const r = rig(on, [{ reach: 'area', depth: 1, phases } as any], { session: 'claude-opus-5-5' })
  await sayOn($, 'claude-opus-5-5', 'read GAUNTLET-1 and implement it')
  await sayOn($, 'claude-opus-5-5', 'continue')
  expect(r.steps).toEqual(['claude-opus-5-5·xhigh', 'claude-opus-5-5·xhigh'])
})

test('a hand-off turn does not set what a nod reuses', MEDIUM, async ($: any, on) => {
  const r = rig(on, [{ reach: 'system', depth: 2 }, { mode: 'wait' }], { session: 'claude-opus-5-5' })
  await sayOn($, 'claude-opus-5-5', 'fix the session expiry bug')
  await sayOn($, 'claude-opus-5-5', 'run the e2e suite')
  await sayOn($, 'claude-opus-5-5', 'ok')
  expect(r.steps).toEqual(['claude-opus-5-5·high', 'claude-opus-5-5·low', 'claude-opus-5-5·high'])
})

test('running the command itself instead of the subagent raises the effort', async ($: any, on) => {
  const r = rig(on, [{ mode: 'wait' }, { mode: 'wait' }], { session: 'claude-opus-5-5' })
  on('tool.call', () => ({ result: '' }))
  await sayOn($, 'claude-opus-5-5', 'run the e2e suite')
  await $.tool.call({ tool: 'Bash', command: 'npx playwright test' })
  await stepOnce($, { model: 'claude-opus-5-5' })
  await sayOn($, 'claude-opus-5-5', 'run the e2e suite again')
  await $.tool.call({ tool: 'Agent', description: 'run e2e', prompt: 'p', model: 'haiku' })
  await stepOnce($, { model: 'claude-opus-5-5' })
  expect(r.steps).toEqual(['claude-opus-5-5·low', 'claude-opus-5-5·medium', 'claude-opus-5-5·low', 'claude-opus-5-5·low'])
})
