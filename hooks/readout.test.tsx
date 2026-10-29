import type { AgentStatus } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const USAGE = { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const SCROLL = { offset: 0, bodyRows: 20 }
const BAND = { plugin: 'gearbox', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: 100, scroll: SCROLL, view: {} } } as const
const PANE = { plugin: 'gearbox', component: 'Pane', requestId: 'gearbox', props: { title: 'gearbox: models now', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: SCROLL, view: {} } } as const
const SURFACES = ['terminal', 'desktop'] as const

// The engine beneath the mod, faked for a session that is not on Haiku: gearbox only watches here.
const bench = (on: any, session = 'claude-opus-5-5', panes: () => unknown[] = () => []) => {
  const kv = new Map<string, unknown>()
  let usd = 1.25
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1000, window: 1e6 }, rateLimits: [], cost: { usd } } }))
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }))
  const status: (string | undefined)[] = []
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', (_: unknown, e: any) => (status.push(e.text), { value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: panes() }))
  on('store.get', (_: unknown, e: any) => ({ value: kv.get(e.key) }))
  on('store.set', (_: unknown, e: any) => (kv.set(e.key, e.value), { value: undefined }))
  on('session.model', () => ({ value: session }))
  const prompts: string[] = []
  on('agent.spawn', (_: unknown, e: any) => (prompts.push(e.prompt), { model: e.model ?? 'claude-sonnet-5-5', agentId: e.description === 'deploy' ? 'a-deploy' : e.description === 'browser check' ? 'a-check' : `a-${e.description}` }))
  const calls: any[] = []
  on('tool.call', (_: unknown, e: any) => (calls.push(e), { result: {} }))
  on('turn.complete', (_: unknown, e: any) => ({ text: e.answer }))
  // Stands for the engine's own empty band, drawn when the mod passes.
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>engine band</Text>
  })
  on('turn.step', async function* (_: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...USAGE, model: e.answeredBy ?? e.model } }
  })
  return { status, calls, prompts, kv, setCost: (v: number) => { usd = v } }
}

const step = async ($: any, model: string, extra: object = {}) => {
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model, effort: 'high', messageCount: 3, ...extra })) void _
}

const spawn = ($: any, description: string, model: string) =>
  $.agent.spawn({ tool_use_id: description, prompt: 'p', description, subagentType: 'general-purpose', model, provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false })

const complete = ($: any, agentId?: string, answer = '') => $.turn.complete({ turnId: 't', answer, durationMs: 10, isAborted: false, ...(agentId ? { agentId } : {}) })

// The engine's agent list, as the test sets it: id → status, or status and description.
const listing = (on: any) => {
  const agents: Record<string, AgentStatus | { status: AgentStatus; description: string }> = {}
  on('agent.list', () => ({ value: Object.entries(agents).map(([id, a]) => ({ id, type: 'general-purpose', ...(typeof a === 'string' ? { status: a, description: id } : a) })) }))
  return agents
}

const REPLY = (text: string) => ({ plugin: 'gearbox', component: 'AssistantMessage', requestId: `m-${text.length}`, props: { text, isFirstOfReply: true } }) as const

test('the pane lists every loop with its model, nested under main', async ($: any, on) => {
  bench(on)
  await step($, 'claude-opus-5-5')
  await spawn($, 'browser check', 'sonnet')
  await step($, 'claude-sonnet-5-5', { agentId: 'a-check', effort: 'medium' })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a-check' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^main/ }))?.text).toContain('opus·high')
    const row = await ui.find({ type: 'Text', text: /browser check/ })
    expect(row?.text).toContain('sonnet·medium')
    expect(row?.text).toContain('Bash')
    await ui.unmount()
  }
})

const BAND_AT = (bodyColumns: number) => ({ ...BAND, props: { ...BAND.props, bodyColumns } })

test('the band: GearBox and its actions, five live columns and a row per subagent, above what the mods below draw', async ($: any, on) => {
  const { setCost } = bench(on)
  setCost(10)
  await $.prompt.submit({ text: '/review', command: { name: 'review', args: '' } } as any) // a person's prompt starts the tally
  await step($, 'claude-opus-5-5')
  await spawn($, 'deploy', 'haiku')
  await step($, 'claude-haiku-5-5', { agentId: 'a-deploy', effort: 'low' })
  await $.tool.call({ tool: 'Bash', command: './deploy.sh staging', agentId: 'a-deploy' })
  setCost(10.4)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND_AT(120), surface })
    for (const text of [/^GearBox$/, /^opus·high$/, /^1 running$/, /^haiku·low$/, /^2 requests$/, /^opus 1 · haiku 1$/, /^\$10\.40/, /this turn \$0\.40/, /^\/review$/, /^sets its own effort$/, /^● deploy$/, /^Bash: \.\/deploy\.sh staging$/, /^1 request {2}\d+s$/, /engine band/]) {
      expect(await ui.find({ type: 'Text', text })).toBeDefined()
    }
    expect(await ui.find({ key: 'band-effort-xhigh' })).toBeUndefined() // the coding effort lives in Settings now
    for (const key of ['band-pane', 'band-log', 'band-settings']) expect(await ui.find({ key })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /—|⌀|avg/ })).toBeUndefined() // no dash, and no average of one turn
    // Rules and column separators are text only the terminal draws as lines; a desktop draws a card.
    for (const text of [/^─+$/, /^│$/, /^┄+$/]) expect(!!(await ui.find({ type: 'Text', text }))).toBe(surface === 'terminal')
    await ui.unmount()
  }
  // A second turn brings the bars and the average.
  await $.prompt.submit({ text: 'and the coupon too' })
  setCost(10.9)
  const two = await $.ui.mount({ ...BAND_AT(120), surface: 'desktop' })
  expect(await two.find({ type: 'Text', text: /^ [▁▂▃▄▅▆▇█]{2}$/ })).toBeDefined()
  expect(await two.find({ type: 'Text', text: /this turn \$0\.50 · avg \$0\.45/ })).toBeDefined()
  await two.unmount()
})

test('the band groups subagents by gear, lists five at most, and flags a fallback', async ($: any, on) => {
  const { status } = bench(on)
  await step($, 'claude-opus-5-5')
  for (const n of [1, 2, 3, 4, 5, 6]) await spawn($, `c${n}`, 'sonnet')
  expect(status.at(-1)).toBe('opus·high ⇢ 6 agents: sonnet ×6')
  await step($, 'claude-sonnet-5-5', { agentId: 'a-c1', effort: 'low', answeredBy: 'claude-haiku-5-5' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND_AT(120), surface })
    for (const text of [/^6 running$/, /^sonnet·low · sonnet ×5$/, /^● c1$/, /^● c4$/, /answered by haiku/, /^\+2 more · Panel$/]) {
      expect(await ui.find({ type: 'Text', text })).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: /^● c5$/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the band keeps three columns in a narrow terminal; it cannot be switched off any more', async ($: any, on) => {
  bench(on)
  await step($, 'claude-opus-5-5')
  const narrow = await $.ui.mount({ ...BAND_AT(80), surface: 'terminal' })
  expect(await narrow.find({ type: 'Text', text: /^now$/ })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: /^cost$/ })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: /^this turn$/ })).toBeUndefined()
  expect(await narrow.find({ type: 'Text', text: /^[●◐]/ })).toBeUndefined() // no subagent runs
  await narrow.unmount()
  // The desktop app counts fewer, wider cells: the same count there still holds all five.
  const desk = await $.ui.mount({ ...BAND_AT(80), surface: 'desktop' })
  for (const text of [/^this turn$/, /^why$/]) expect(await desk.find({ type: 'Text', text })).toBeDefined()
  await desk.unmount()
  expect((await $.command.run({ command: 'gearbox', args: 'band off' })).text).toContain('band is no longer a setting')
  const still = await $.ui.mount({ ...BAND_AT(120), surface: 'desktop' })
  expect(await still.find({ type: 'Text', text: /GearBox/ })).toBeDefined()
  expect(await still.find({ type: 'Text', text: /engine band/ })).toBeDefined()
  await still.unmount()
})

test('a band: false an older version stored, or a plugin option, is ignored: the band and the list under the last reply still draw', { options: { band: false } }, async ($: any, on) => {
  const { kv } = bench(on)
  kv.set('settings', { band: false })
  mock.clock(on)
  const agents = listing(on)
  on('ui.render', { component: 'AssistantMessage' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  await step($, 'claude-opus-5-5')
  await spawn($, 'deploy', 'sonnet')
  agents['a-deploy'] = 'running'
  await complete($, undefined, 'Deploying now.')
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND_AT(120), surface })
    expect(await band.find({ type: 'Text', text: /^GearBox$/ })).toBeDefined()
    await band.unmount()
    const reply = await $.ui.mount({ ...REPLY('Deploying now.'), surface })
    expect(await reply.find({ type: 'Text', text: /1 agent still at work/ })).toBeDefined()
    await reply.unmount()
  }
})

test('a subagent whose turn ends while it waits on its own background work stays in the band until the engine says it ended', async ($: any, on) => {
  const { status } = bench(on)
  const clock = mock.clock(on)
  const agents: Record<string, AgentStatus> = {}
  on('agent.list', () => ({ value: Object.entries(agents).map(([id, s]) => ({ id, description: id, type: 'general-purpose', status: s })) }))
  await step($, 'claude-opus-5-5')
  await spawn($, 'deploy', 'sonnet')
  await spawn($, 'browser check', 'haiku')
  await step($, 'claude-sonnet-5-5', { agentId: 'a-deploy', effort: 'low' })
  agents['a-deploy'] = 'waiting'
  await complete($, 'a-deploy')
  expect(status.at(-1)).toBe('opus·high ⇢ 2 agents: sonnet·low, haiku, 1 waiting')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND_AT(120), surface })
    for (const text of [/^1 running · 1 waiting$/, /^◐ deploy$/, /^waiting on its own background work$/, /^● browser check$/]) {
      expect(await ui.find({ type: 'Text', text })).toBeDefined()
    }
    await ui.unmount()
  }
  // Still alive on the engine's list: it stays; its next turn's steps mark it working again.
  agents['a-deploy'] = 'running'
  await clock.advance(3000)
  expect(status.at(-1)).toBe('opus·high ⇢ 2 agents: sonnet·low, haiku, 1 waiting')
  await step($, 'claude-sonnet-5-5', { agentId: 'a-deploy', effort: 'low' })
  expect(status.at(-1)).toBe('opus·high ⇢ 2 agents: sonnet·low, haiku')
  agents['a-deploy'] = 'waiting'
  await complete($, 'a-deploy')
  // Ended on the engine's list: the next look drops it.
  agents['a-deploy'] = 'completed'
  await clock.advance(3000)
  expect(status.at(-1)).toBe('opus·high ⇢ 1 agent: haiku')
  const ui = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /deploy/ })).toBeUndefined()
  await ui.unmount()
  // One the engine already lists as ended is done at its turn's end.
  agents['a-check'] = 'completed'
  await complete($, 'a-check')
  expect(status.at(-1)).toBe('opus·high')
})

test('the band nests a subagent’s own agents right under it', async ($: any, on) => {
  bench(on)
  await step($, 'claude-opus-5-5')
  await spawn($, 'lane', 'sonnet')
  await spawn($, 'review', 'sonnet')
  await $.agent.spawn({ tool_use_id: 'scout', prompt: 'p', description: 'scout', subagentType: 'Explore', model: 'haiku', parentAgentId: 'a-lane', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-sonnet-5-5', background: true, fork: false })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND_AT(120), surface })
    const rows = (await ui.findAll({ type: 'Text', text: /^ *● / })).map((t: any) => t.text)
    expect(rows).toEqual(['● lane', '  ● scout', '● review'])
    await ui.unmount()
  }
})

test('an agent alive on the engine’s list gets its row when the main turn ends, however gearbox missed it', async ($: any, on) => {
  const { status } = bench(on)
  const clock = mock.clock(on)
  const agents = listing(on)
  await step($, 'claude-opus-5-5')
  // Spawned with no agent.spawn gearbox heard, and one it wrongly holds done while the engine still runs it.
  agents['a-ghost'] = { status: 'running', description: 'ghost task' }
  await spawn($, 'deploy', 'sonnet')
  agents['a-deploy'] = 'completed'
  await complete($, 'a-deploy')
  expect(status.at(-1)).toBe('opus·high')
  // While any agent is alive the engine's list is read every few seconds.
  await clock.advance(3000)
  expect(status.at(-1)).toBe('opus·high ⇢ 1 agent: general-purpose')
  agents['a-deploy'] = 'running'
  await complete($, undefined, 'Pronto.')
  expect(status.at(-1)).toBe('opus·high ⇢ 2 agents: sonnet, general-purpose')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND_AT(120), surface })
    for (const text of [/^● ghost task$/, /^● deploy$/, /^2 running$/]) expect(await ui.find({ type: 'Text', text })).toBeDefined()
    await ui.unmount()
  }
})

test('under the last reply: the agents still at work, live, then that they all finished, until the next prompt', async ($: any, on) => {
  const { status } = bench(on)
  const clock = mock.clock(on)
  const agents = listing(on)
  on('ui.render', { component: 'AssistantMessage' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  const answer = 'A verificação vai rodar pelo Docker.\n\nQuando terminar, trago o que mudou.'
  await step($, 'claude-opus-5-5')
  await spawn($, 'deploy', 'sonnet')
  agents['a-deploy'] = 'running'
  await step($, 'claude-sonnet-5-5', { agentId: 'a-deploy', effort: 'low' })
  await complete($, undefined, answer)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...REPLY('Quando terminar, trago o que mudou.'), surface })
    for (const text of [/^Quando terminar/, /1 agent still at work · not done yet/, /^● deploy$/]) expect(await ui.find({ type: 'Text', text })).toBeDefined()
    await ui.unmount()
    // Another reply is drawn as it was.
    const older = await $.ui.mount({ ...REPLY('Feito, revise quando puder.'), surface })
    expect(await older.find({ type: 'Text', text: /still at work/ })).toBeUndefined()
    await older.unmount()
    // Idle with an agent at work is not done.
    const band = await $.ui.mount({ ...BAND_AT(120), surface })
    for (const text of [/^● agents at work$/, /^main waits · not done yet$/]) expect(await band.find({ type: 'Text', text })).toBeDefined()
    await band.unmount()
  }
  const live = await $.ui.mount({ ...REPLY('Quando terminar, trago o que mudou.'), surface: 'terminal' })
  // Its turn ends while it waits on its own background work: the same reply redraws.
  agents['a-deploy'] = 'waiting'
  await complete($, 'a-deploy')
  expect(await live.find({ type: 'Text', text: /^◐ deploy$/ })).toBeDefined()
  expect(await live.find({ type: 'Text', text: /1 waiting/ })).toBeDefined()
  // It ends: the next look at the engine's list says so.
  agents['a-deploy'] = 'completed'
  await clock.advance(3000)
  expect(await live.find({ type: 'Text', text: /^✓ all agents finished/ })).toBeDefined()
  expect(await live.find({ type: 'Text', text: /deploy/ })).toBeUndefined()
  expect(status.at(-1)).toBe('opus·high')
  // The next prompt clears it.
  await $.prompt.submit({ text: 'e agora?' })
  expect(await live.find({ type: 'Text', text: /all agents finished/ })).toBeUndefined()
  expect(await live.find({ type: 'Text', text: /^Quando terminar/ })).toBeDefined()
  await live.unmount()
})

test('an agent of the main conversation may start agents that read, on Sonnet at low (Haiku when it asks); none that change code, and none deeper', async ($: any, on) => {
  const { calls, prompts } = bench(on)
  mock.clock(on)
  await step($, 'claude-opus-5-5')
  await spawn($, 'lane', 'sonnet')
  // Its brief says what it may start.
  expect(prompts[0]).toContain('you may start Explore agents to do reading for you')
  const ask = (agentId: string, extra: object) => $.tool.call({ tool: 'Agent', prompt: 'find where refunds are computed', description: 'scout', agentId, ...extra })
  await ask('a-lane', { subagent_type: 'Explore' })
  expect(calls.at(-1)).toMatchObject({ tool: 'Agent', subagent_type: 'Explore', model: 'sonnet', effort: 'low' })
  await ask('a-lane', { subagent_type: 'Explore', model: 'haiku' })
  expect(calls.at(-1)).toMatchObject({ model: 'haiku', effort: 'low' })
  const n = calls.length
  const writer = await ask('a-lane', { subagent_type: 'general-purpose' })
  expect(writer.deny).toContain('only agents that read')
  // The reader it started gets no such line, and may start none of its own.
  await $.agent.spawn({ tool_use_id: 'scout', prompt: 'p', description: 'scout', subagentType: 'Explore', model: 'sonnet', parentAgentId: 'a-lane', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-sonnet-5-5', background: false, fork: false })
  expect(prompts.at(-1)).toBe('p')
  const deeper = await ask('a-scout', { subagent_type: 'Explore' })
  expect(deeper.deny).toContain('cannot start agents of its own')
  expect(calls.length).toBe(n)
  // A loop the main conversation did not start this way (a skill's fork, a workflow's agent) runs its agents as before.
  await ask('a-fork', { subagent_type: 'general-purpose', model: 'opus' })
  expect(calls.at(-1)).toMatchObject({ subagent_type: 'general-purpose', model: 'opus' })
  expect(calls.at(-1).effort).toBeUndefined()
})

test('an agent’s report shows under its notification, or under its call when it ran in the foreground', async ($: any, on) => {
  bench(on)
  on('ui.render', { component: 'UserMessage' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  on('ui.render', { component: 'ToolResult' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>Done (12 tool uses)</Text>
  })
  await step($, 'claude-opus-5-5')
  await spawn($, 'deploy', 'sonnet')
  await step($, 'claude-sonnet-5-5', { agentId: 'a-deploy', effort: 'low' })
  await complete($, 'a-deploy', '**Deployed** to staging: build 4058 passed.')
  const notice = (isExpanded: boolean) => ({ plugin: 'gearbox', component: 'UserMessage', requestId: 'm-1', props: { text: 'Agent "deploy" finished', origin: { kind: 'task-notification' }, isExpanded, task: { id: 'a-deploy', status: 'completed' } } }) as const
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...notice(false), surface })
    for (const text of [/^Agent "deploy" finished$/, /^its report$/]) expect(await ui.find({ type: 'Text', text })).toBeDefined()
    expect(JSON.stringify(await ui.find({ type: 'Markdown' }))).toContain('build 4058 passed')
    await ui.unmount()
    // ctrl+o shows the engine's own row, report included.
    const full = await $.ui.mount({ ...notice(true), surface })
    expect(await full.find({ type: 'Text', text: /^its report$/ })).toBeUndefined()
    await full.unmount()
  }
  // Run in the foreground: under its call.
  const call = (status: string) => ({ plugin: 'gearbox', component: 'ToolResult', requestId: 'deploy', props: { tool_use_id: 'deploy', tool: 'Agent', output: { status }, isErrored: false } }) as const
  const fg = await $.ui.mount({ ...call('completed'), surface: 'terminal' })
  expect(JSON.stringify(await fg.find({ type: 'Markdown' }))).toContain('build 4058 passed')
  await fg.unmount()
  // Launched in the background, the call row stays as it was: the report comes with the notification.
  const bg = await $.ui.mount({ ...call('async_launched'), surface: 'terminal' })
  expect(await bg.find({ type: 'Markdown' })).toBeUndefined()
  await bg.unmount()
})

test('the spinner names the working loop’s model', async ($: any, on) => {
  bench(on)
  // Nothing draws beneath the mod in a test: this hook stands for the engine's spinner.
  on('ui.render', { component: 'Spinner' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`${e.props.word}${e.props.suffix}`}</Text>
  })
  await step($, 'claude-opus-5-5')
  await spawn($, 'browser check', 'sonnet')
  await step($, 'claude-sonnet-5-5', { agentId: 'a-check', effort: 'medium' })
  const spinner = { plugin: 'gearbox', component: 'Spinner', props: { word: 'Sauteing', message: null, suffix: '…', mode: 'thinking' } } as const
  for (const surface of SURFACES) {
    const main = await $.ui.mount({ ...spinner, requestId: 'main-turn', surface })
    expect((await main.find({ type: 'Text' }))?.text).toBe('Sauteing… on opus · high')
    await main.unmount()
    const sub = await $.ui.mount({ ...spinner, requestId: 'a-check', surface })
    expect((await sub.find({ type: 'Text' }))?.text).toBe('Sauteing… on sonnet · medium')
    await sub.unmount()
  }
})

test('the status line counts running subagents, and a fallback is flagged in the pane', async ($: any, on) => {
  const { status } = bench(on)
  await step($, 'claude-opus-5-5')
  expect(status.at(-1)).toBe('opus·high')
  await spawn($, 'browser check', 'sonnet')
  expect(status.at(-1)).toBe('opus·high ⇢ 1 agent: sonnet')
  await step($, 'claude-sonnet-5-5', { agentId: 'a-check', effort: 'medium', answeredBy: 'claude-haiku-5-5' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /browser check/ }))?.text).toContain('answered by haiku')
  await ui.unmount()
  await complete($, 'a-check')
  expect(status.at(-1)).toBe('opus·high')
})

test('/gearbox off clears the readout; /gearbox pane opens it', async ($: any, on) => {
  const { status } = bench(on)
  await step($, 'claude-opus-5-5')
  expect((await $.command.run({ command: 'gearbox', args: 'pane' })).text).toBe('pane open')
  await $.command.run({ command: 'gearbox', args: 'off' })
  expect(status.at(-1)).toBeUndefined()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toContain('gearbox is off')
  await ui.unmount()
})

test('the pane lists every loop, finished ones included, with no filter; a pane: running an older version stored is ignored', async ($: any, on) => {
  const { kv } = bench(on)
  kv.set('settings', { pane: 'running' })
  await step($, 'claude-opus-5-5')
  await spawn($, 'browser check', 'sonnet')
  await spawn($, 'deploy', 'haiku')
  await step($, 'claude-sonnet-5-5', { agentId: 'a-check', effort: 'low' })
  await step($, 'claude-haiku-5-5', { agentId: 'a-deploy', effort: 'low' })
  await complete($, 'a-check')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    for (const text of [/^main/, /browser check/, /deploy/]) expect(await ui.find({ type: 'Text', text })).toBeDefined()
    expect(await ui.find({ type: 'Button' })).toBeUndefined() // no Hide finished / Show finished
    await ui.unmount()
  }
  // /gearbox panel still opens it; the old running|all after it opens it all the same, and says it lists everything.
  expect((await $.command.run({ command: 'gearbox', args: 'panel' })).text).toBe('pane open')
  for (const value of ['running', 'all']) expect((await $.command.run({ command: 'gearbox', args: `panel ${value}` })).text).toBe('pane open. It lists every loop, finished ones included: panel running|all is gone')
  expect(kv.get('settings')).toEqual({ pane: 'running' }) // nothing saved by it
  const view = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await view.find({ type: 'Text', text: /browser check/ })).toBeDefined()
  await view.unmount()
})


