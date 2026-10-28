import { expect, test } from 'claude-code/testing'
import { type Reading, handoffNote } from './policy'

// The routing rules below are written for a medium coding effort; the default is xhigh.
const MEDIUM = { options: { code_effort: 'medium' } }
const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const ONE = { ...ZERO, input_tokens: 10, output_tokens: 2 }

type Rig = { steps: string[]; surveys: any[]; readers: string[]; dialogs: string[]; notes: (readonly string[])[]; kv: Map<string, unknown> }

type Reply = { answer?: string; toolUses?: { name: string; input: unknown }[] }

// The engine beneath the mod, faked: each survey answers with the next reading, each step records `model·effort`
// and answers with the next reply (none: an answer with no tool call).
const rig = (on: any, readings: Partial<Reading>[], o: { session?: string; choose?: (labels: string[]) => string; earlier?: string[]; context?: number; replies?: Reply[] } = {}): Rig => {
  const r: Rig = { steps: [], surveys: [], readers: [], dialogs: [], notes: [], kv: new Map() }
  const queue = [...readings]
  const replies = [...(o.replies ?? [])]
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
    const { answer = '', toolUses = [] } = replies.shift() ?? {}
    if (answer) yield { kind: 'text', index: 0, text: answer, ref: r.steps.length }
    return { turnId: e.turnId, index: e.index, answer, toolUses, stopReason: toolUses.length ? 'tool_use' : 'end_turn', usage: { ...ONE, model: e.model } }
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
  expect(r.steps).toEqual(['claude-opus-5-5·high'])
})

test('steering Sonnet: Opus-level work goes to an Opus subagent at its effort; the rest stays on Sonnet', { options: { code_effort: 'xhigh' } }, async ($: any, on) => {
  const r = rig(on, [{ reach: 'system', depth: 2, mode: 'answer' }, { reach: 'area', depth: 1 }], { session: 'claude-sonnet-5-5' })
  const agents: string[] = []
  on('tool.call', (_: unknown, e: any) => (agents.push(`${e.model}·${e.effort ?? '-'}`), { result: '' }))
  await sayOn($, 'claude-sonnet-5-5', 'why do the shipping quotes differ between the gateway and the price service?')
  expect(r.notes[0]).toEqual([handoffNote({ kind: 'deep', gear: { model: 'opus', effort: 'high' } })])
  await $.tool.call({ tool: 'Agent', description: 'analyze', prompt: 'p' })
  await sayOn($, 'claude-sonnet-5-5', 'add a test for the quote mapper')
  expect(r.notes[1]).toEqual([])
  expect(agents).toEqual(['opus·high'])
  expect(r.steps).toEqual(['claude-sonnet-5-5·high', 'claude-sonnet-5-5·xhigh'])
})

test('steering Sonnet: until the Opus agent starts, the main model may read a little but not do the work itself', { options: { code_effort: 'xhigh' } }, async ($: any, on) => {
  rig(on, [{ reach: 'system', depth: 2 }], { session: 'claude-sonnet-5-5' })
  const reached: string[] = []
  on('tool.call', (_: unknown, e: any) => (reached.push(`${e.tool}${e.model ? ` ${e.model}·${e.effort}` : ''}`), { result: '' }))
  await sayOn($, 'claude-sonnet-5-5', 'quotes differ between the gateway and the price service; find the cause and fix it')
  const edit = await $.tool.call({ tool: 'Edit', file_path: 'quote.ts', old_string: 'a', new_string: 'b' })
  expect(JSON.stringify(edit)).toContain('owed to an opus agent')
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'bun test' }))).toContain('owed to an opus agent')
  for (const f of ['quote.ts', 'price.ts', 'money.ts']) expect(JSON.stringify(await $.tool.call({ tool: 'Read', file_path: f }))).not.toContain('gearbox')
  expect(JSON.stringify(await $.tool.call({ tool: 'Read', file_path: 'routes.ts' }))).toContain('owed to an opus agent') // the brief has its reads
  await $.tool.call({ tool: 'Agent', description: 'fix', prompt: 'p' })
  await $.tool.call({ tool: 'Edit', file_path: 'quote.ts', old_string: 'a', new_string: 'b' }) // reviewing what came back
  expect(reached).toEqual(['Read', 'Read', 'Read', 'Agent opus·xhigh', 'Edit'])
})

test('with strict off, the main model may do deep work itself', { options: { code_effort: 'xhigh', strict: false } }, async ($: any, on) => {
  rig(on, [{ reach: 'system', depth: 2 }], { session: 'claude-sonnet-5-5' })
  on('tool.call', () => ({ result: '' }))
  await sayOn($, 'claude-sonnet-5-5', 'quotes differ between the gateway and the price service; find the cause and fix it')
  expect(JSON.stringify(await $.tool.call({ tool: 'Edit', file_path: 'quote.ts', old_string: 'a', new_string: 'b' }))).not.toContain('owed')
})

test('steering Sonnet: a hard browser check is navigated by the navigator and judged by an Opus subagent', async ($: any, on) => {
  const r = rig(on, [{ reach: 'system', depth: 2, mode: 'drive' }], { session: 'claude-sonnet-5-5' })
  const agents: string[] = []
  on('tool.call', (_: unknown, e: any) => (agents.push(`${e.model}·${e.effort ?? '-'}`), { result: '' }))
  await sayOn($, 'claude-sonnet-5-5', 'check the multi-carrier quote flow in the browser')
  expect(r.notes[0]![0]).toContain('3. Start a plain Agent (no subagent_type) with model "opus" and effort "high"')
  await $.tool.call({ tool: 'Agent', description: 'navigate', prompt: 'p' })
  await $.tool.call({ tool: 'Agent', description: 'judge', prompt: 'p' })
  expect(agents).toEqual(['sonnet·low', 'opus·high'])
  expect(r.steps).toEqual(['claude-sonnet-5-5·medium'])
})

test('steering Sonnet: a route hands its subtle steps to Opus subagents, asking first above the coding effort', MEDIUM, async ($: any, on) => {
  const phases = [{ what: 'read the ticket', mode: 'lookup', depth: 0 }, { what: 'build it', mode: 'code', depth: 3 }, { what: 'commit', mode: 'commit', depth: 0 }]
  const r = rig(on, [{ reach: 'system', depth: 3, phases } as any], { session: 'claude-sonnet-5-5', choose: labels => labels[1]! })
  const agents: string[] = []
  on('tool.call', (_: unknown, e: any) => (agents.push(`${e.model}·${e.effort ?? '-'}`), { result: '' }))
  await sayOn($, 'claude-sonnet-5-5', 'read GAUNTLET-7, rebuild the quote cache, commit')
  expect(r.dialogs).toHaveLength(1) // opus·xhigh is above a medium coding effort
  expect(r.notes[0]![0]).toContain('2. build it: start a plain Agent (no subagent_type) with model "opus" and effort "high"')
  await $.tool.call({ tool: 'Agent', description: 'read', prompt: 'p' })
  await $.tool.call({ tool: 'mcp__gearbox__phase', step: 2 })
  await $.tool.call({ tool: 'Agent', description: 'build', prompt: 'p' })
  expect(agents).toEqual(['haiku·low', 'opus·high'])
  expect(r.steps).toEqual(['claude-sonnet-5-5·high'])
})

const spawnCall = (tool_use_id: string, extra: object = {}) => ({ tool_use_id, prompt: 'p', description: 'd', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-sonnet-5-5', background: false, fork: false, ...extra })

test('steering Sonnet: deep work goes on in the Opus agent that holds it, on a nod or a continuation; unrelated work starts clean', { options: { code_effort: 'xhigh' } }, async ($: any, on) => {
  const r = rig(on, [{ reach: 'system', depth: 2, mode: 'answer' }, { reach: 'area', depth: 1, cont: true }, { reach: 'system', depth: 2, mode: 'answer', aside: true }], { session: 'claude-sonnet-5-5', earlier: ['why do the quotes differ?'] })
  const calls: string[] = []
  on('tool.call', (_: unknown, e: any) => (calls.push(`${e.tool} ${e.model ?? ''}`.trim()), { result: '' }))
  on('agent.spawn', (_: unknown, e: any) => ({ model: e.model ?? 'inherit', agentId: e.resume?.agentId ?? 'a-deep' }))
  const opusHigh = { model: 'opus', effort: 'high' } as const
  await sayOn($, 'claude-sonnet-5-5', 'why do the shipping quotes differ between the gateway and the price service?')
  await $.tool.call({ tool: 'Agent', tool_use_id: 't1', description: 'analyze', prompt: 'p' })
  await $.agent.spawn(spawnCall('t1', { model: 'opus' }))
  // "go ahead": no survey, and the same agent takes it, not Sonnet in the main conversation.
  await sayOn($, 'claude-sonnet-5-5', 'go ahead')
  expect(r.surveys).toHaveLength(1)
  expect(r.notes[1]).toEqual([handoffNote({ kind: 'deep', gear: opusHigh, resume: 'a-deep' })])
  await $.tool.call({ tool: 'SendMessage', to: 'a-deep', message: 'go ahead with the fix' })
  // A continuation the survey reads goes on there too.
  await sayOn($, 'claude-sonnet-5-5', 'and what about the cache?')
  expect(r.notes[2]).toEqual([handoffNote({ kind: 'deep', gear: opusHigh, resume: 'a-deep' })])
  // Unrelated work is a fresh agent.
  await sayOn($, 'claude-sonnet-5-5', 'separately: why are refunds slow?')
  expect(r.notes[3]![0]).toContain('gearbox handoff, side task')
  expect(r.steps).toEqual(['claude-sonnet-5-5·high', 'claude-sonnet-5-5·high', 'claude-sonnet-5-5·high', 'claude-sonnet-5-5·medium'])
  expect(calls).toEqual(['Agent opus', 'SendMessage'])
})

test('steering Sonnet: deep work started fresh goes on fresh; with escalate off a nod stays here', { options: { code_effort: 'xhigh' } }, async ($: any, on) => {
  const r = rig(on, [{ reach: 'system', depth: 2, mode: 'answer' }, { reach: 'system', depth: 2, mode: 'answer' }], { session: 'claude-sonnet-5-5' })
  on('tool.call', () => ({ result: '' }))
  await sayOn($, 'claude-sonnet-5-5', 'why do the quotes differ?')
  // No agent was started (the model skipped it): a nod still hands the work up, to a new agent.
  await sayOn($, 'claude-sonnet-5-5', 'ok')
  expect(r.notes[1]).toEqual([handoffNote({ kind: 'deep', gear: { model: 'opus', effort: 'high' } })])
  await $.command.run({ command: 'gearbox', args: 'escalate off' })
  await sayOn($, 'claude-sonnet-5-5', 'why do the totals differ?')
  await sayOn($, 'claude-sonnet-5-5', 'ok')
  expect(r.notes.slice(2)).toEqual([[], []])
  expect(r.steps).toEqual(['claude-sonnet-5-5·high', 'claude-sonnet-5-5·high', 'claude-sonnet-5-5·high', 'claude-sonnet-5-5·xhigh'])
})

test('steering Sonnet: the Opus brief carries the person’s words, and a typed agent that works still runs on Opus; a search agent does not', { options: { code_effort: 'xhigh' } }, async ($: any, on) => {
  const r = rig(on, [{ reach: 'system', depth: 1 }], { session: 'claude-sonnet-5-5', earlier: ['the quotes differ by a cent'] })
  const calls: { type: string; model: string; prompt: string }[] = []
  on('tool.call', (_: unknown, e: any) => (calls.push({ type: e.subagent_type ?? 'plain', model: `${e.model ?? '-'}·${e.effort ?? '-'}`, prompt: e.prompt }), { result: '' }))
  await sayOn($, 'claude-sonnet-5-5', 'fix the rounding in the quote mapper')
  await $.tool.call({ tool: 'Agent', description: 'look', prompt: 'find the mapper', subagent_type: 'Explore' })
  await $.tool.call({ tool: 'Agent', description: 'fix', prompt: 'Fix the rounding in src/quote.ts.', subagent_type: 'coder' })
  expect(calls.map(c => `${c.type} ${c.model}`)).toEqual(['Explore -·-', 'coder opus·xhigh'])
  expect(calls[1]!.prompt).toStartWith('Fix the rounding in src/quote.ts.')
  expect(calls[1]!.prompt).toContain('> the quotes differ by a cent')
  expect(calls[1]!.prompt).toContain('> fix the rounding in the quote mapper')
  expect(r.notes[0]![0]).toContain('start a plain Agent (no subagent_type)')
})

test('/gearbox escalate code keeps questions on the session and still hands code up', { options: { code_effort: 'xhigh' } }, async ($: any, on) => {
  const r = rig(on, [{ reach: 'system', depth: 2, mode: 'answer' }, { reach: 'system', depth: 1 }], { session: 'claude-sonnet-5-5' })
  expect((await $.command.run({ command: 'gearbox', args: 'escalate code' })).text).toContain('escalate code')
  expect((await $.command.run({ command: 'gearbox', args: 'escalate sometimes' })).text).toBe('escalate takes on, code or off')
  await sayOn($, 'claude-sonnet-5-5', 'why do the quotes differ?')
  await sayOn($, 'claude-sonnet-5-5', 'fix the rounding in the quote mapper')
  expect(r.notes[0]).toEqual([])
  expect(r.notes[1]).toEqual([handoffNote({ kind: 'deep', gear: { model: 'opus', effort: 'xhigh' } })])
  expect(r.steps).toEqual(['claude-sonnet-5-5·high', 'claude-sonnet-5-5·high'])
})

test('steering Sonnet: a review goes to an Opus agent even when the survey is unsure, with escalate on or code; escalate off keeps it here', { options: { code_effort: 'xhigh' } }, async ($: any, on) => {
  const review = { reach: 'area', depth: 1, mode: 'review', sure: false } as const
  const r = rig(on, [review, review, review, { reach: 'system', depth: 2, mode: 'code', sure: false }], { session: 'claude-sonnet-5-5' })
  const opus = handoffNote({ kind: 'deep', gear: { model: 'opus', effort: 'medium' } })
  await sayOn($, 'claude-sonnet-5-5', 'dá uma olhada nesse PR')
  await $.command.run({ command: 'gearbox', args: 'escalate code' })
  await sayOn($, 'claude-sonnet-5-5', 'dá uma olhada nesse PR')
  await $.command.run({ command: 'gearbox', args: 'escalate off' })
  await sayOn($, 'claude-sonnet-5-5', 'dá uma olhada nesse PR')
  // Any other guess is not handed off, whatever the setting: its best guess sets the effort here.
  await $.command.run({ command: 'gearbox', args: 'escalate on' })
  await sayOn($, 'claude-sonnet-5-5', 'something is off with the quotes')
  expect(r.notes).toEqual([[opus], [opus], [], []])
  expect(r.steps).toEqual(['claude-sonnet-5-5·high', 'claude-sonnet-5-5·high', 'claude-sonnet-5-5·medium', 'claude-sonnet-5-5·xhigh'])
})

test('a Haiku session runs an unsure review on Opus, at the effort of its best guess', MEDIUM, async ($: any, on) => {
  const r = rig(on, [{ reach: 'point', depth: 0, mode: 'review', sure: false }])
  await say($, 'give the diff a look')
  expect(r.steps).toEqual(['opus·low'])
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
  expect((await $.command.run({ command: 'gearbox', args: 'off' })).text).toMatch(/^off · /)
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
  expect(r.steps).toEqual(['opus·medium', 'opus·high'])
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
  expect((await $.command.run({ command: 'gearbox', args: 'effort ludicrous' })).text).toBe('effort takes medium, high, xhigh or max')
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

const bash = (command: string) => ({ toolUses: [{ name: 'Bash', input: { command } }] })

// One request of the main conversation: what the person would see stream, and what the engine records.
const request = async ($: any, index: number) => {
  const s = $.turn.step({ turnId: 'x', index, model: 'claude-opus-5-5', effort: 'medium', messageCount: 2 })
  const seen: string[] = []
  for (let n = await s.next(); ; n = await s.next()) {
    if (n.done) return { seen, result: n.value }
    if (n.value.kind === 'text') seen.push(n.value.text)
  }
}

test('on a long conversation a run of reads goes to Haiku; a reply that does more is resent to the main model', async ($: any, on) => {
  const r = rig(on, [{ mode: 'answer', reach: 'system', depth: 1 }], {
    session: 'claude-opus-5-5',
    context: 344_000,
    replies: [
      bash('gh pr checks 333 --repo mdfcvp/swanson 2>&1 | head -30'), // Opus: the first read
      bash('gh run view 4058 --log-failed 2>&1 | grep -E "FAIL|✗" | head -40'), // Opus again: Haiku's cache is cold
      { answer: 'Getting the stack trace.', ...bash("gh run view 4058 --log-failed | sed 's/\\x1b//g' | sed -n 100,160p") }, // Haiku, kept
      { answer: 'The test is wrong; fixing it.', toolUses: [{ name: 'Edit', input: { file_path: 'a.test.ts' } }] }, // Haiku, thrown away
      { answer: 'Found it: the window crosses the clock change.' }, // Opus answers
    ],
  })
  await $.prompt.submit({ text: 'lets check why the CI is failing', asUser: true })
  for (const i of [0, 1, 2]) await request($, i)
  const fourth = await request($, 3)
  const steps = r.steps.map(s => s.split('·')[0]!.replace('claude-', '').replace('-5-5', ''))
  expect(steps).toEqual(['opus', 'opus', 'haiku', 'haiku', 'opus'])
  expect(r.steps[2]).toBe('haiku·low')
  expect(fourth.seen).toEqual(['Found it: the window crosses the clock change.'])
  expect(fourth.result.usage.model).toBe('claude-opus-5-5')
})

test('once Haiku has cached the conversation, the first read of a later turn goes to it', async ($: any, on) => {
  const r = rig(on, [{ mode: 'answer', reach: 'system', depth: 1 }, { mode: 'answer', reach: 'area', depth: 1 }], {
    session: 'claude-opus-5-5',
    context: 344_000,
    // opus, opus, haiku (kept), haiku (an answer: thrown away), opus answers; then the next turn
    replies: [bash('git log --oneline -5'), bash('git diff main --stat'), bash('cat package.json'), {}, {}, bash('ls src'), bash('cat src/a.ts')],
  })
  await $.prompt.submit({ text: 'what changed on this branch?', asUser: true })
  for (const i of [0, 1, 2, 3]) await request($, i)
  await $.prompt.submit({ text: 'and where is the entry point?', asUser: true })
  for (const i of [0, 1]) await request($, i)
  expect(r.steps.map(s => s.split('·')[0])).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'haiku', 'haiku', 'claude-opus-5-5', 'claude-opus-5-5', 'haiku'])
})

test('a short conversation never scouts', async ($: any, on) => {
  const r = rig(on, [{ mode: 'answer', reach: 'system', depth: 1 }], { session: 'claude-opus-5-5', context: 40_000, replies: [bash('cat a'), bash('cat b'), bash('cat c'), {}] })
  await $.prompt.submit({ text: 'lets check why the CI is failing', asUser: true })
  for (const i of [0, 1, 2, 3]) await request($, i)
  expect(r.steps.every(s => s.startsWith('claude-opus-5-5'))).toBe(true)
})

// The orchestrator: the main conversation plans, briefs and reviews; the work runs in one lane per model.
const ORCH = { options: { code_effort: 'xhigh', orchestrator: true } }

test('orchestrator: the main conversation runs on Sonnet at medium whatever the session is on, and a small answer stays there', ORCH, async ($: any, on) => {
  const r = rig(on, [{ reach: 'point', depth: 0, mode: 'answer' }], { session: 'claude-opus-5-5' })
  on('tool.call', () => ({ result: '' }))
  await sayOn($, 'claude-opus-5-5', 'what does formatMoney return for 1234.5?')
  expect(r.notes[0]).toEqual([])
  expect(r.steps).toEqual(['sonnet·medium'])
  expect(JSON.stringify(await $.tool.call({ tool: 'Read', file_path: 'money.ts' }))).not.toContain('gearbox')
})

test('orchestrator: its model and effort are the person’s to change', { options: { orchestrator: true, orchestrator_model: 'opus', orchestrator_effort: 'high' } }, async ($: any, on) => {
  const r = rig(on, [{ reach: 'point', depth: 0, mode: 'answer' }], { session: 'claude-sonnet-5-5' })
  await sayOn($, 'claude-sonnet-5-5', 'what does formatMoney return?')
  await $.command.run({ command: 'gearbox', args: 'orchestrator-effort low' })
  await sayOn($, 'claude-sonnet-5-5', 'and parseMoney?')
  expect(r.steps).toEqual(['opus·high', 'opus·low'])
})

test('orchestrator: deep work goes to a lane that starts at the top effort, runs each job at its own, and goes on in the same agent', ORCH, async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 2, mode: 'answer' }, { reach: 'area', depth: 3, mode: 'answer' }], { session: 'claude-opus-5-5' })
  const calls: string[] = []
  on('tool.call', (_: unknown, e: any) => (calls.push(`${e.tool}${e.model ? ` ${e.model}·${e.effort}` : ''}`), { result: '' }))
  on('agent.spawn', (_: unknown, e: any) => ({ model: e.model ?? 'inherit', agentId: 'lane-s' }))
  const high = { model: 'sonnet', effort: 'high' } as const
  await sayOn($, 'claude-opus-5-5', 'why is the quote mapper rounding twice?')
  expect(r.notes[0]).toEqual([handoffNote({ kind: 'lane', gear: high })])
  // Until the lane starts the main model may read a little, but not do the work.
  expect(JSON.stringify(await $.tool.call({ tool: 'Edit', file_path: 'quote.ts', old_string: 'a', new_string: 'b' }))).toContain('owed to an sonnet agent')
  await $.tool.call({ tool: 'Agent', tool_use_id: 't1', description: 'analyze', prompt: 'p' })
  await $.agent.spawn(spawnCall('t1', { model: 'sonnet' }))
  // The lane's first job is high, though it started at xhigh.
  await stepOnce($, { agentId: 'lane-s', model: 'claude-sonnet-5-5', effort: 'xhigh' })
  // A nod goes on in the same lane; a new job there runs at its own effort.
  await sayOn($, 'claude-opus-5-5', 'go ahead')
  expect(r.notes[1]).toEqual([handoffNote({ kind: 'lane', gear: high, resume: 'lane-s' })])
  await sayOn($, 'claude-opus-5-5', 'now trace every caller of the mapper too')
  expect(r.notes[2]).toEqual([handoffNote({ kind: 'lane', gear: { model: 'sonnet', effort: 'xhigh' }, resume: 'lane-s' })])
  await $.tool.call({ tool: 'SendMessage', to: 'lane-s', message: 'trace every caller' })
  await stepOnce($, { agentId: 'lane-s', model: 'claude-sonnet-5-5', effort: 'high' })
  expect(calls).toEqual(['Agent sonnet·xhigh', 'SendMessage'])
  expect(r.steps).toEqual(['sonnet·medium', 'claude-sonnet-5-5·high', 'sonnet·medium', 'sonnet·medium', 'claude-sonnet-5-5·xhigh'])
})

test('orchestrator: the main conversation writes no code unless the plan kept a one-spot edit here', ORCH, async ($: any, on) => {
  rig(on, [{ reach: 'point', depth: 0, mode: 'answer' }, { reach: 'point', depth: 0, mode: 'code' }], { session: 'claude-sonnet-5-5' })
  on('tool.call', () => ({ result: '' }))
  const edit = { tool: 'Edit', file_path: 'money.ts', old_string: 'a', new_string: 'b' }
  await sayOn($, 'claude-sonnet-5-5', 'what does formatMoney return?')
  expect(JSON.stringify(await $.tool.call(edit))).toContain('does not write code')
  await sayOn($, 'claude-sonnet-5-5', 'rename formatMoney to fmtMoney in money.ts')
  expect(JSON.stringify(await $.tool.call(edit))).not.toContain('gearbox')
})

test('orchestrator: with strict off the main conversation may write code', { options: { orchestrator: true, strict: false } }, async ($: any, on) => {
  rig(on, [{ reach: 'point', depth: 0, mode: 'answer' }], { session: 'claude-sonnet-5-5' })
  on('tool.call', () => ({ result: '' }))
  await sayOn($, 'claude-sonnet-5-5', 'what does formatMoney return?')
  expect(JSON.stringify(await $.tool.call({ tool: 'Edit', file_path: 'money.ts', old_string: 'a', new_string: 'b' }))).not.toContain('gearbox')
})

test('orchestrator: a plain agent started where no lane was owed still becomes that model’s lane', ORCH, async ($: any, on) => {
  const r = rig(on, [{ reach: 'point', depth: 0, mode: 'answer' }], { session: 'claude-sonnet-5-5' })
  const calls: string[] = []
  on('tool.call', (_: unknown, e: any) => (calls.push(`${e.tool}${e.model ? ` ${e.model}·${e.effort}` : ''}`), { result: '' }))
  on('agent.spawn', (_: unknown, e: any) => ({ model: e.model ?? 'inherit', agentId: 'lane-n' }))
  await sayOn($, 'claude-sonnet-5-5', 'what does formatMoney return?')
  await $.tool.call({ tool: 'Agent', tool_use_id: 't1', description: 'edit', prompt: 'p' })
  await $.agent.spawn(spawnCall('t1', { model: 'sonnet' }))
  await sayOn($, 'claude-sonnet-5-5', 'ok')
  const refused = JSON.stringify(await $.tool.call({ tool: 'Edit', file_path: 'money.ts', old_string: 'a', new_string: 'b' }))
  expect(refused).toContain('SendMessage to \\"lane-n\\"') // the lane it started is the one named
  expect(calls).toEqual(['Agent sonnet·xhigh'])
  expect(r.steps).toEqual(['sonnet·medium', 'sonnet·medium'])
})

test('orchestrator off: a Sonnet session is steered as before', { options: { code_effort: 'xhigh', orchestrator: false } }, async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 1 }], { session: 'claude-sonnet-5-5' })
  await sayOn($, 'claude-sonnet-5-5', 'add a test for the quote mapper')
  expect(r.steps).toEqual(['claude-sonnet-5-5·xhigh'])
})

test('orchestrator: a review goes to the Opus lane, even a small one', ORCH, async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 1, mode: 'review' }], { session: 'claude-sonnet-5-5' })
  await sayOn($, 'claude-sonnet-5-5', 'vamos fazer um code review')
  expect(r.notes[0]).toEqual([handoffNote({ kind: 'lane', gear: { model: 'opus', effort: 'medium' } })])
  expect(r.steps).toEqual(['sonnet·medium'])
})

test('orchestrator: an unsure review goes to the Opus lane all the same; any other unsure request stays', ORCH, async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 1, mode: 'review', sure: false }, { reach: 'system', depth: 2, mode: 'answer', sure: false }], { session: 'claude-sonnet-5-5' })
  await sayOn($, 'claude-sonnet-5-5', 'dá uma olhada nesse PR')
  await sayOn($, 'claude-sonnet-5-5', 'e o resto?')
  expect(r.notes[0]).toEqual([handoffNote({ kind: 'lane', gear: { model: 'opus', effort: 'medium' } })])
  expect(r.notes[1]).toEqual([])
  expect(r.steps).toEqual(['sonnet·medium', 'sonnet·medium'])
})

test('orchestrator: a turn it keeps still hands its lookup to Haiku, and the main conversation stays at its own gear for the whole route', ORCH, async ($: any, on) => {
  const phases = [{ what: 'fetch issue 1846', mode: 'lookup', depth: 0 }, { what: 'explain what was done', mode: 'answer', depth: 2 }]
  const r = rig(on, [{ reach: 'area', depth: 1, mode: 'answer', phases } as any], { session: 'claude-sonnet-5-5' })
  const agents: string[] = []
  on('tool.call', (_: unknown, e: any) => (e.tool === 'Agent' && agents.push(`${e.model}·${e.effort}`), { result: '' }))
  await $.prompt.submit({ text: 'explain issue 1846', asUser: true })
  const note = r.notes[0]![0]!
  expect(note).toContain('gearbox route for this request')
  expect(note).toContain('1. fetch issue 1846: start an Agent with model "haiku" and effort "low"')
  expect(note).toContain('2. explain what was done: do it yourself (effort medium)')
  await stepOnce($, { model: 'claude-sonnet-5-5', effort: 'high' })
  await $.tool.call({ tool: 'mcp__gearbox__phase', step: 1 })
  await $.tool.call({ tool: 'Agent', description: 'fetch the issue', prompt: 'gh issue view 1846' })
  await stepOnce($, { model: 'claude-sonnet-5-5', effort: 'high' })
  await $.tool.call({ tool: 'mcp__gearbox__phase', step: 2 })
  await stepOnce($, { model: 'claude-sonnet-5-5', effort: 'high' })
  expect(agents).toEqual(['haiku·low'])
  expect(r.steps).toEqual(['sonnet·medium', 'sonnet·medium', 'sonnet·medium'])
})

// A forked skill's loop as $.agent.list() names it (from a real fork's transcript meta), and what the Skill tool
// answers when it forks.
const forkRow = (id: string, skill: string) => ({ id, description: `/${skill} https://github.com/acme/shop/pull/68`, type: 'general-purpose', status: 'running', name: skill })
const forked = (agentId: string, skill: string) => ({ success: true, commandName: skill, status: 'forked', agentId, result: `Skill "${skill}" launched`, background: true })

test('a review skill’s fork runs on Opus at the effort of the turn’s own work, on every request; another skill’s fork is left alone', ORCH, async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 1, mode: 'answer' }, { reach: 'area', depth: 1, mode: 'answer' }], { session: 'claude-sonnet-5-5' })
  const files = disk(on)
  // The launch text alone, as an engine whose answer names no agent: the listing tells the fork.
  on('tool.call', () => ({ result: 'launched (forked execution, running in the background)' }))
  on('agent.list', () => ({ value: [forkRow('fork-r', 'code-review'), forkRow('fork-s', 'simplify')] }))
  await $.command.run({ command: 'gearbox', args: 'log on' })
  await sayOn($, 'claude-sonnet-5-5', 'vamos fazer um code review')
  await $.tool.call({ tool: 'Skill', tool_use_id: 't1', skill: 'code-review', args: 'https://github.com/acme/shop/pull/68' })
  for (const index of [0, 1, 2]) await stepOnce($, { agentId: 'fork-r', index, model: 'claude-sonnet-5-5', effort: 'high' })
  await sayOn($, 'claude-sonnet-5-5', 'tidy that up')
  await $.tool.call({ tool: 'Skill', tool_use_id: 't2', skill: 'simplify' })
  await stepOnce($, { agentId: 'fork-s', model: 'claude-sonnet-5-5', effort: 'high' })
  await done($)
  expect(r.steps).toEqual(['sonnet·medium', 'opus·medium', 'opus·medium', 'opus·medium', 'sonnet·medium', 'claude-sonnet-5-5·high'])
  const skills = events(files).filter(e => e.ev === 'agent' && e.type === 'skill')
  expect(skills).toHaveLength(1)
  expect(skills[0]).toMatchObject({ skill: 'code-review', agent: 'fork-r', match: 'listed', asked: 'sonnet·high', set: 'opus·medium' })
})

test('steering: a review skill’s fork named by the Skill tool runs on Opus at the turn’s effort; with gearbox off it is left alone', { options: { code_effort: 'xhigh' } }, async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 2, mode: 'answer' }], { session: 'claude-sonnet-5-5' })
  on('tool.call', (_: unknown, e: any) => ({ result: e.tool === 'Skill' ? forked(`fork-${e.tool_use_id}`, e.skill) : '' }))
  on('agent.list', () => ({ value: [] }))
  await sayOn($, 'claude-sonnet-5-5', 'how risky is the retry change?')
  await $.tool.call({ tool: 'Skill', tool_use_id: 't1', skill: 'code-review' })
  await stepOnce($, { agentId: 'fork-t1', model: 'claude-sonnet-5-5', effort: 'xhigh' })
  await $.command.run({ command: 'gearbox', args: 'off' })
  await $.tool.call({ tool: 'Skill', tool_use_id: 't2', skill: 'code-review' })
  await stepOnce($, { agentId: 'fork-t2', model: 'claude-sonnet-5-5', effort: 'xhigh' })
  await stepOnce($, { agentId: 'fork-t1', model: 'claude-sonnet-5-5', effort: 'xhigh' })
  expect(r.steps).toEqual(['claude-sonnet-5-5·high', 'opus·high', 'claude-sonnet-5-5·xhigh', 'claude-sonnet-5-5·xhigh'])
})

test('a review skill’s fork the listing does not know is taken as the first unknown agent after the call: a fallback', ORCH, async ($: any, on) => {
  const r = rig(on, [], { session: 'claude-sonnet-5-5' })
  const files = disk(on)
  on('tool.call', () => ({ result: 'launched' }))
  on('agent.list', () => ({ value: [{ id: 'helper', description: 'find the callers', type: 'general-purpose', status: 'running' }] }))
  await $.command.run({ command: 'gearbox', args: 'log on' })
  await sayOn($, 'claude-sonnet-5-5', 'hmm') // unreadable: no gear of its own for the fork, so medium
  await $.tool.call({ tool: 'Skill', tool_use_id: 't1', skill: 'security-review' })
  await stepOnce($, { agentId: 'helper', model: 'claude-sonnet-5-5', effort: 'high' }) // listed, and no fork
  await stepOnce($, { agentId: 'fork-q', model: 'claude-sonnet-5-5', effort: 'high' })
  await done($)
  expect(r.steps.slice(1)).toEqual(['claude-sonnet-5-5·high', 'opus·medium'])
  expect(events(files).find(e => e.ev === 'agent' && e.type === 'skill')).toMatchObject({ skill: 'security-review', agent: 'fork-q', match: 'fallback' })
})

test('with the log on, settings changed outside /gearbox are logged at the next prompt, with their new values', async ($: any, on) => {
  rig(on, [{ reach: 'area', depth: 1 }, { reach: 'area', depth: 1 }], { session: 'claude-opus-5-5' })
  const files = disk(on)
  await $.command.run({ command: 'gearbox', args: 'log on' })
  await sayOn($, 'claude-opus-5-5', 'add pagination')
  // The settings panel saves a value; it takes hold from the next prompt.
  const pane = await $.ui.mount({ ...SETTINGS_PANE, surface: 'terminal' })
  await pane.press({ key: 'effort-medium' })
  await pane.press({ key: 'orchestrator-on' })
  await sayOn($, 'claude-opus-5-5', 'add sorting')
  await done($)
  expect(events(files).filter(e => e.ev === 'settings').map(e => e.changed)).toEqual([{ code_effort: 'medium', orchestrator: true }])
})

// Fan-out: a request of independent parts goes out to one agent per part, all at once. Here a review, and code in
// two services.
const FAN = { options: { code_effort: 'high', orchestrator: true } }
const PARTS = [
  { what: 'review the retry change', mode: 'review', depth: 1, files: ['services/gateway'] },
  { what: 'orders: add paging', mode: 'code', depth: 1, files: ['services/orders'] },
  { what: 'billing: fix rounding', mode: 'code', depth: 3, files: ['services/billing'] },
]
const OPUS_MEDIUM = { model: 'opus', effort: 'medium' } as const
const FAN_NOTE = handoffNote({
  kind: 'fan',
  gear: OPUS_MEDIUM,
  parts: [
    { what: 'review the retry change', gear: OPUS_MEDIUM, edits: false, lane: true },
    { what: 'orders: add paging', gear: { model: 'sonnet', effort: 'high' }, edits: true },
    { what: 'billing: fix rounding', gear: { model: 'sonnet', effort: 'xhigh' }, edits: true },
  ],
})
const ASKED = 'review the retry change, add paging to orders and fix the rounding in billing'
const gearOf = (c: any) => `${c.model}·${c.effort} ${c.isolation ?? '-'} ${c.run_in_background ?? '-'}`

test('orchestrator: a request of independent parts goes out to one agent per part, each on its part’s gear; the main conversation waits for all of them to start', FAN, async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 2, mode: 'code', parts: PARTS } as any], { session: 'claude-sonnet-5-5' })
  const calls: any[] = []
  on('tool.call', (_: unknown, e: any) => (calls.push(e), { result: '' }))
  on('agent.spawn', (_: unknown, e: any) => ({ model: e.model ?? 'inherit', agentId: `agent-${e.tool_use_id}` }))
  await sayOn($, 'claude-sonnet-5-5', ASKED)
  expect(r.notes[0]).toEqual([FAN_NOTE])
  // Until every part's agent has started, no edits or commands here; the refusal says how many are still owed.
  const edit = { tool: 'Edit', file_path: 'services/orders/list.ts', old_string: 'a', new_string: 'b' }
  expect(JSON.stringify(await $.tool.call(edit))).toContain('3 of them')
  for (const [n, what] of [[1, 'review'], [2, 'orders'], [3, 'billing']] as const) {
    // Whatever model the call names, the part's gear wins.
    await $.tool.call({ tool: 'Agent', tool_use_id: `t${n}`, description: what, prompt: `do the ${what} part`, model: 'haiku' })
    await $.agent.spawn(spawnCall(`t${n}`, { model: calls.at(-1).model }))
    if (n === 2) expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'bun test' }))).toContain('1 of them')
  }
  // Each starts at the top effort; the two editing parts each get a worktree; none runs in the background.
  const agents = calls.filter(c => c.tool === 'Agent')
  expect(agents.map(gearOf)).toEqual(['opus·xhigh - false', 'sonnet·xhigh worktree false', 'sonnet·xhigh worktree false'])
  expect(agents[1].prompt).toStartWith('do the orders part')
  expect(agents[1].prompt).toContain(`> ${ASKED}`)
  expect(agents[1].prompt).toContain("this agent's part alone")
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'bun test' }))).not.toContain('gearbox')
  // Each agent's requests run at its own part's effort.
  for (const [n, model] of [[1, 'claude-opus-5-5'], [2, 'claude-sonnet-5-5'], [3, 'claude-sonnet-5-5']] as const) await stepOnce($, { agentId: `agent-t${n}`, model, effort: 'xhigh' })
  expect(r.steps).toEqual(['sonnet·medium', 'claude-opus-5-5·medium', 'claude-sonnet-5-5·high', 'claude-sonnet-5-5·xhigh'])
  // Only the first part's agent became a lane: the editing agents worked in worktrees, for this turn only.
  const refused = JSON.stringify(await $.tool.call(edit))
  expect(refused).toContain('does not write code')
  expect(refused).not.toContain('SendMessage')
  // A nod goes back to that lane, not to a new fan-out.
  await sayOn($, 'claude-sonnet-5-5', 'go ahead')
  expect(r.surveys).toHaveLength(1)
  expect(r.notes[1]).toEqual([handoffNote({ kind: 'lane', gear: OPUS_MEDIUM, resume: 'agent-t1' })])
})

test('orchestrator: an agent that names its part by number gets that part, in whatever order the calls and spawns come; a call past the parts gets an effort by its job', FAN, async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 2, mode: 'code', parts: PARTS } as any, { reach: 'area', depth: 1, mode: 'answer' }], { session: 'claude-sonnet-5-5' })
  const calls: any[] = []
  on('tool.call', (_: unknown, e: any) => (calls.push(e), { result: '' }))
  on('agent.spawn', (_: unknown, e: any) => ({ model: e.model ?? 'inherit', agentId: `agent-${e.tool_use_id}` }))
  await sayOn($, 'claude-sonnet-5-5', ASKED)
  await $.tool.call({ tool: 'Agent', tool_use_id: 't3', description: 'part 3: billing rounding', prompt: 'p' })
  await $.tool.call({ tool: 'Agent', tool_use_id: 't1', description: 'Part 1: review', prompt: 'p' })
  await $.tool.call({ tool: 'Agent', tool_use_id: 't2', description: 'orders paging', prompt: 'p' })
  for (const id of ['t2', 't1', 't3']) await $.agent.spawn(spawnCall(id, { model: calls.find(c => c.tool_use_id === id).model }))
  expect(calls.map(gearOf)).toEqual(['sonnet·xhigh worktree false', 'opus·xhigh - false', 'sonnet·xhigh worktree false'])
  for (const n of [3, 2, 1]) await stepOnce($, { agentId: `agent-t${n}`, model: 'claude-sonnet-5-5', effort: 'xhigh' })
  expect(r.steps.slice(1)).toEqual(['claude-sonnet-5-5·xhigh', 'claude-sonnet-5-5·high', 'claude-sonnet-5-5·medium'])
  // Every part has started: another plain agent is read for its job, as outside a hand-off, and becomes no lane.
  await $.tool.call({ tool: 'Agent', tool_use_id: 't4', description: 'extra', prompt: 'find the callers', model: 'sonnet' })
  expect(gearOf(calls.at(-1))).toBe('sonnet·medium - -')
  expect(r.readers).toEqual(['sonnet', 'haiku'])
})

test('orchestrator: a lane that is idle takes its model’s first part by SendMessage; a busy lane is left to its work', FAN, async ($: any, on) => {
  const parts = [{ what: 'trace the orders flow', mode: 'answer', depth: 2, files: ['services/orders'] }, { what: 'trace the billing flow', mode: 'answer', depth: 2, files: ['services/billing'] }]
  const fan = { reach: 'area', depth: 2, mode: 'answer', parts }
  const r = rig(on, [{ reach: 'area', depth: 2, mode: 'answer' }, fan, fan] as any, { session: 'claude-sonnet-5-5' })
  const calls: any[] = []
  on('tool.call', (_: unknown, e: any) => (calls.push(e), { result: '' }))
  on('agent.spawn', (_: unknown, e: any) => ({ model: e.model ?? 'inherit', agentId: `agent-${e.tool_use_id}` }))
  on('turn.complete', (_: unknown, e: any) => ({ text: e.answer }))
  await sayOn($, 'claude-sonnet-5-5', 'why is the quote mapper rounding twice?')
  await $.tool.call({ tool: 'Agent', tool_use_id: 't0', description: 'analyze', prompt: 'p' })
  await $.agent.spawn(spawnCall('t0', { model: 'sonnet' }))
  // The sonnet lane is still at work: both parts are fresh agents.
  await sayOn($, 'claude-sonnet-5-5', 'trace the orders flow and, separately, the billing flow')
  expect(r.notes[1]![0]).toContain('2 independent parts')
  expect(r.notes[1]![0]).not.toContain('SendMessage')
  // Once it is done, it takes the first part; the second is a fresh agent.
  await $.turn.complete({ agentId: 'agent-t0', turnId: 'y', answer: 'found it', durationMs: 1, isAborted: false })
  await sayOn($, 'claude-sonnet-5-5', 'trace the orders flow and, separately, the billing flow')
  expect(r.notes[2]![0]).toContain('1. trace the orders flow: send it with SendMessage to "agent-t0"')
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'bun test' }))).toContain('2 of them')
  await $.tool.call({ tool: 'SendMessage', to: 'agent-t0', message: 'trace the orders flow' })
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'bun test' }))).toContain('1 of them')
  await $.tool.call({ tool: 'Agent', tool_use_id: 't9', description: 'billing', prompt: 'p' })
  expect(gearOf(calls.at(-1))).toBe('sonnet·xhigh - false')
  await stepOnce($, { agentId: 'agent-t0', model: 'claude-sonnet-5-5', effort: 'xhigh' })
  expect(r.steps.at(-1)).toBe('claude-sonnet-5-5·high')
})

test('orchestrator: with one agent at a time, a request of parts is one lane’s, as before; /gearbox orchestrator-agents sets how many', { options: { code_effort: 'high', orchestrator: true, orchestrator_agents: 1 } }, async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 2, mode: 'code', parts: PARTS } as any, { reach: 'area', depth: 2, mode: 'code', parts: PARTS } as any], { session: 'claude-sonnet-5-5' })
  on('tool.call', () => ({ result: '' }))
  await sayOn($, 'claude-sonnet-5-5', ASKED)
  expect(r.notes[0]).toEqual([handoffNote({ kind: 'lane', gear: { model: 'sonnet', effort: 'high' } })])
  expect((await $.command.run({ command: 'gearbox', args: 'orchestrator-agents 9' })).text).toBe('orchestrator-agents takes a number from 1 to 6 (1: no fan-out)')
  expect((await $.command.run({ command: 'gearbox', args: 'orchestrator-agents 3' })).text).toContain('up to 3 agents')
  await sayOn($, 'claude-sonnet-5-5', ASKED)
  expect(r.notes[1]).toEqual([FAN_NOTE])
})

test('orchestrator: a guess with parts hands nothing off; an unsure review with parts is the Opus lane’s', FAN, async ($: any, on) => {
  const reviews = [{ what: 'security', mode: 'review', depth: 1, files: ['src/pay'] }, { what: 'speed', mode: 'review', depth: 1, files: ['src/pay'] }]
  const r = rig(on, [{ reach: 'area', depth: 2, mode: 'code', parts: PARTS, sure: false }, { reach: 'area', depth: 1, mode: 'review', parts: reviews, sure: false }] as any, { session: 'claude-sonnet-5-5' })
  await sayOn($, 'claude-sonnet-5-5', 'do the usual')
  await sayOn($, 'claude-sonnet-5-5', 'dá uma olhada nesse PR')
  expect(r.notes[0]).toEqual([])
  expect(r.notes[1]).toEqual([handoffNote({ kind: 'lane', gear: OPUS_MEDIUM })])
})

test('orchestrator: the settings panel shows how many agents run at once only while the orchestrator is on', async ($: any, on) => {
  const r = rig(on, [])
  const pane = await $.ui.mount({ ...SETTINGS_PANE, surface: 'terminal' })
  expect(await pane.find({ key: 'orchestrator-agents-3' })).toBeUndefined()
  await pane.press({ key: 'orchestrator-on' })
  expect(await pane.find({ key: 'orchestrator-agents-3' })).toBeDefined()
  await pane.press({ key: 'orchestrator-agents-5' })
  expect(r.kv.get('settings')).toEqual({ orchestrator: true, orchestrator_agents: 5 })
})

test('orchestrator: with the log on, a fan-out records the parts, the cap, how many agents it kept and what it merged', { options: { code_effort: 'high', orchestrator: true, orchestrator_agents: 2 } }, async ($: any, on) => {
  rig(on, [{ reach: 'area', depth: 2, mode: 'code', parts: PARTS } as any], { session: 'claude-sonnet-5-5' })
  const files = disk(on)
  on('tool.call', () => ({ result: '' }))
  on('agent.spawn', (_: unknown, e: any) => ({ model: e.model ?? 'inherit', agentId: `agent-${e.tool_use_id}` }))
  await $.command.run({ command: 'gearbox', args: 'log on' })
  await sayOn($, 'claude-sonnet-5-5', ASKED)
  await $.tool.call({ tool: 'Agent', tool_use_id: 't1', description: 'part 1: review', prompt: 'p' })
  await $.agent.spawn(spawnCall('t1', { model: 'opus' }))
  await done($)
  const ev = events(files)
  expect(ev.find(e => e.ev === 'fan')).toMatchObject({ cap: 2, kept: 2, merged: ['billing: fix rounding + orders: add paging'] })
  expect(ev.find(e => e.ev === 'fan').parts).toHaveLength(3)
  expect(ev.find(e => e.ev === 'gear').handoff).toBe('fan × 2 → opus·medium, sonnet·xhigh')
  expect(ev.find(e => e.ev === 'agent')).toMatchObject({ set: 'opus·medium', lane: 'xhigh', part: 1 })
  expect(ev.find(e => e.ev === 'spawn')).toMatchObject({ agent: 'agent-t1', part: 1, lane: true })
})

test('orchestrator: Agent calls of one message delivered at the same time each take a part of their own, and each agent its own job', FAN, async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 2, mode: 'code', parts: PARTS } as any], { session: 'claude-sonnet-5-5' })
  const calls: any[] = []
  // The tool takes a while, as a foreground agent does, so the three calls overlap.
  on('tool.call', async (_: unknown, e: any) => (calls.push(e), await new Promise(done => setTimeout(done, 5)), { result: '' }))
  on('agent.spawn', (_: unknown, e: any) => ({ model: e.model ?? 'inherit', agentId: `agent-${e.tool_use_id}` }))
  await sayOn($, 'claude-sonnet-5-5', ASKED)
  await Promise.all(['review', 'orders', 'billing'].map((what, i) => $.tool.call({ tool: 'Agent', tool_use_id: `t${i + 1}`, description: what, prompt: `do the ${what} part` })))
  expect(calls.map(c => `${c.prompt.split('\n')[0]} ${gearOf(c)}`)).toEqual(['do the review part opus·xhigh - false', 'do the orders part sonnet·xhigh worktree false', 'do the billing part sonnet·xhigh worktree false'])
  // Their spawns come in any order and still bind by the call's id.
  await Promise.all(['t3', 't1', 't2'].map(id => $.agent.spawn(spawnCall(id, { model: calls.find(c => c.tool_use_id === id).model }))))
  for (const n of [1, 2, 3]) await stepOnce($, { agentId: `agent-t${n}`, model: 'claude-sonnet-5-5', effort: 'xhigh' })
  expect(r.steps.slice(1)).toEqual(['claude-sonnet-5-5·medium', 'claude-sonnet-5-5·high', 'claude-sonnet-5-5·xhigh'])
})

// The fan tool: once the work is known, the main conversation names its independent pieces and gearbox splits them
// as it would a survey's parts. Here the QA deploy of a real session: one long command per repo.
const DEPLOY = ['integration-malha', 'prepost-services', 'prepost', 'backend'].map(repo => ({ what: `deploy ${repo} on QA`, mode: 'wait', depth: 1, files: [repo] }))
const QA_ASK = 'sim, porem, tem mais de 1 pr, porque vc ta querendo atualizar só 1 serviço?'
const HAIKU_LOW = { model: 'haiku', effort: 'low' } as const

test('the fan tool is registered at session start, never deferred, and says when to call it', async ($: any, on) => {
  rig(on, [])
  const tools: any[] = []
  on('tool.register', (_: unknown, e: any) => (tools.push(e), { value: { tool: `mcp__gearbox__${e.name}` } }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
  const fan = tools.find(t => t.name === 'fan')
  expect(fan).toMatchObject({ isDeferred: false })
  expect(fan.description).toContain('BEFORE starting agents')
  expect(fan.description).toContain('independent pieces')
  expect(fan.description).toContain('sequential work')
  expect(fan.inputSchema.required).toEqual(['parts'])
  expect(fan.inputSchema.properties.parts.maxItems).toBe(6)
})

test('orchestrator: the fan tool splits the work the main conversation names, on the live cap, and holds the turn to it until every agent starts', { options: { code_effort: 'xhigh', orchestrator: true } }, async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 1, mode: 'answer' }], { session: 'claude-opus-5-5' })
  const files = disk(on)
  const calls: any[] = []
  on('tool.call', (_: unknown, e: any) => (calls.push(e), { result: '' }))
  on('agent.spawn', (_: unknown, e: any) => ({ model: e.model ?? 'inherit', agentId: `agent-${e.tool_use_id}` }))
  await $.command.run({ command: 'gearbox', args: 'log on' })
  // As the survey read the real prompt: a question, kept here with no hand-off.
  await sayOn($, 'claude-opus-5-5', QA_ASK)
  expect(r.notes[0]).toEqual([])
  // Three agents at most: the last two deploys share one.
  const answer = JSON.stringify(await $.tool.call({ tool: 'mcp__gearbox__fan', parts: DEPLOY }))
  expect(answer).toContain('3 independent parts')
  expect(answer).toContain('part 1: deploy integration-malha on QA: model \\"haiku\\", gearbox runs it at low; only reads')
  expect(answer).toContain('part 3: deploy prepost on QA; deploy backend on QA: model \\"haiku\\"')
  expect(answer).toContain('in ONE message')
  // Strict: until every part's agent has started, no commands here.
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'ssh qa pm2 status' }))).toContain('3 of them')
  for (const n of [1, 2, 3]) {
    await $.tool.call({ tool: 'Agent', tool_use_id: `t${n}`, description: `part ${n}: deploy`, prompt: `deploy part ${n}` })
    await $.agent.spawn(spawnCall(`t${n}`, { model: 'haiku' }))
  }
  expect(calls.filter(c => c.tool === 'Agent').map(gearOf)).toEqual(Array(3).fill('haiku·xhigh - false'))
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'ssh qa pm2 status' }))).not.toContain('gearbox')
  for (const n of [1, 2, 3]) await stepOnce($, { agentId: `agent-t${n}`, model: 'claude-haiku-5-5', effort: 'xhigh' })
  expect(r.steps.slice(1)).toEqual(Array(3).fill('claude-haiku-5-5·low'))
  await done($)
  // A nod goes back to the first part's lane, as after a survey's fan-out.
  await sayOn($, 'claude-opus-5-5', 'ok')
  expect(r.notes[1]).toEqual([handoffNote({ kind: 'lane', gear: HAIKU_LOW, resume: 'agent-t1' })])
  await done($)
  const ev = events(files)
  expect(ev.find(e => e.ev === 'fan')).toMatchObject({ via: 'tool', cap: 3, kept: 3, merged: ['deploy prepost on QA + deploy backend on QA'], handoff: 'fan × 3 → haiku·low, haiku·low, haiku·low' })
  expect(ev.filter(e => e.ev === 'spawn').map(e => `${e.part} ${e.lane ?? false}`)).toEqual(['1 true', '2 false', '3 false'])
})

test('orchestrator: the fan tool leaves the turn as it is when a split is not worth it, once the turn’s agents have started, or with the orchestrator off', ORCH, async ($: any, on) => {
  rig(on, [{ reach: 'area', depth: 2, mode: 'answer' }], { session: 'claude-sonnet-5-5' })
  on('tool.call', () => ({ result: '' }))
  on('agent.spawn', (_: unknown, e: any) => ({ model: e.model ?? 'inherit', agentId: 'lane-s' }))
  const fan = async (parts: unknown) => JSON.stringify(await $.tool.call({ tool: 'mcp__gearbox__fan', parts }))
  await sayOn($, 'claude-sonnet-5-5', 'why is the quote mapper rounding twice?')
  // Two edits of one file are one agent's: the lane hand-off stands.
  const shared = [{ what: 'orders: add paging', mode: 'code', depth: 1, files: ['services/orders/list.ts'] }, { what: 'orders: add sorting', mode: 'code', depth: 1, files: ['services/orders/list.ts'] }]
  expect(await fan(shared)).toContain('not worth splitting: the parts edit the same files')
  expect(JSON.stringify(await $.tool.call({ tool: 'Edit', file_path: 'quote.ts', old_string: 'a', new_string: 'b' }))).toContain('owed to an sonnet agent')
  expect(await $.tool.call({ tool: 'mcp__gearbox__fan', parts: [{ what: 'dance', mode: 'dance', depth: 1 }] })).toMatchObject({ isError: true })
  // Once the lane has started, a late split cannot reshuffle running work.
  await $.tool.call({ tool: 'Agent', tool_use_id: 't1', description: 'analyze', prompt: 'p' })
  await $.agent.spawn(spawnCall('t1', { model: 'sonnet' }))
  expect(await fan(DEPLOY)).toContain('already started')
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'bun test' }))).not.toContain('gearbox')
  await $.command.run({ command: 'gearbox', args: 'orchestrator off' })
  expect(await fan(DEPLOY)).toContain('orchestrator is off')
})

test('orchestrator: carrying on the work a lane holds still splits when the survey lists independent parts; with none it goes on in the lane', { options: { code_effort: 'xhigh', orchestrator: true, orchestrator_agents: 6 } }, async ($: any, on) => {
  const deploy = { reach: 'area', depth: 1, mode: 'wait', parts: DEPLOY }
  const r = rig(on, [{ reach: 'system', depth: 1, mode: 'wait' }, { ...deploy, cont: true }, deploy, { reach: 'area', depth: 1, mode: 'wait', cont: true }] as any, { session: 'claude-opus-5-5' })
  on('tool.call', () => ({ result: '' }))
  on('agent.spawn', (_: unknown, e: any) => ({ model: e.model ?? 'inherit', agentId: `agent-${e.tool_use_id}` }))
  on('turn.complete', (_: unknown, e: any) => ({ text: e.answer }))
  await sayOn($, 'claude-opus-5-5', 'vamos subir pra qa: checkout dos serviços, buildar e reiniciar')
  expect(r.notes[0]).toEqual([handoffNote({ kind: 'lane', gear: HAIKU_LOW })])
  await $.tool.call({ tool: 'Agent', tool_use_id: 't0', description: 'deploy', prompt: 'p' })
  await $.agent.spawn(spawnCall('t0', { model: 'haiku' }))
  await $.turn.complete({ agentId: 'agent-t0', turnId: 'y', answer: 'stopped', durationMs: 1, isAborted: false })
  // A continuation of four deploys, one per repo: four agents, the idle lane taking the first.
  await sayOn($, 'claude-opus-5-5', QA_ASK)
  expect(r.notes[1]![0]).toContain('4 independent parts')
  expect(r.notes[1]![0]).toContain('1. deploy integration-malha on QA: send it with SendMessage to "agent-t0"')
  // Read as the work it carries on, not a continuation, it splits all the same.
  await sayOn($, 'claude-opus-5-5', QA_ASK)
  expect(r.notes[2]![0]).toContain('4 independent parts')
  // A continuation with no parts goes on in the lane.
  await sayOn($, 'claude-opus-5-5', 'continua')
  expect(r.notes[3]).toEqual([handoffNote({ kind: 'lane', gear: HAIKU_LOW, resume: 'agent-t0' })])
})

test('orchestrator: of two plain agents of one model in one message only the first becomes the lane; both run at their job’s effort, and a nod goes back to the first', { options: { code_effort: 'high', orchestrator: true } }, async ($: any, on) => {
  const r = rig(on, [{ reach: 'area', depth: 2, mode: 'answer' }], { session: 'claude-sonnet-5-5' })
  const files = disk(on)
  const calls: any[] = []
  on('tool.call', async (_: unknown, e: any) => (calls.push(e), await new Promise(done => setTimeout(done, 5)), { result: '' }))
  on('agent.spawn', (_: unknown, e: any) => ({ model: e.model ?? 'inherit', agentId: `agent-${e.tool_use_id}` }))
  await $.command.run({ command: 'gearbox', args: 'log on' })
  await sayOn($, 'claude-sonnet-5-5', 'why is the quote mapper rounding twice?')
  await Promise.all(['t1', 't2'].map(id => $.tool.call({ tool: 'Agent', tool_use_id: id, description: 'trace', prompt: 'p', model: 'sonnet' })))
  for (const id of ['t1', 't2']) await $.agent.spawn(spawnCall(id, { model: 'sonnet' }))
  expect(calls.map(c => `${c.model}·${c.effort}`)).toEqual(['sonnet·xhigh', 'sonnet·xhigh'])
  for (const id of ['t1', 't2']) await stepOnce($, { agentId: `agent-${id}`, model: 'claude-sonnet-5-5', effort: 'xhigh' })
  expect(r.steps.slice(1)).toEqual(['claude-sonnet-5-5·high', 'claude-sonnet-5-5·high'])
  await done($)
  await sayOn($, 'claude-sonnet-5-5', 'go ahead')
  expect(r.notes[1]).toEqual([handoffNote({ kind: 'lane', gear: { model: 'sonnet', effort: 'high' }, resume: 'agent-t1' })])
  await done($)
  expect(events(files).filter(e => e.ev === 'spawn').map(e => `${e.agent} ${e.lane ?? false}`)).toEqual(['agent-t1 true', 'agent-t2 false'])
})

test('orchestrator: with no hand-off, a second plain agent of the same model is a fresh one; the lane is the first', ORCH, async ($: any, on) => {
  rig(on, [{ reach: 'point', depth: 0, mode: 'answer' }], { session: 'claude-sonnet-5-5' })
  on('tool.call', () => ({ result: '' }))
  on('agent.spawn', (_: unknown, e: any) => ({ model: e.model ?? 'inherit', agentId: `agent-${e.tool_use_id}` }))
  await sayOn($, 'claude-sonnet-5-5', 'what does formatMoney return?')
  for (const id of ['t1', 't2']) {
    await $.tool.call({ tool: 'Agent', tool_use_id: id, description: 'edit', prompt: 'p', model: 'sonnet' })
    await $.agent.spawn(spawnCall(id, { model: 'sonnet' }))
  }
  await sayOn($, 'claude-sonnet-5-5', 'ok')
  expect(JSON.stringify(await $.tool.call({ tool: 'Edit', file_path: 'money.ts', old_string: 'a', new_string: 'b' }))).toContain('SendMessage to \\"agent-t1\\"')
})
