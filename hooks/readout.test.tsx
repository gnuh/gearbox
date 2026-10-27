import { expect, test } from 'claude-code/testing'
import { shouldSend } from './register'

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
  const toasts: string[] = []
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_: unknown, e: any) => (toasts.push(e.text), { value: undefined }))
  on('ui.status', (_: unknown, e: any) => (status.push(e.text), { value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: panes() }))
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
  return { status, toasts, setCost: (v: number) => { usd = v } }
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

const BAND_AT = (bodyColumns: number) => ({ ...BAND, props: { ...BAND.props, bodyColumns } })

test('the band: effort tabs, actions and five live columns, above what the mods below draw', async ($: any, on) => {
  const { setCost } = bench(on)
  setCost(10)
  await $.prompt.submit({ text: '/review', command: { name: 'review', args: '' } } as any) // a person's prompt starts the tally
  await step($, 'claude-opus-5-5')
  await spawn($, 'deploy', 'haiku')
  await step($, 'claude-haiku-5-5', { agentId: 'a-deploy', effort: 'low' })
  setCost(10.4)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND_AT(120), surface })
    for (const text of [/^coding effort$/, /^opus·high$/, /^1 running$/, /^haiku·low$/, /^2 requests$/, /^opus 1 · haiku 1$/, /^\$10\.40/, /this turn \$0\.40/, /^\/review$/, /^sets its own effort$/, /engine band/]) {
      expect(await ui.find({ type: 'Text', text })).toBeDefined()
    }
    expect(JSON.stringify(await ui.find({ key: 'band-effort-xhigh' }))).toContain('primary') // the default coding effort
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  await ui.press({ key: 'band-effort-high' })
  await ui.press({ key: 'band-popup' })
  await ui.unmount()
  expect((await $.command.run({ command: 'gearbox', args: '' })).text).toContain('coding effort high')
  expect((await $.command.run({ command: 'gearbox', args: '' })).text).toContain('popup always')
})

test('the band keeps three columns in a narrow terminal, and steps aside when switched off', async ($: any, on) => {
  bench(on)
  await step($, 'claude-opus-5-5')
  const narrow = await $.ui.mount({ ...BAND_AT(80), surface: 'terminal' })
  expect(await narrow.find({ type: 'Text', text: /^now$/ })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: /^cost$/ })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: /^this turn$/ })).toBeUndefined()
  await narrow.unmount()
  await $.command.run({ command: 'gearbox', args: 'band off' })
  const off = await $.ui.mount({ ...BAND_AT(120), surface: 'desktop' })
  expect(await off.find({ type: 'Text', text: /coding effort/ })).toBeUndefined()
  expect(await off.find({ type: 'Text', text: /engine band/ })).toBeDefined()
  await off.unmount()
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


// A file system and session id beneath the mod, so the popup can be checked through gearbox's debug log.
const disk = (on: any) => {
  const files = new Map<string, string>()
  on('fs.write', (_: unknown, e: any) => (files.set(e.path, e.text), { value: undefined }))
  on('fs.exists', (_: unknown, e: any) => ({ value: files.has(e.path) }))
  on('fs.read', (_: unknown, e: any) => ({ value: e.path.endsWith('plugin.json') ? '{"version":"9.9.9"}' : files.get(e.path) ?? '' }))
  on('env.get', () => ({ value: '/home/tester' }))
  on('session.id', () => ({ value: 's-1' }))
  on('session.version', () => ({ value: { version: '2.1.311', base: '2.1.311' } }))
  return async ($: any) => {
    await $.command.run({ command: 'gearbox', args: 'log' }) // writes what is pending
    const body = files.get('/home/tester/.claude/gearbox/logs/s-1.jsonl') ?? ''
    return body.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.ev === 'popup')
  }
}

test('popup agents: the running tree, following each change, closing when the agents finish', async ($: any, on) => {
  bench(on)
  const popups = disk(on)
  await $.command.run({ command: 'gearbox', args: 'log on' })
  await $.command.run({ command: 'gearbox', args: 'popup agents' })
  await step($, 'claude-opus-5-5')
  expect(await popups($)).toEqual([]) // the main conversation alone: the status line covers it
  await spawn($, 'browser check', 'sonnet')
  await step($, 'claude-sonnet-5-5', { agentId: 'a-check', effort: 'low' })
  await $.tool.call({ tool: 'mcp__claude-in-chrome__navigate', url: 'http://localhost:3000/cart', agentId: 'a-check' })
  await spawn($, 'deploy', 'haiku')
  await $.tool.call({ tool: 'Bash', command: 'npm run deploy:staging\necho done', agentId: 'a-deploy' })
  const shown = await popups($)
  expect(shown.at(-1)?.text).toBe(
    ['gearbox · opus·high · thinking · 2 agents', '├ browser check · sonnet·low · navigate http://localhost:3000/cart', '└ deploy · haiku · Bash: npm run deploy:staging'].join('\n'),
  )
  await $.tool.call({ tool: 'Bash', command: 'npm run deploy:staging\necho done', agentId: 'a-deploy' })
  expect(await popups($)).toHaveLength(shown.length) // nothing changed: no new popup
  await complete($, 'a-check')
  expect((await popups($)).at(-1)?.text).toContain('gearbox · opus·high · thinking · 1 agent\n└ deploy')
  await complete($, 'a-deploy')
  expect((await popups($)).at(-1)).toMatchObject({ closed: true })
})

test('the popup stays quiet while the gearbox pane is shown, and when switched off', async ($: any, on) => {
  let paneShown = true
  bench(on, 'claude-opus-5-5', () => (paneShown ? [{ id: 'gearbox', title: 'gearbox: models now', isShown: true, isFocused: false, isPlaced: true }] : []))
  const popups = disk(on)
  await $.command.run({ command: 'gearbox', args: 'log on' })
  await $.command.run({ command: 'gearbox', args: 'popup always' })
  await step($, 'claude-opus-5-5')
  await spawn($, 'browser check', 'sonnet')
  expect(await popups($)).toEqual([])
  paneShown = false
  await step($, 'claude-sonnet-5-5', { agentId: 'a-check', effort: 'low' })
  expect((await popups($)).at(-1)?.text).toContain('browser check')
  expect((await $.command.run({ command: 'gearbox', args: 'popup off' })).text).toContain('popup off')
  const before = (await popups($)).length
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a-check' })
  expect(await popups($)).toHaveLength(before)
})

test('popup always: the main conversation alone shows its live model and effort, then done', async ($: any, on) => {
  bench(on)
  const popups = disk(on)
  await $.command.run({ command: 'gearbox', args: 'log on' })
  await $.command.run({ command: 'gearbox', args: 'popup always' })
  await step($, 'claude-opus-5-5', { effort: 'xhigh' })
  expect((await popups($)).at(-1)?.text).toBe('gearbox · opus·xhigh · thinking')
  await $.tool.call({ tool: 'Edit', file_path: '/repo/cart/total.ts', old_string: 'a', new_string: 'b' })
  expect((await popups($)).at(-1)?.text).toBe('gearbox · opus·xhigh · Edit total.ts')
  await step($, 'claude-opus-5-5', { effort: 'low', index: 1 }) // the next request goes out at another effort
  expect((await popups($)).at(-1)?.text).toBe('gearbox · opus·low · Edit total.ts')
  await complete($)
  expect((await popups($)).at(-1)).toMatchObject({ closed: true })
  expect((await $.command.run({ command: 'gearbox', args: 'popup sometimes' })).text).toBe('gearbox: popup takes always, agents or off')
})

test('the popup is renewed while it is up: same text sent again after 8 s, a new text at once', () => {
  expect(shouldSend({}, 'a', 1000)).toBe(true)
  expect(shouldSend({ shown: 'a', sentAt: 1000 }, 'a', 5000)).toBe(false)
  expect(shouldSend({ shown: 'a', sentAt: 1000 }, 'a', 9000)).toBe(true)
  expect(shouldSend({ shown: 'a', sentAt: 1000 }, 'b', 1001)).toBe(true)
})
