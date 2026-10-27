import { expect, test } from 'claude-code/testing'

const USAGE = { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const SCROLL = { offset: 0, bodyRows: 20 }
const BAND = { plugin: 'gearbox', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: 100, scroll: SCROLL, view: {} } } as const
const PANE = { plugin: 'gearbox', component: 'Pane', requestId: 'gearbox', props: { title: 'gearbox: models now', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: SCROLL, view: {} } } as const
const SURFACES = ['terminal', 'desktop'] as const

// The engine beneath the mod, faked for a session that is not on Haiku: gearbox only watches here.
const bench = (on: any, session = 'claude-opus-5-5') => {
  const kv = new Map<string, unknown>()
  const status: (string | undefined)[] = []
  for (const quiet of ['ui.toast', 'ui.log']) on(quiet, () => ({ value: undefined }))
  on('ui.status', (_: unknown, e: any) => (status.push(e.text), { value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.get', (_: unknown, e: any) => ({ value: kv.get(e.key) }))
  on('store.set', (_: unknown, e: any) => (kv.set(e.key, e.value), { value: undefined }))
  on('session.model', () => ({ value: session }))
  on('agent.spawn', (_: unknown, e: any) => ({ model: e.model ?? 'claude-sonnet-5-5', agentId: e.description === 'deploy' ? 'a-deploy' : 'a-check' }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', (_: unknown, e: any) => ({ text: e.answer }))
  // Stands for the engine's own empty band, drawn when the mod passes.
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>engine band</Text>
  })
  on('turn.step', async function* (_: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...USAGE, model: e.answeredBy ?? e.model } }
  })
  return { status }
}

const step = async ($: any, model: string, extra: object = {}) => {
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model, effort: 'high', messageCount: 3, ...extra })) void _
}

const spawn = ($: any, description: string, model: string) =>
  $.agent.spawn({ tool_use_id: description, prompt: 'p', description, subagentType: 'general-purpose', model, provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false })

const complete = ($: any, agentId?: string) => $.turn.complete({ turnId: 't', answer: '', durationMs: 10, isAborted: false, ...(agentId ? { agentId } : {}) })

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

test('the band shows chips only while a subagent works', async ($: any, on) => {
  bench(on)
  await step($, 'claude-opus-5-5')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /main/ })).toBeUndefined()
    await ui.unmount()
  }
  await spawn($, 'deploy', 'haiku')
  await step($, 'claude-haiku-5-5', { agentId: 'a-deploy', effort: 'low' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /deploy/ }))?.text).toContain('haiku·low')
    expect((await ui.find({ type: 'Text', text: /main/ }))?.text).toContain('opus·high')
    await ui.unmount()
  }
  await complete($, 'a-deploy')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /deploy/ })).toBeUndefined()
  await ui.unmount()
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
    expect((await main.find({ type: 'Text' }))?.text).toBe('Sauteing… on opus')
    await main.unmount()
    const sub = await $.ui.mount({ ...spinner, requestId: 'a-check', surface })
    expect((await sub.find({ type: 'Text' }))?.text).toBe('Sauteing… on sonnet')
    await sub.unmount()
  }
})

test('the status line counts running subagents, and a fallback is flagged in the pane', async ($: any, on) => {
  const { status } = bench(on)
  await step($, 'claude-opus-5-5')
  expect(status.at(-1)).toBe('gearbox ▸ opus·high')
  await spawn($, 'browser check', 'sonnet')
  expect(status.at(-1)).toBe('gearbox ▸ opus·high ⇢ 1 agent: sonnet')
  await step($, 'claude-sonnet-5-5', { agentId: 'a-check', effort: 'medium', answeredBy: 'claude-haiku-5-5' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /browser check/ }))?.text).toContain('answered by haiku')
  await ui.unmount()
  await complete($, 'a-check')
  expect(status.at(-1)).toBe('gearbox ▸ opus·high')
})

test('/gearbox off clears the readout; /gearbox pane opens it', async ($: any, on) => {
  const { status } = bench(on)
  await step($, 'claude-opus-5-5')
  expect((await $.command.run({ command: 'gearbox', args: 'pane' })).text).toBe('gearbox: pane open')
  await $.command.run({ command: 'gearbox', args: 'off' })
  expect(status.at(-1)).toBeUndefined()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toContain('gearbox is off')
  await ui.unmount()
})

test('the pane can hide finished subagents and keep only what is running', async ($: any, on) => {
  bench(on)
  await step($, 'claude-opus-5-5')
  await spawn($, 'browser check', 'sonnet')
  await spawn($, 'deploy', 'haiku')
  await step($, 'claude-sonnet-5-5', { agentId: 'a-check', effort: 'low' })
  await step($, 'claude-haiku-5-5', { agentId: 'a-deploy', effort: 'low' })
  await complete($, 'a-check')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /browser check/ })).toBeDefined() // finished, shown by default
    expect(JSON.stringify(await ui.find({ key: 'pane-filter' }))).toContain('Hide finished')
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'pane-filter' })
  await ui.unmount()
  for (const surface of SURFACES) {
    const view = await $.ui.mount({ ...PANE, surface })
    expect(await view.find({ type: 'Text', text: /browser check/ })).toBeUndefined()
    expect(await view.find({ type: 'Text', text: /deploy/ })).toBeDefined()
    expect(await view.find({ type: 'Text', text: /^main/ })).toBeDefined()
    expect(JSON.stringify(await view.find({ key: 'pane-filter' }))).toContain('Show finished (1)')
    await view.unmount()
  }
  expect((await $.command.run({ command: 'gearbox', args: 'pane all' })).text).toBe('gearbox: pane open')
  const back = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await back.find({ type: 'Text', text: /browser check/ })).toBeDefined()
  await back.unmount()
  expect((await $.command.run({ command: 'gearbox', args: 'pane done' })).text).toBe('gearbox: pane takes running or all')
})
