import { expect, test } from 'claude-code/testing'
import { type Reading, handoffNote } from './policy'

// The routing rules below are written for a medium coding effort; the default is xhigh.
const MEDIUM = { options: { code_effort: 'medium' } }
const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const ONE = { ...ZERO, input_tokens: 10, output_tokens: 2 }

type Rig = { steps: string[]; surveys: any[]; readers: string[]; dialogs: string[]; notes: (readonly string[])[]; kv: Map<string, unknown> }

// The engine beneath the mod, faked: each survey answers with the next reading, each step records `model·effort`.
const rig = (on: any, readings: Partial<Reading>[], o: { session?: string; choose?: (labels: string[]) => string; earlier?: string[]; context?: number } = {}): Rig => {
  const r: Rig = { steps: [], surveys: [], readers: [], dialogs: [], notes: [], kv: new Map() }
  const queue = [...readings]
  for (const quiet of ['ui.status', 'ui.log']) on(quiet, () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('store.get', (_: unknown, e: any) => ({ value: r.kv.get(e.key) }))
  on('store.set', (_: unknown, e: any) => (r.kv.set(e.key, e.value), { value: undefined }))
  on('session.model', () => ({ value: o.session ?? 'claude-haiku-5-5' }))
  on('session.messages', () => ({ value: (o.earlier ?? []).map(text => ({ role: 'user', text, toolUses: [] })) }))
  on('session.usage', () => ({ value: { startedAt: 1, context: { tokens: o.context ?? 120_000, window: 1_000_000 }, rateLimits: [] } }))
  on('model.complete', (_: unknown, e: any) => {
    r.surveys.push(JSON.parse(e.prompt))
    r.readers.push(e.model)
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
  expect(r.steps).toEqual(['claude-opus-5-5·xhigh', 'claude-opus-5-5·xhigh', 'claude-opus-5-5·medium', 'claude-opus-5-5·medium']) // a small edit is code too
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

test('the main model only rises; effort follows each reading; an unusable survey keeps the last gear, never below the coding effort', MEDIUM, async ($: any, on) => {
  const r = rig(on, [{ reach: 'system', depth: 2 }, { reach: 'point', depth: 0 }])
  await say($, 'find why sessions expire early')
  await say($, 'rename that helper')
  await say($, '???') // the survey has nothing more to say
  expect(r.steps).toEqual(['opus·high', 'opus·medium', 'opus·medium'])
})

test('a first prompt the survey cannot read starts at your coding effort', async ($: any, on) => {
  const r = rig(on, [])
  await say($, 'hmm')
  expect(r.steps).toEqual(['sonnet·xhigh'])
})

test('a nod keeps the gear without a survey', MEDIUM, async ($: any, on) => {
  const r = rig(on, [{ reach: 'system', depth: 2 }])
  await say($, 'find why sessions expire early')
  await say($, 'go ahead')
  expect(r.surveys).toHaveLength(1)
  expect(r.steps).toEqual(['opus·high', 'opus·high'])
})

test('a nod after a question goes ahead at the coding effort', { options: { code_effort: 'xhigh' } }, async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 0, mode: 'answer' }], { session: 'claude-opus-5-5' })
  await sayOn($, 'claude-opus-5-5', 'how would you fix the rounding?')
  await sayOn($, 'claude-opus-5-5', 'do it')
  expect(r.steps).toEqual(['claude-opus-5-5·low', 'claude-opus-5-5·xhigh'])
})

test('a turn read as a question rises to the coding effort once it edits files or a test fails', { options: { code_effort: 'xhigh' } }, async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 0, mode: 'answer' }, { reach: 'area', depth: 0, mode: 'answer' }], { session: 'claude-opus-5-5' })
  on('tool.call', (_: unknown, e: any) => (e.tool === 'Bash' ? { result: 'FAIL checkout.spec.ts', isError: true } : { result: '' }))
  await sayOn($, 'claude-opus-5-5', 'why is the total off by a cent?')
  await $.tool.call({ tool: 'Read', file_path: 'cart.ts' })
  await stepOnce($, { model: 'claude-opus-5-5' }) // reading stays cheap
  await $.tool.call({ tool: 'Edit', file_path: 'cart.ts', old_string: 'a', new_string: 'b' })
  await stepOnce($, { model: 'claude-opus-5-5' })
  await sayOn($, 'claude-opus-5-5', 'does the suite pass?')
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await stepOnce($, { model: 'claude-opus-5-5' })
  expect(r.steps).toEqual(['claude-opus-5-5·low', 'claude-opus-5-5·low', 'claude-opus-5-5·xhigh', 'claude-opus-5-5·low', 'claude-opus-5-5·xhigh'])
})

test('a subagent outside a hand-off gets an effort by its job, not the session’s', { options: { code_effort: 'xhigh' } }, async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 1 }, { mode: 'drive' }, { reach: 'area', depth: 0 }, { mode: 'answer', reach: 'area', depth: 1 }], { session: 'claude-opus-5-5' })
  const agents: string[] = []
  on('tool.call', (_: unknown, e: any) => (agents.push(`${e.subagent_type ?? 'plain'} ${e.model}·${e.effort ?? '-'}`), { result: '' }))
  await sayOn($, 'claude-opus-5-5', 'fix the checkout totals')
  await $.tool.call({ tool: 'Agent', description: 'e2e', prompt: 'open the cart in Chrome and report the totals', model: 'sonnet' })
  await $.tool.call({ tool: 'Agent', description: 'fix', prompt: 'change the rounding in cart.ts', model: 'sonnet', effort: 'low' })
  await $.tool.call({ tool: 'Agent', description: 'find', prompt: 'where is rounding done?' })
  await $.tool.call({ tool: 'Agent', description: 'look', prompt: 'p', subagent_type: 'Explore' }) // typed: its own
  expect(agents).toEqual(['plain sonnet·low', 'plain sonnet·xhigh', 'plain undefined·medium', 'Explore undefined·-'])
  expect(r.surveys.map(s => s.request)).toEqual(['fix the checkout totals', 'open the cart in Chrome and report the totals', 'change the rounding in cart.ts', 'where is rounding done?'])
  expect(r.readers).toEqual(['sonnet', 'haiku', 'haiku', 'haiku']) // Sonnet reads your prompt, Haiku a subagent's brief
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
  expect(r.steps).toEqual(['opus·high', 'opus·medium', 'opus·low', 'opus·medium']) // a commit is code: the coding effort
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

test('a max coding effort is for the big jobs: subtle code at max, the rest of the code at xhigh, without asking', { options: { code_effort: 'max' } }, async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 2 }, { reach: 'point', depth: 0 }, { reach: 'area', depth: 1, mode: 'answer' }], { session: 'claude-opus-5-5' })
  await sayOn($, 'claude-opus-5-5', 'fix the refund rounding across currencies')
  await sayOn($, 'claude-opus-5-5', 'rename that prop')
  await sayOn($, 'claude-opus-5-5', 'ok')
  await sayOn($, 'claude-opus-5-5', 'why does it re-render?')
  expect(r.dialogs).toHaveLength(0)
  expect(r.steps).toEqual(['claude-opus-5-5·max', 'claude-opus-5-5·xhigh', 'claude-opus-5-5·xhigh', 'claude-opus-5-5·medium'])
  expect((await $.command.run({ command: 'gearbox', args: 'effort max' })).text).toContain('coding effort max')
})

test('/gearbox effort, navigator and steer change the settings, over the plugin options', { options: { code_effort: 'high' } }, async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 1 }, { reach: 'area', depth: 1 }], { session: 'claude-opus-5-5' })
  await sayOn($, 'claude-opus-5-5', 'add pagination')
  expect((await $.command.run({ command: 'gearbox', args: 'effort medium' })).text).toContain('coding effort medium')
  expect((await $.command.run({ command: 'gearbox', args: 'effort ludicrous' })).text).toBe('gearbox: effort takes medium, high, xhigh or max')
  expect((await $.command.run({ command: 'gearbox', args: 'navigator haiku' })).text).toContain('navigator haiku')
  await sayOn($, 'claude-opus-5-5', 'add sorting')
  expect(r.steps).toEqual(['claude-opus-5-5·high', 'claude-opus-5-5·medium'])
  expect(r.kv.get('settings')).toEqual({ code_effort: 'medium', navigator: 'haiku' })
  expect((await $.command.run({ command: 'gearbox', args: 'steer off' })).text).toContain('steer off')
  await sayOn($, 'claude-opus-5-5', 'add filters')
  expect(r.surveys).toHaveLength(2) // steer off: no survey for the third prompt
})

const SETTINGS_PANE = { plugin: 'gearbox', component: 'Pane', requestId: 'gearbox-settings', props: { title: 'gearbox settings', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 12 }, view: {} } } as const

test('/gearbox settings opens a panel of buttons; a press saves the value, on every surface', async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 1 }], { session: 'claude-opus-5-5' })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  expect((await $.command.run({ command: 'gearbox', args: 'settings' })).text).toContain('settings open')
  for (const [surface, effort] of [['terminal', 'high'], ['desktop', 'medium']] as const) {
    const ui = await $.ui.mount({ ...SETTINGS_PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Coding effort/ })).toBeDefined()
    expect(await ui.find({ key: 'effort-max' })).toBeDefined()
    await ui.press({ key: `effort-${effort}` })
    await ui.unmount()
  }
  await (await $.ui.mount({ ...SETTINGS_PANE, surface: 'terminal' })).press({ key: 'navigator-haiku' })
  expect(r.kv.get('settings')).toEqual({ code_effort: 'medium', navigator: 'haiku' })
  await sayOn($, 'claude-opus-5-5', 'add sorting')
  expect(r.steps).toEqual(['claude-opus-5-5·medium'])
  expect((await $.command.run({ command: 'gearbox', args: '' })).text).toContain('coding effort medium · navigator haiku')
})

test('/gearbox settings says how to set values where the panel has no room', async ($: any, on) => {
  rig(on, [])
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'narrow' } }))
  expect((await $.command.run({ command: 'gearbox', args: 'settings' })).text).toContain('/gearbox effort|navigator|steer')
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

test('with strict off, running the command itself instead of the subagent raises the effort', { options: { strict: false } }, async ($: any, on) => {
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

test('strict hand-offs: the long command and the browser stay with subagents; other work goes on', async ($: any, on) => {
  const r = rig(on, [{ mode: 'wait' }, { mode: 'drive' }], { session: 'claude-opus-5-5' })
  const reached: string[] = []
  on('tool.call', (_: unknown, e: any) => (reached.push(`${e.tool} ${e.command ?? e.url ?? ''}`.trim()), { result: '' }))
  await sayOn($, 'claude-opus-5-5', 'run the e2e suite')
  const refused = await $.tool.call({ tool: 'Bash', command: 'npx playwright test' })
  await $.tool.call({ tool: 'Bash', command: 'cat package.json' })
  expect(JSON.stringify(refused)).toContain('this step is a hand-off')
  expect(JSON.stringify(refused)).toContain('model \\"haiku\\"')
  await sayOn($, 'claude-opus-5-5', 'check the cart page in the browser')
  const browser = await $.tool.call({ tool: 'mcp__claude-in-chrome__navigate', url: 'http://localhost:3000/cart' })
  expect(JSON.stringify(browser)).toContain('this step is a hand-off')
  expect(reached).toEqual(['Bash cat package.json'])
  expect(r.steps.every(s => s.endsWith('·low') || s.endsWith('·medium'))).toBe(true)
})

test('on a short conversation a git chore runs here, at low', async ($: any, on) => {
  const short = rig(on, [{ mode: 'commit', reach: 'point', depth: 0 }], { session: 'claude-opus-5-5', context: 30_000 })
  await sayOn($, 'claude-opus-5-5', 'push the three commits to the epic branch')
  expect(short.notes[0]).toEqual([])
  expect(short.steps).toEqual(['claude-opus-5-5·low'])
})

test('on a long conversation a push goes to Haiku and a pull request text to Sonnet; the main conversation may read but not push', async ($: any, on) => {
  const r = rig(on, [{ mode: 'commit', reach: 'point', depth: 0 }, { mode: 'commit', reach: 'point', depth: 1 }], { session: 'claude-opus-5-5', context: 330_000 })
  const reached: string[] = []
  on('tool.call', (_: unknown, e: any) => (reached.push(`${e.tool} ${e.command ?? ''}`.trim()), { result: '' }))
  await sayOn($, 'claude-opus-5-5', 'push the three commits to the epic branch')
  expect(r.notes[0]![0]).toContain('gearbox handoff, git chore')
  expect(r.notes[0]![0]).toContain('model "haiku" and effort "low"')
  await $.tool.call({ tool: 'Bash', command: 'git log --oneline -3' })
  const refused = await $.tool.call({ tool: 'Bash', command: 'git push origin GAUNTLET-1114' })
  expect(JSON.stringify(refused)).toContain('this step is a hand-off')
  await sayOn($, 'claude-opus-5-5', 'add a GAUNTLET-1169 section to the description of PR 333')
  expect(r.notes[1]![0]).toContain('model "sonnet" and effort "medium"')
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'gh pr edit 333 --body-file notes.md' }))).toContain('this step is a hand-off')
  expect(reached).toEqual(['Bash git log --oneline -3'])
  expect(r.steps).toEqual(['claude-opus-5-5·low', 'claude-opus-5-5·low'])
})

test('a plain subagent in a hand-off runs on the step gear, whatever the call named; typed agents are left alone', async ($: any, on) => {
  const phases = [{ what: 'read the ticket', mode: 'lookup', depth: 0 }, { what: 'build it', mode: 'code', depth: 1 }, { what: 'run e2e', mode: 'wait', depth: 0 }]
  rig(on, [{ reach: 'area', depth: 1, phases } as any], { session: 'claude-opus-5-5' })
  const agents: string[] = []
  on('tool.call', (_: unknown, e: any) => (agents.push(`${e.subagent_type ?? 'plain'} ${e.model}·${e.effort ?? '-'}`), { result: '' }))
  await sayOn($, 'claude-opus-5-5', 'read GAUNTLET-1, build it, run the e2e suite')
  await $.tool.call({ tool: 'Agent', description: 'read', prompt: 'p', model: 'opus' }) // first subagent step: the lookup
  await $.tool.call({ tool: 'Agent', description: 'look around', prompt: 'p', subagent_type: 'Explore' })
  await $.tool.call({ tool: 'mcp__gearbox__phase', step: 3 })
  await $.tool.call({ tool: 'Agent', description: 'e2e', prompt: 'p', model: 'sonnet', effort: 'high' })
  await $.tool.call({ tool: 'Agent', description: 'extra', prompt: 'p', model: 'sonnet' }) // no hand-off left, its job unread: as called
  expect(agents).toEqual(['plain haiku·low', 'Explore undefined·-', 'plain haiku·low', 'plain sonnet·-'])
})

test('ultrathink in your own words leaves that turn’s effort to Claude Code', async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 1 }, { reach: 'area', depth: 1 }], { session: 'claude-opus-5-5' })
  await sayOn($, 'claude-opus-5-5', 'ultrathink: how should the cache be invalidated?')
  await sayOn($, 'claude-opus-5-5', 'now add pagination')
  expect(r.steps).toEqual(['claude-opus-5-5·medium', 'claude-opus-5-5·xhigh']) // medium: what the engine sent
})

test('a slash command does not inherit the last prompt’s gear', async ($: any, on) => {
  const r = rig(on, [{ reach: 'system', depth: 2 }], { session: 'claude-opus-5-5' })
  await sayOn($, 'claude-opus-5-5', 'refactor the session layer')
  await $.prompt.submit({ text: '/graphify .', command: { name: 'graphify', args: '.' } } as any)
  await stepOnce($, { model: 'claude-opus-5-5', effort: 'low' })
  expect(r.steps).toEqual(['claude-opus-5-5·xhigh', 'claude-opus-5-5·low']) // low: what the skill or engine set
  expect(r.surveys).toHaveLength(1)
})

// A file system, home and session beneath the mod, for the debug log.
const disk = (on: any) => {
  const files = new Map<string, string>()
  on('fs.write', (_: unknown, e: any) => (files.set(e.path, e.text), { value: undefined }))
  on('fs.exists', (_: unknown, e: any) => ({ value: files.has(e.path) }))
  on('fs.read', (_: unknown, e: any) => ({ value: e.path.endsWith('plugin.json') ? '{"version":"9.9.9"}' : files.get(e.path) ?? '' }))
  on('env.get', (_: unknown, e: any) => ({ value: e.name === 'HOME' ? '/home/tester' : undefined }))
  on('session.id', () => ({ value: 's-1' }))
  on('session.version', () => ({ value: { version: '2.1.311', base: '2.1.311' } }))
  on('turn.complete', (_: unknown, e: any) => ({ text: e.answer }))
  return files
}
const LOG = '/home/tester/.claude/gearbox/logs/s-1.jsonl'
const events = (files: Map<string, string>) => (files.get(LOG) ?? '').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
const done = ($: any) => $.turn.complete({ turnId: 'x', answer: '', durationMs: 1200, isAborted: false })

test('the debug log is off by default: nothing is written', async ($: any, on) => {
  rig(on, [{ reach: 'area', depth: 1 }], { session: 'claude-opus-5-5' })
  const files = disk(on)
  await sayOn($, 'claude-opus-5-5', 'add pagination')
  await done($)
  expect(files.size).toBe(0)
  expect((await $.command.run({ command: 'gearbox', args: 'log' })).text).toContain('the log is off')
})

test('with the log on, a turn records the prompt, the survey, the gear and why, and each request', async ($: any, on) => {
  rig(on, [{ reach: 'area', depth: 1 }], { session: 'claude-opus-5-5' })
  const files = disk(on)
  await $.command.run({ command: 'gearbox', args: 'log on' })
  await sayOn($, 'claude-opus-5-5', 'add pagination to the orders list')
  await done($)
  const ev = events(files)
  expect(ev.map(e => e.ev)).toEqual(['session', 'prompt', 'survey', 'gear', 'step', 'turn'])
  expect(ev[0]).toMatchObject({ gearbox: '9.9.9', claude: '2.1.311' })
  expect(ev[1]).toMatchObject({ kind: 'typed', chars: 33 })
  expect(ev[1].text).toBeUndefined() // no prompt text unless the log is full
  expect(ev[3]).toMatchObject({ gear: 'opus·xhigh', why: 'survey: code, area, depth 1' })
  expect(ev[4]).toMatchObject({ loop: 'main', sent: 'opus·xhigh', engine: 'opus·medium', answered: 'claude-opus-5-5' })
  const shown = (await $.command.run({ command: 'gearbox', args: 'log' })).text
  expect(shown).toContain(LOG)
  expect(shown).toContain('last decision: opus·xhigh (survey: code, area, depth 1)')
  expect(shown).toContain("sent opus·xhigh, Claude Code's own setting opus·medium")
})

test('a full log keeps the first 200 characters of each prompt; a nod says it reused the gear', async ($: any, on) => {
  rig(on, [{ reach: 'area', depth: 1 }], { session: 'claude-opus-5-5' })
  const files = disk(on)
  await $.command.run({ command: 'gearbox', args: 'log full' })
  await sayOn($, 'claude-opus-5-5', `fix the totals ${'x'.repeat(300)}`)
  await sayOn($, 'claude-opus-5-5', 'ok')
  await done($)
  const prompts = events(files).filter(e => e.ev === 'prompt')
  expect(prompts[0].text).toHaveLength(200)
  expect(events(files).filter(e => e.ev === 'gear').map(e => e.why)).toEqual(['survey: code, area, depth 1', 'nod: the last work gear, at least your coding effort'])
})

test('an unsure survey still sets the effort from its best guess, but hands nothing off', async ($: any, on) => {
  const r = rig(on, [{ reach: 'system', depth: 2, mode: 'drive', sure: false }], { session: 'claude-opus-5-5' })
  await sayOn($, 'claude-opus-5-5', 'look at the thing')
  expect(r.notes[0]).toEqual([])
  expect(r.steps).toEqual(['claude-opus-5-5·xhigh'])
})
