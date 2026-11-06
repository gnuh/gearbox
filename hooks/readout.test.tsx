import type { AgentStatus } from 'claude-code'
import { expect, mock, test as fresh } from 'claude-code/testing'

// A new install has the orchestrator on, on Opus, with up to 6 agents, and code fixed to Sonnet. These tests are written
// for a plain session whose rules pick code's model, and for a Sonnet orchestrator with up to 3 agents when they turn
// it on, so each starts from those unless its own options say otherwise; `fresh` is the test with the defaults a new
// install gets.
const test: typeof fresh = ((name: string, ...rest: any[]) => {
  const run = rest.pop()
  const opts = rest[0] ?? {}
  return fresh(name, { ...opts, options: { code_model: 'auto', orchestrator: false, orchestrator_model: 'sonnet', orchestrator_agents: 3, ...opts.options } }, run)
}) as typeof fresh

// The test runtime has timers; the hooks' own environment, whose types these files use, does not.
declare const setTimeout: (done: (value?: unknown) => void, ms: number) => unknown
const pause = () => new Promise(done => setTimeout(done, 5))

const USAGE = { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const SCROLL = { offset: 0, bodyRows: 20 }
const BAND = { plugin: 'gearbox', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: 100, scroll: SCROLL, view: {} } } as const
const PANE = { plugin: 'gearbox', component: 'Pane', requestId: 'gearbox', props: { title: 'gearbox: models now', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: SCROLL, view: {} } } as const
const SURFACES = ['terminal', 'desktop'] as const

// The engine beneath the mod, faked for a session that is not on Haiku: gearbox only watches here. `ids` names the agent a
// spawn starts (by default after its description).
const bench = (on: any, session = 'claude-opus-5-5', panes: () => unknown[] = () => [], ids: (e: any) => string = e => `a-${e.description}`) => {
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
  on('agent.spawn', (_: unknown, e: any) => (prompts.push(e.prompt), { model: e.model ?? 'claude-sonnet-5-5', agentId: e.description === 'deploy' ? 'a-deploy' : e.description === 'browser check' ? 'a-check' : ids(e) }))
  const calls: any[] = []
  on('tool.call', (_: unknown, e: any) => (calls.push(e), { result: {} }))
  on('turn.complete', (_: unknown, e: any) => ({ text: e.answer }))
  // Stands for the engine's own empty band, drawn when the mod passes.
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>engine band</Text>
  })
  // The text each next request writes before it ends, which arrives in small pieces of block 0.
  const texts: string[] = []
  let ended = 0 // requests whose stream ran its cleanup, finished or stopped early
  let usage = USAGE // what each request used
  on('turn.step', async function* (_: unknown, e: any) {
    const text = texts.shift() ?? ''
    try {
      for (let i = 0; i < text.length; i += 7) yield { kind: 'text', index: 0, text: text.slice(i, i + 7), ref: i }
    } finally {
      ended++
    }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...usage, model: e.answeredBy ?? e.model } }
  })
  return { status, calls, prompts, kv, writes: (...t: string[]) => texts.push(...t), settled: () => ended, setCost: (v: number) => { usd = v }, setUsage: (u: typeof USAGE) => { usage = u } }
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

// A mini layout of a drawn tree as text: enough of flex (widths, growth, gaps) to read what a surface is handed.
type El = { type: string; props?: Record<string, any>; children?: (El | string)[] }
const isEl = (c: unknown): c is El => typeof c === 'object' && c !== null
const inline = (n: El | string): string => (typeof n === 'string' ? n : n.type === 'Button' ? `[ ${n.props?.label} ]` : (n.children ?? []).map(inline).join(''))
const cut = (s: string, w: number, truncate: boolean) => (truncate && s.length > w ? `${s.slice(0, Math.max(0, w - 1))}…` : s)
const natural = (n: El | string): number => (typeof n === 'string' ? n.length : n.type === 'Text' || n.type === 'Button' ? Math.max(0, ...inline(n).split('\n').map(l => l.length)) : n.props?.flexDirection === 'row' ? (n.children ?? []).reduce((w: number, c) => w + natural(c), 0) + (Number(n.props?.columnGap ?? 0) || 0) * Math.max(0, (n.children ?? []).length - 1) : Math.max(0, ...(n.children ?? []).map(natural)))
const sp = (v: unknown) => (typeof v === 'number' ? v : v === 'xs' || v === 'sm' ? 1 : v === 'md' ? 2 : v === 'lg' ? 3 : 0)
const lay = (n: El | string, w: number): string[] => {
  if (typeof n === 'string') return [n]
  const p = n.props ?? {}
  if (n.type === 'Text' || n.type === 'Button') return inline(n).split('\n').map(l => cut(l, w, p.wrap === 'truncate' || p.wrap === 'end'))
  const pl = sp(p.paddingLeft ?? p.paddingX ?? p.padding), pr = sp(p.paddingRight ?? p.paddingX ?? p.padding)
  const border = p.borderStyle ? 1 : 0
  const inner = Math.max(0, w - pl - pr - 2 * border)
  const kids = (n.children ?? []).filter(c => c !== '')
  let lines: string[]
  if (p.flexDirection === 'row') {
    const gap = sp(p.columnGap ?? p.gap)
    const nat = kids.map(natural)
    const fixed = kids.map(c => (isEl(c) && typeof c.props?.width === 'number' ? (c.props.width as number) : undefined))
    const grow = kids.map(c => (isEl(c) ? Number(c.props?.flexGrow ?? 0) : 0))
    const base = kids.map((_, i) => fixed[i] ?? (grow[i] ? 0 : nat[i]!))
    let room = inner - base.reduce((a, b) => a + b, 0) - gap * Math.max(0, kids.length - 1)
    const widths = [...base]
    const growers = grow.reduce((a, b) => a + b, 0)
    if (room > 0 && growers) kids.forEach((_, i) => { if (grow[i]) widths[i] = Math.floor((room * grow[i]!) / growers) })
    else if (room < 0) {
      const shr = kids.map((c, i) => (fixed[i] === undefined && !(isEl(c) && c.props?.flexShrink === 0) ? i : -1)).filter(i => i >= 0)
      for (const i of shr) { const take = Math.min(widths[i]!, -room); widths[i] = widths[i]! - take; room += take; if (room >= 0) break }
    }
    const cells = kids.map((c, i) => (isEl(c) && c.props?.backgroundColor && !(c.children ?? []).length ? [] : lay(c, widths[i]!)))
    const h = Math.max(1, ...cells.map(c => c.length))
    lines = Array.from({ length: h }, (_, r) => kids.map((c, i) => (isEl(c) && c.props?.backgroundColor && !(c.children ?? []).length ? '▌'.padEnd(widths[i]!) : (cells[i]![r] ?? '').padEnd(widths[i]!))).join(' '.repeat(gap)).trimEnd())
  } else {
    const gap = sp(p.rowGap ?? p.gap)
    lines = kids.flatMap((c, i) => [...(i && gap ? Array(gap).fill('') : []), ...(isEl(c) ? Array(sp(c.props?.marginTop)).fill('') : []), ...lay(c, inner)])
  }
  lines = lines.map(l => ' '.repeat(pl) + l)
  if (border) {
    const iw = Math.max(0, ...lines.map(l => l.length))
    if (lines.length === 1 && iw <= 24) return [`(${lines[0]!.trim()})`]
    const bw = Math.max(iw, inner + pl)
    return [`╭${'─'.repeat(bw + pr)}╮`, ...lines.map(l => `│${l.padEnd(bw)}${' '.repeat(pr)}│`), `╰${'─'.repeat(bw + pr)}╯`]
  }
  return lines
}
const plain = (tree: unknown, columns: number) => lay(tree as El, columns).map(l => l.trimEnd()).join('\n')

const BAND_AT = (bodyColumns: number) => ({ ...BAND, props: { ...BAND.props, bodyColumns } })
const PANE_AT = (bodyColumns: number) => ({ ...PANE, props: { ...PANE.props, bodyColumns } })

// A drawing as text, its times calmed ("38s" is "Ns", "14:02:31" is "hh:mm:ss") so a test can read the lines it drew.
const calm = (text: string) => text.replace(/\b(?:\d+m )?\d+s\b/g, 'Ns').replace(/\b\d\d:\d\d:\d\d\b/g, 'hh:mm:ss')
const show = async (ui: any, columns: number): Promise<string> => calm(plain(await ui.drawn(), columns))
// The lines the mod drew, without the engine band a test stands in beneath it.
const lines = async (ui: any, columns: number): Promise<string[]> => (await show(ui, columns)).split('\nengine band')[0]!.trimEnd().split('\n')

// What a drawing's lines should be, one pattern each, in order: a line more or less fails the test.
const expectLines = (got: string[], want: RegExp[]) => {
  expect(got).toHaveLength(want.length)
  want.forEach((re, i) => expect(got[i]).toMatch(re))
}

// An agent spawned under another loop (its own agents, one level down).
const spawnUnder = ($: any, description: string, model: string, parentAgentId: string, id = description, subagentType = 'Explore') =>
  $.agent.spawn({ tool_use_id: id, prompt: 'p', description, subagentType, model, parentAgentId, provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-sonnet-5-5', background: true, fork: false })

// The crew the design draws: the main conversation on Opus, its effort left to the orchestrator, splits a request into
// parts that run at once: two on Sonnet whose effort it names, a review on Opus that has already reported; part 2
// started an Explore of its own. `owed`: a fourth part, which the main conversation has not started.
const CREW = { options: { orchestrator: true, orchestrator_model: 'opus', orchestrator_effort: 'auto', code_effort: 'auto', orchestrator_agents: 4 } }
const CREW_PARTS = [
  { what: 'customers', mode: 'code', depth: 1, files: ['services/customers'] },
  { what: 'README', mode: 'code', depth: 1, files: ['docs/README.md'] },
  { what: 'review money.ts', mode: 'review', depth: 1, files: ['services/money'] },
  { what: 'billing', mode: 'code', depth: 1, files: ['services/billing'] },
]
const crew = async ($: any, on: any, o: { owed?: boolean } = {}) => {
  const b = bench(on, 'claude-opus-5-5', () => [], e => `a-${e.tool_use_id}`)
  b.kv.set('consent', false)
  b.setUsage({ ...USAGE, input_tokens: 31000, output_tokens: 2100 })
  b.setCost(12.87)
  const clock = mock.clock(on)
  on('session.cwd', () => ({ value: '/w/app' }))
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => ({ value: { isAnswered: true, text: JSON.stringify({ reach: 'area', depth: 2, mode: 'code', parts: o.owed ? CREW_PARTS : CREW_PARTS.slice(0, 3) }), usage: USAGE } }) as never)
  const start = (id: string, description: string, model: string, extra: object = {}) =>
    $.agent.spawn({ tool_use_id: id, prompt: 'p', description, subagentType: 'general-purpose', model, provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false, ...extra })
  // One request of agent `id`, in which it says something and then calls a tool.
  const run = async (id: string, say: string, call: object, o: { model?: string; effort?: string } = {}) => {
    b.writes(say)
    await step($, o.model ?? 'claude-sonnet-5-5', { agentId: `a-${id}`, effort: o.effort ?? 'xhigh' })
    await $.tool.call({ ...call, agentId: `a-${id}` })
  }
  await $.prompt.submit({ text: 'build the customers report, update the README and review money.ts' })
  b.writes('Waiting for the 2 parts; part 1 already has green tests')
  await step($, 'claude-opus-5-5')
  await $.tool.call({ tool: 'Agent', tool_use_id: 't1', description: 'part 1: customers', prompt: 'p', effort: 'medium' })
  await start('t1', 'part 1: customers', 'sonnet')
  await $.tool.call({ tool: 'Agent', tool_use_id: 't2', description: 'part 2: README', prompt: 'p', effort: 'medium' })
  await start('t2', 'part 2: README', 'sonnet')
  await $.tool.call({ tool: 'Agent', tool_use_id: 't3', description: 'part 3: review money.ts', prompt: 'p' })
  await start('t3', 'part 3: review money.ts', 'opus')
  await run('t1', 'Reading orders.ts to reuse paginate', { tool: 'Read', file_path: '/w/app/src/orders.ts' })
  await run('t1', 'Grouping orders by customer and adding the totals', { tool: 'Write', file_path: '/w/app/src/customers.ts' })
  await run('t2', 'Starting an Explore for every use of paginate', { tool: 'Agent', tool_use_id: 'e1', description: 'Explore · uses of paginate', prompt: 'find', subagent_type: 'Explore' })
  await spawnUnder($, 'Explore · uses of paginate', 'sonnet', 'a-t2', 'e1')
  await run('t2', 'Running the examples to paste real output into the README', { tool: 'Bash', command: 'bun run examples' })
  await run('e1', 'Looking for calls to paginate in src/', { tool: 'Grep', pattern: 'paginate' }, { effort: 'low' })
  await step($, 'claude-opus-5-5', { agentId: 'a-t3', effort: 'xhigh' })
  await $.turn.complete({ turnId: 't', answer: '**6 findings** (1 medium: a fractional discount loses 1 cent)\n\nDetails below.', durationMs: 10, isAborted: false, agentId: 'a-t3' })
  b.setCost(13.27)
  return { ...b, start, run, clock }
}

test('the panel lists every loop with its model, nested under main', async ($: any, on) => {
  bench(on)
  await step($, 'claude-opus-5-5')
  await spawn($, 'browser check', 'sonnet')
  await step($, 'claude-sonnet-5-5', { agentId: 'a-check', effort: 'medium' })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a-check' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const text = await show(ui, 90)
    expect(text).toMatch(/^1 running · 0 done$/m)
    expect(text).toMatch(/^● main +opus·high/m)
    expect(text).toMatch(/^└─● browser check +sonnet·medium/m)
    expect(text).toContain('Bash: ls') // no note yet: the call
    await ui.unmount()
  }
})

test('the band: a header, main and a row per subagent, above what the mods below draw', async ($: any, on) => {
  const { setCost } = bench(on)
  setCost(10)
  await $.prompt.submit({ text: '/review', command: { name: 'review', args: '' } } as any) // a person's prompt starts the tally
  await step($, 'claude-opus-5-5')
  await spawn($, 'deploy', 'haiku')
  await step($, 'claude-haiku-5-5', { agentId: 'a-deploy', effort: 'low' })
  await $.tool.call({ tool: 'Bash', command: './deploy.sh staging', agentId: 'a-deploy' })
  setCost(10.4)
  const term = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  for (const text of [/^GearBox$/, /^opus·high$/, /^1 agent$/, /^2 req$/, /^\$10\.40$/, /^\/review$/, /engine band/]) expect(await term.find({ type: 'Text', text })).toBeDefined()
  expectLines(await lines(term, 120), [
    /^GearBox +opus·high · 1 agent · this turn 2 req · \$10\.40 · why \/review +\[ Panel \] +\[ Settings \]$/,
    /^─+$/,
    /^● main +opus·high +1 req +Ns$/,
    /^ {2}thinking$/,
    /^└─● deploy +haiku·low +1 req +Ns +\[ ■ \]$/,
    /^ {4}Bash: \.\/deploy\.sh staging$/,
  ])
  expect(await term.find({ type: 'Text', text: /—|⌀|avg/ })).toBeUndefined() // no dash, and no average of one turn
  for (const key of ['band-pane', 'band-settings', 'stop-a-deploy']) expect(await term.find({ key })).toBeDefined()
  expect(await term.find({ key: 'band-log' })).toBeUndefined() // the log is switched in Settings only
  expect(await term.find({ key: 'stop-main' })).toBeUndefined() // main is not stopped from here: Esc does that
  expect(await term.find({ key: 'band-effort-xhigh' })).toBeUndefined() // the coding effort lives in Settings now
  expect(await term.find({ type: 'Text', text: /^─+$/ })).toBeDefined() // the terminal rules its band
  await term.unmount()
  // The desktop draws metrics and cards, no rule.
  const desk = await $.ui.mount({ ...BAND_AT(120), surface: 'desktop' })
  for (const text of [/^GearBox$/, /^opus·high$/, /^1 running$/, /^haiku·low$/, /^2 requests$/, /^opus 1 · haiku 1$/, /^\$10\.40/, /this turn \$0\.40/, /^\/review$/, /^sets its own effort$/, /^deploy$/, /^Bash: \.\/deploy\.sh staging$/, /engine band/]) {
    expect(await desk.find({ type: 'Text', text })).toBeDefined()
  }
  for (const key of ['band-pane', 'band-settings', 'card-main', 'card-a-deploy', 'stop-a-deploy']) expect(await desk.find({ key })).toBeDefined()
  expect(await desk.find({ key: 'band-log' })).toBeUndefined()
  expect(await desk.find({ type: 'Text', text: /^─+$/ })).toBeUndefined()
  await desk.unmount()
  // A second turn brings the bars and the average.
  await $.prompt.submit({ text: 'and the coupon too' })
  setCost(10.9)
  const two = await $.ui.mount({ ...BAND_AT(120), surface: 'desktop' })
  expect(await two.find({ type: 'Text', text: /^ [▁▂▃▄▅▆▇█]{2}$/ })).toBeDefined()
  expect(await two.find({ type: 'Text', text: /this turn \$0\.50 · avg \$0\.45/ })).toBeDefined()
  await two.unmount()
  const bars = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  expect(await bars.find({ type: 'Text', text: /^ [▁▂▃▄▅▆▇█]{2}$/ })).toBeDefined()
  await bars.unmount()
})

test('the band draws main and its agents as a tree, two lines each: the identity, then the note and its tool; an agent’s own agent nests deeper', CREW, async ($: any, on) => {
  await crew($, on)
  const ui = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  expectLines(await lines(ui, 120), [
    /^GearBox +opus·high \(auto\) · 3 agents · this turn 7 req · \$13\.27 · why code · area +\[ Panel \] +\[ Settings \]$/,
    /^─+$/,
    /^● main +opus·high +1 req +Ns$/,
    /^ {2}Waiting for the 2 parts; part 1 already has green tests · Agent$/,
    /^├─● part 1 · customers +sonnet·medium +main +2 req +Ns +\[ ■ \]$/,
    /^│ {3}Grouping orders by customer and adding the totals · Write$/,
    /^├─● part 2 · README +sonnet·medium +main +2 req +Ns +\[ ■ \]$/,
    /^│ {3}Running the examples to paste real output into the README · Bash$/,
    /^│ └─● Explore · uses of paginate +sonnet·low +rules +1 req +Ns +\[ ■ \]$/,
    /^│ {5}Looking for calls to paginate in src\/ · Grep$/,
    /^└─✓ part 3 · review money\.ts +opus·medium +rules +done · 6 findings \(1 medium: a fraction… +1 req +Ns$/,
  ])
  // The tool is its own, dimmed, piece after the note.
  expect(await ui.find({ type: 'Text', text: /^Grouping orders by customer and adding the totals · Write$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ · Write$/ })).toBeDefined()
  await ui.unmount()
})

test('a terminal under 100 columns draws the narrow band: no tool, no source of the effort, no worktree, an agent’s own agent in one line', CREW, async ($: any, on) => {
  await crew($, on)
  const ui = await $.ui.mount({ ...BAND_AT(80), surface: 'terminal' })
  expectLines(await lines(ui, 80), [
    /^GearBox opus·high \(auto\) · 3 agents · \$13\.27 +\[ Panel \] \[ Settings \]$/,
    /^─+$/,
    /^● main +opus·high +Ns$/,
    /^ {2}Waiting for the 2 parts; part 1 already has green tests$/,
    /^├─● part 1 +sonnet·medium +Ns \[ ■ \]$/,
    /^│ {3}Grouping orders by customer and adding the totals$/,
    /^├─● part 2 +sonnet·medium +Ns \[ ■ \]$/,
    /^│ {3}Running the examples to paste real output into the README$/,
    /^│ └─● Explore +sonnet·low +Ns \[ ■ \]$/,
    /^└─✓ part 3 · review money\.ts · 6 findings .*$/,
  ])
  expect(await ui.find({ type: 'Text', text: /this turn|why|rules|· Write/ })).toBeUndefined()
  await ui.unmount()
  // A long note is cut with an ellipsis.
  const tight = await $.ui.mount({ ...BAND_AT(50), surface: 'terminal' })
  expect((await lines(tight, 50)).some(l => l.endsWith('…'))).toBe(true)
  await tight.unmount()
})

test('the band draws four live agents at most and counts the rest; an answer from another model shows as ⚠', async ($: any, on) => {
  const { status } = bench(on)
  await step($, 'claude-opus-5-5')
  for (const n of [1, 2, 3, 4, 5, 6]) await spawn($, `c${n}`, 'sonnet')
  expect(status.at(-1)).toBe('opus·high ⇢ 6 agents: sonnet ×6')
  await step($, 'claude-sonnet-5-5', { agentId: 'a-c1', effort: 'low', answeredBy: 'claude-haiku-5-5' })
  const term = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  expectLines(await lines(term, 120), [
    /^GearBox +opus·high · 6 agents · /,
    /^─+$/,
    /^● main /,
    /^ {2}thinking$/,
    /^├─⚠ c1 +sonnet·low +1 req +Ns +\[ ■ \]$/,
    /^│ {3}thinking · answered by haiku$/,
    /^├─● c2 +sonnet +0 req +Ns +\[ ■ \]$/,
    /^│ {3}thinking$/,
    /^├─● c3 /,
    /^│ {3}thinking$/,
    /^└─● c4 /,
    /^ {4}thinking$/,
    /^\+2 agents · Panel$/,
  ])
  expect(await term.find({ type: 'Text', text: /c5/ })).toBeUndefined()
  await term.unmount()
  const desk = await $.ui.mount({ ...BAND_AT(120), surface: 'desktop' })
  for (const n of [1, 2, 3, 4]) expect(await desk.find({ key: `card-a-c${n}` })).toBeDefined()
  for (const n of [5, 6]) expect(await desk.find({ key: `card-a-c${n}` })).toBeUndefined()
  expect(await desk.find({ type: 'Text', text: /^\+2 agents · Panel$/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /^⚠ answered by haiku$/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /^6 running$/ })).toBeDefined()
  await desk.unmount()
})

test('the band keeps a short header in a narrow terminal, and the desktop three metrics in a narrow window; it cannot be switched off any more', async ($: any, on) => {
  bench(on)
  await step($, 'claude-opus-5-5')
  const narrow = await $.ui.mount({ ...BAND_AT(80), surface: 'terminal' })
  expect(await narrow.find({ type: 'Text', text: /^GearBox$/ })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: /^\$1\.25$/ })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: /this turn/ })).toBeUndefined()
  expect(await narrow.find({ type: 'Text', text: /^[├└]─/ })).toBeUndefined() // no subagent runs
  await narrow.unmount()
  // The desktop app counts fewer, wider cells: 100 columns there still hold all five metrics, 50 keep three.
  const desk = await $.ui.mount({ ...BAND_AT(80), surface: 'desktop' })
  for (const text of [/^this turn$/, /^why$/]) expect(await desk.find({ type: 'Text', text })).toBeDefined()
  await desk.unmount()
  const tiny = await $.ui.mount({ ...BAND_AT(50), surface: 'desktop' })
  for (const text of [/^now$/, /^agents$/, /^cost$/]) expect(await tiny.find({ type: 'Text', text })).toBeDefined()
  for (const text of [/^this turn$/, /^why$/]) expect(await tiny.find({ type: 'Text', text })).toBeUndefined()
  await tiny.unmount()
  expect((await $.command.run({ command: 'gearbox', args: 'band off' })).text).toContain('band is no longer a setting')
  const still = await $.ui.mount({ ...BAND_AT(120), surface: 'desktop' })
  expect(await still.find({ type: 'Text', text: /GearBox/ })).toBeDefined()
  expect(await still.find({ type: 'Text', text: /engine band/ })).toBeDefined()
  await still.unmount()
})

test('a band: false an older version stored, or a plugin option, is ignored: the band still draws', { options: { band: false } }, async ($: any, on) => {
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
    expect(await band.find({ type: 'Text', text: /deploy/ })).toBeDefined()
    await band.unmount()
    // Nothing is drawn under the reply.
    const reply = await $.ui.mount({ ...REPLY('Deploying now.'), surface })
    expect(await reply.find({ type: 'Text', text: /still at work/ })).toBeUndefined()
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
    for (const text of [surface === 'terminal' ? /^├─◐ deploy$/ : /^◐$/, /^waiting on its own background work$/, surface === 'terminal' ? /^└─● browser check$/ : /^browser check$/]) {
      expect(await ui.find({ type: 'Text', text })).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: surface === 'terminal' ? /^2 agents$/ : /^1 running · 1 waiting$/ })).toBeDefined()
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
  // Ended on the engine's list: the next look drops it from the live agents; its end is one dimmed line.
  agents['a-deploy'] = 'completed'
  await clock.advance(3000)
  expect(status.at(-1)).toBe('opus·high ⇢ 1 agent: haiku')
  const ui = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /◐ deploy/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^├─✓ deploy$/ })).toBeDefined()
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
  await spawnUnder($, 'scout', 'haiku', 'a-lane')
  const ui = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  const rows = (await lines(ui, 120)).map(l => /^([│ ├└─]*[●◐✓✗◌⚠]) (\S+)/.exec(l)).filter(Boolean).map(m => `${m![1]} ${m![2]}`)
  expect(rows).toEqual(['● main', '├─● lane', '│ └─● scout', '└─● review'])
  await ui.unmount()
  const desk = await $.ui.mount({ ...BAND_AT(120), surface: 'desktop' })
  // On the desktop the scout's card is inside the lane's, and the review's is beside it.
  const lane = JSON.stringify(await desk.find({ key: 'card-a-lane' }))
  expect(lane).toContain('card-a-scout')
  expect(lane).not.toContain('card-a-review')
  expect(await desk.find({ type: 'Text', text: /^started by lane$/ })).toBeDefined()
  await desk.unmount()
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
    for (const text of surface === 'terminal' ? [/● ghost task$/, /● deploy$/, /^2 agents$/] : [/^ghost task$/, /^deploy$/, /^2 running$/]) expect(await ui.find({ type: 'Text', text })).toBeDefined()
    await ui.unmount()
  }
})

test('agents are shown in the band only: nothing is drawn under the last reply while they work or after they finish', async ($: any, on) => {
  const { status } = bench(on)
  const clock = mock.clock(on)
  const agents = listing(on)
  on('ui.render', { component: 'AssistantMessage' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  const answer = 'A verificação vai rodar pelo Docker.\n\nQuando terminar, trago o que mudou.'
  const bare = ['Quando terminar, trago o que mudou.']
  await step($, 'claude-opus-5-5')
  await spawn($, 'deploy', 'sonnet')
  agents['a-deploy'] = 'running'
  await step($, 'claude-sonnet-5-5', { agentId: 'a-deploy', effort: 'low' })
  await $.tool.call({ tool: 'Bash', command: './deploy.sh', agentId: 'a-deploy' })
  await complete($, undefined, answer)
  for (const surface of SURFACES) {
    // An agent at work: the reply is the engine's own, with no rows and no count under it.
    const ui = await $.ui.mount({ ...REPLY('Quando terminar, trago o que mudou.'), surface })
    expect(await lines(ui, 100)).toEqual(bare)
    expect(await ui.find({ type: 'Text', text: /still at work|not done yet|deploy|sonnet|Bash/ })).toBeUndefined()
    await ui.unmount()
    // The band above the prompt is where it shows, and that main waits on it.
    const band = await $.ui.mount({ ...BAND_AT(120), surface })
    expect(await band.find({ type: 'Text', text: surface === 'terminal' ? /^└─● deploy$/ : /^deploy$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^agents at work · main waits · not done yet$/ })).toBeDefined()
    await band.unmount()
  }
  const live = await $.ui.mount({ ...REPLY('Quando terminar, trago o que mudou.'), surface: 'terminal' })
  // Its turn ends while it waits on its own background work: the reply stays as it was.
  agents['a-deploy'] = 'waiting'
  await complete($, 'a-deploy')
  expect(await lines(live, 100)).toEqual(bare)
  // It ends: no line says so under the reply; the band keeps it, dimmed, until the next prompt.
  await pause()
  agents['a-deploy'] = 'completed'
  await clock.advance(3000)
  expect(await lines(live, 100)).toEqual(bare)
  expect(await live.find({ type: 'Text', text: /all agents finished|still at work|deploy|✓|◐/ })).toBeUndefined()
  expect(status.at(-1)).toBe('opus·high')
  const band = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /^└─✓ deploy$/ })).toBeDefined()
  await band.unmount()
  // The next prompt changes nothing under the reply either.
  await $.prompt.submit({ text: 'e agora?' })
  expect(await lines(live, 100)).toEqual(bare)
  await live.unmount()
})

test('a new note keeps the last tool beside it, in the band and the panel, until a new call replaces it', async ($: any, on) => {
  const b = bench(on)
  await step($, 'claude-opus-5-5')
  await spawn($, 'deploy', 'sonnet')
  b.writes('Reading the config')
  await step($, 'claude-sonnet-5-5', { agentId: 'a-deploy', effort: 'low' })
  await $.tool.call({ tool: 'Read', file_path: '/w/app/config.ts', agentId: 'a-deploy' })
  // A new note, and no call yet: the line is the note and the tool called before it.
  b.writes('Now the migration')
  await step($, 'claude-sonnet-5-5', { agentId: 'a-deploy', effort: 'low' })
  const term = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: /^Now the migration · Read$/ })).toBeDefined()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const before = await show(pane, 100)
  expect(before).toMatch(/hh:mm:ss {2}Now the migration$/m) // the note itself has not been followed by a call
  expect(before).toMatch(/hh:mm:ss {2}Reading the config · Read$/m)
  const desk = await $.ui.mount({ ...BAND_AT(120), surface: 'desktop' })
  expect(await desk.find({ type: 'Text', text: /^Now the migration$/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /^Read$/ })).toBeDefined()
  // A new call replaces it, and the note it follows is the one on the line.
  await $.tool.call({ tool: 'Bash', command: 'bun run migrate', agentId: 'a-deploy' })
  expect(await term.find({ type: 'Text', text: /^Now the migration · Bash$/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /· Read/ })).toBeUndefined()
  expect(await show(pane, 100)).toMatch(/hh:mm:ss {2}Now the migration · Bash$/m)
  expect(await desk.find({ type: 'Text', text: /^Bash$/ })).toBeDefined()
  // Main's line keeps its tool as well.
  b.writes('Waiting for the deploy')
  await step($, 'claude-opus-5-5')
  await $.tool.call({ tool: 'Agent', description: 'deploy', prompt: 'p' })
  b.writes('Checking the result')
  await step($, 'claude-opus-5-5')
  expect(await term.find({ type: 'Text', text: /^Checking the result · Agent$/ })).toBeDefined()
  for (const ui of [term, pane, desk]) await ui.unmount()
})

// A long note the way an agent writes it: one sentence of about 130 characters.
const LONG = 'Checking that the new endpoint refuses a request that carries no attribution token before I write the migration that adds the column'

// What the note on a drawn line shows: the text after the tree's guides, up to the tool dimmed after it.
const shownNote = (line: string, guides: RegExp = /^[│ ├└─]*/) => line.replace(guides, '').replace(/ · (Write|Bash)$/, '')
// A note cut at a word: the text before its ellipsis is a prefix of the whole whose next character is a space.
const cutAtWord = (shown: string, whole: string) => shown.endsWith('…') && whole.startsWith(shown.slice(0, -1)) && whole[shown.length - 1] === ' '

test('a long note is stored cut at a word, and each text surface cuts it at a word again to fit its width, keeping the tool', async ($: any, on) => {
  const b = bench(on)
  await step($, 'claude-opus-5-5')
  await spawn($, 'deploy', 'sonnet')
  b.writes(LONG)
  await step($, 'claude-sonnet-5-5', { agentId: 'a-deploy', effort: 'low' })
  await $.tool.call({ tool: 'Write', file_path: '/w/app/migration.ts', agentId: 'a-deploy' })
  expect(LONG.length).toBeGreaterThan(120)
  // Stored: the panel, wide enough to show it whole, has it cut at a word within 120 characters.
  const wide = await $.ui.mount({ ...PANE_AT(200), surface: 'terminal' })
  const stored = /hh:mm:ss {2}(.+?) · Write$/m.exec(await show(wide, 200))![1]!
  expect(stored.length).toBeLessThanOrEqual(120)
  expect(cutAtWord(stored, LONG)).toBe(true)
  await wide.unmount()
  // Drawn: a band of 100 columns fits the note (the tool stays after it) cut at a word within the line.
  const term = await $.ui.mount({ ...BAND_AT(100), surface: 'terminal' })
  const line = (await lines(term, 100)).find(l => l.includes('Checking'))!
  expect(line.length).toBeLessThanOrEqual(100)
  expect(line).toEndWith('… · Write')
  const fitted = shownNote(line)
  expect(fitted.length).toBeLessThan(stored.length)
  expect(cutAtWord(fitted, LONG)).toBe(true)
  await term.unmount()
  // A narrow band has no tool and cuts at a word as well.
  const narrow = await $.ui.mount({ ...BAND_AT(60), surface: 'terminal' })
  const small = (await lines(narrow, 60)).find(l => l.includes('Checking'))!
  expect(small.length).toBeLessThanOrEqual(60)
  expect(cutAtWord(shownNote(small), LONG)).toBe(true)
  await narrow.unmount()
  // The panel in a narrow pane too.
  const tight = await $.ui.mount({ ...PANE_AT(60), surface: 'terminal' })
  const row = (await show(tight, 60)).split('\n').find(l => l.includes('Checking'))!
  expect(row.length).toBeLessThanOrEqual(60)
  expect(row).toEndWith('… · Write')
  expect(cutAtWord(shownNote(row, /^.*hh:mm:ss {2}/), LONG)).toBe(true)
  await tight.unmount()
  // The desktop's card is as wide as its window lets the text be: it gets the stored note.
  const desk = await $.ui.mount({ ...BAND_AT(120), surface: 'desktop' })
  expect(await desk.find({ type: 'Text', text: new RegExp(`^${stored.replace('…', '…')}$`) })).toBeDefined()
  await desk.unmount()
})

test('a finished agent is one dimmed line with its result, a failed one has a ✗, and the next prompt takes both off the band; the panel keeps them', async ($: any, on) => {
  bench(on)
  mock.clock(on)
  await $.prompt.submit({ text: 'review it and migrate' })
  await step($, 'claude-opus-5-5')
  await spawn($, 'review money.ts', 'opus')
  await spawn($, 'migrate', 'haiku')
  await spawn($, 'deploy', 'sonnet')
  await step($, 'claude-opus-5-5', { agentId: 'a-review money.ts', effort: 'medium' })
  await $.turn.complete({ turnId: 't', answer: '## 6 findings\n\n1 medium: a fractional discount loses 1 cent.', durationMs: 10, isAborted: false, agentId: 'a-review money.ts' })
  await $.turn.complete({ turnId: 't', answer: 'Could not reach the database.', durationMs: 10, isAborted: false, reason: 'error', agentId: 'a-migrate' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND_AT(120), surface })
    if (surface === 'terminal') {
      expectLines(await lines(ui, 120), [
        /^GearBox +opus·high · 1 agent · /,
        /^─+$/,
        /^● main /,
        /^ {2}thinking$/,
        /^├─✓ review money\.ts +opus·medium +done · 6 findings +1 req +Ns$/,
        /^├─✗ migrate +haiku +failed · Could not reach the database\. +0 req +Ns$/,
        /^└─● deploy +sonnet /,
        /^ {4}thinking$/,
      ])
    } else {
      expect(await ui.find({ type: 'Text', text: /^done — 6 findings$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^failed — Could not reach the database\.$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^✓$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^✗$/ })).toBeDefined()
    }
    await ui.unmount()
  }
  // A done line is dimmed, except its ✓, which keeps the state's colour.
  const term = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  const done = JSON.stringify(await term.find({ type: 'Text', text: /^├─✓ review money\.ts$/ }))
  expect(done).toContain('"dimColor":true')
  expect(done).toContain('"color":"#4FBF6A"')
  expect(JSON.stringify(await term.find({ type: 'Text', text: /^├─✗ migrate$/ }))).toContain('"color":"#E5646E"')
  await term.unmount()
  await pause()
  await $.prompt.submit({ text: 'and now the docs' })
  const next = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  expect(await next.find({ type: 'Text', text: /review money\.ts|migrate/ })).toBeUndefined()
  expect(await next.find({ type: 'Text', text: /deploy/ })).toBeDefined() // still at work
  await next.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const text = await show(pane, 100)
  expect(text).toMatch(/✓ review money\.ts/)
  expect(text).toMatch(/done hh:mm:ss — 6 findings/)
  expect(text).toMatch(/failed hh:mm:ss — Could not reach the database\./)
  await pane.unmount()
})

test('a fan-out part whose agent has not started is queued (◌) under main, until it starts', CREW, async ($: any, on) => {
  const { start } = await crew($, on, { owed: true })
  const term = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  const queued = (await lines(term, 120)).slice(-2)
  expect(queued[0]).toMatch(/^├─✓ part 3 · review money\.ts /)
  expect(queued[1]).toMatch(/^└─◌ part 4 · billing +sonnet·\w+ +queued$/)
  expect(await term.find({ type: 'Text', text: /^3 agents$/ })).toBeDefined() // a queued part is no agent yet
  await term.unmount()
  const narrow = await $.ui.mount({ ...BAND_AT(80), surface: 'terminal' })
  expect((await lines(narrow, 80)).at(-1)).toMatch(/^└─◌ part 4 +sonnet·\w+ +queued$/)
  await narrow.unmount()
  const desk = await $.ui.mount({ ...BAND_AT(120), surface: 'desktop' })
  expect(await desk.find({ key: 'card-queued:0' })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /^queued — ?/ })).toBeUndefined()
  await desk.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await show(pane, 100)).toMatch(/^3 running · 1 done · 1 queued$/m)
  await pane.unmount()
  // Its agent starts: the part is no longer queued.
  await $.tool.call({ tool: 'Agent', tool_use_id: 't4', description: 'part 4: billing', prompt: 'p', effort: 'high' })
  await start('t4', 'part 4: billing', 'sonnet')
  const after = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /◌|queued/ })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: /part 4 · billing/ })).toBeDefined()
  await after.unmount()
})

test('the panel gives each agent its last three notes, the files it touched, its worktree and what it cost, nested as the band is', CREW, async ($: any, on) => {
  const { run } = await crew($, on)
  // Part 1 makes a worktree, writes two more notes and edits: four notes in all, of which the panel keeps three.
  await run('t1', 'Creating the worktree for the part', { tool: 'Bash', command: 'git -C /w/app worktree add /tmp/gb-wt-customers -b part/customers' })
  await run('t1', 'Testing the grouping', { tool: 'Edit', file_path: '/w/app/src/customers.ts' })
  await run('t1', 'Fixing the totals', { tool: 'Edit', file_path: '/w/app/src/orders.ts' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE_AT(110), surface })
    expectLines((await lines(ui, 110)).filter(l => !/^\s*$/.test(l)).slice(0, 15), [
      /^3 running · 1 done$/,
      /^● main +opus·high +\(auto: hand-off\) +1 req · Ns · \$0\.17$/,
      /^ {2}hh:mm:ss {2}Waiting for the 2 parts; part 1 already has green tests · Agent$/,
      /^├─● part 1 · customers +sonnet·medium +chosen by main +⎇ part\/customers {2}\/tmp\/gb-wt-custom… +\[ ■ \]$/,
      /^│ {3}5 req · Ns · 155\.0k in \/ 10\.5k out · \$0\.4[12]$/,
      /^│ {3}hh:mm:ss {2}Fixing the totals · Edit$/,
      /^│ {3}hh:mm:ss {2}Testing the grouping · Edit$/,
      /^│ {3}hh:mm:ss {2}Creating the worktree for the part · Bash$/,
      /^│ {3}files: src\/orders\.ts \(edited\) · src\/customers\.ts \(new\)$/,
      /^├─● part 2 · README +sonnet·medium +chosen by main +\[ ■ \]$/,
      /^│ {3}2 req · Ns · 62\.0k in \/ 4\.2k out · \$0\.17$/,
      /^│ {3}hh:mm:ss {2}Running the examples to paste real output into the README · Bash$/,
      /^│ {3}hh:mm:ss {2}Starting an Explore for every use of paginate · Agent$/,
      /^│ └─● Explore · uses of paginate +sonnet·low +by rules +\[ ■ \]$/,
      /^│ {5}1 req · Ns · 31\.0k in \/ 2\.1k out · \$0\.08$/,
    ])
    await ui.unmount()
  }
})

test('an agent of the main conversation may start agents that read, on Sonnet at low (Haiku when it asks), work that is not code, and one agent at a time that writes code; none deeper', async ($: any, on) => {
  const { calls, prompts } = bench(on)
  mock.clock(on)
  // Every brief an agent's agent is given reads as code, here.
  on('model.complete', () => ({ value: { isAnswered: true, text: JSON.stringify({ reach: 'area', depth: 1, mode: 'code' }), usage: USAGE } }) as never)
  await step($, 'claude-opus-5-5')
  await spawn($, 'lane', 'sonnet')
  // Its brief says what it may start, and what the review of its agents needs.
  expect(prompts[0]).toContain('you may start agents of your own, one level deep')
  expect(prompts[0]).toContain('Explore agents do reading for you')
  const ask = (agentId: string, extra: object) => $.tool.call({ tool: 'Agent', prompt: 'find where refunds are computed', description: 'scout', agentId, ...extra })
  await ask('a-lane', { subagent_type: 'Explore' })
  expect(calls.at(-1)).toMatchObject({ tool: 'Agent', subagent_type: 'Explore', model: 'sonnet', effort: 'low' })
  await ask('a-lane', { subagent_type: 'Explore', model: 'haiku' })
  expect(calls.at(-1)).toMatchObject({ model: 'haiku', effort: 'low' })
  // One plain agent that writes code starts, on the gear its brief calls for; a second, while it is at work, is refused.
  const writer = await ask('a-lane', { subagent_type: 'general-purpose', description: 'stream the importer', tool_use_id: 'w1' })
  expect(writer.deny).toBeUndefined()
  expect(calls.at(-1)).toMatchObject({ subagent_type: 'general-purpose', model: 'sonnet', effort: 'xhigh' })
  const n = calls.length
  const second = await ask('a-lane', { subagent_type: 'general-purpose', description: 'stream the exporter', tool_use_id: 'w2' })
  expect(second.deny).toContain('still running')
  expect(calls.length).toBe(n)
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

test('the parts an agent splits its own work into show under it in the band and the panel, the files they change on the agent too; a writer refused shows as a ✗ row under it', CREW, async ($: any, on) => {
  const b = bench(on, 'claude-opus-5-5', () => [], e => `a-${e.tool_use_id}`)
  b.kv.set('consent', false)
  mock.clock(on)
  on('session.cwd', () => ({ value: '/w/app' }))
  on('model.complete', () => ({ value: { isAnswered: true, text: JSON.stringify({ reach: 'area', depth: 1, mode: 'code' }), usage: USAGE } }) as never)
  await step($, 'claude-opus-5-5')
  await spawn($, 'lane', 'sonnet')
  const split = await $.tool.call({ tool: 'mcp__gearbox__fan', agentId: 'a-lane', parts: [{ what: 'orders', mode: 'code', depth: 1, files: ['services/orders'] }, { what: 'billing', mode: 'code', depth: 1, files: ['services/billing'] }] })
  expect(String(split.result)).toContain('2 independent parts')
  const under = async (n: number, what: string) => {
    await $.tool.call({ tool: 'Agent', tool_use_id: `p${n}`, description: `part ${n}: ${what}`, prompt: 'p', agentId: 'a-lane' })
    await spawnUnder($, `part ${n}: ${what}`, 'sonnet', 'a-lane', `p${n}`, 'general-purpose')
  }
  await under(1, 'orders')
  await under(2, 'billing')
  b.writes('Paging the orders list')
  await step($, 'claude-sonnet-5-5', { agentId: 'a-p1', effort: 'high' })
  await $.tool.call({ tool: 'Edit', file_path: '/w/app/src/orders.ts', agentId: 'a-p1' })
  // A writer past the split is refused while the parts write; it shows beside them, under the agent that asked.
  await $.tool.call({ tool: 'Agent', tool_use_id: 'w9', description: 'one more', prompt: 'p', agentId: 'a-lane' })
  for (const surface of SURFACES) {
    const term = await $.ui.mount({ ...BAND_AT(120), surface })
    if (surface === 'terminal') {
      const drawn = (await lines(term, 120)).join('\n')
      expect(drawn).toMatch(/^● main /m)
      expect(drawn).toMatch(/^└─● lane +sonnet/m)
      expect(drawn).toMatch(/^ {2}├─● part 1 · orders +sonnet·high/m)
      expect(drawn).toMatch(/^ {2}├─● part 2 · billing +sonnet/m)
      expect(drawn).toMatch(/^ {2}└─✗ one more/m)
    } else {
      expect(await term.find({ type: 'Text', text: /part 1 · orders/ })).toBeDefined()
      expect(await term.find({ type: 'Text', text: /part 2 · billing/ })).toBeDefined()
    }
    await term.unmount()
  }
  const pane = await $.ui.mount({ ...PANE_AT(110), surface: 'terminal' })
  const text = await show(pane, 110)
  expect(text).toMatch(/^└─● lane /m)
  expect(text).toMatch(/^ {2}├─● part 1 · orders /m)
  // The file part 1 edited is on the agent that started it as well: its review has the list to run git diff on.
  expect(text.match(/files: src\/orders\.ts \(edited\)/g)).toHaveLength(2)
  await pane.unmount()
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

test('the status line counts running subagents, and a fallback is flagged in the panel', async ($: any, on) => {
  const { status } = bench(on)
  await step($, 'claude-opus-5-5')
  expect(status.at(-1)).toBe('opus·high')
  await spawn($, 'browser check', 'sonnet')
  expect(status.at(-1)).toBe('opus·high ⇢ 1 agent: sonnet')
  await step($, 'claude-sonnet-5-5', { agentId: 'a-check', effort: 'medium', answeredBy: 'claude-haiku-5-5' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await show(ui, 90)).toMatch(/^└─⚠ browser check +sonnet·medium +⚠ answered by haiku +\[ ■ \]$/m)
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

test('the panel lists every loop, finished ones included, with no filter; a pane: running an older version stored is ignored', async ($: any, on) => {
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
    for (const text of [/main/, /browser check/, /deploy/]) expect(await ui.find({ type: 'Text', text })).toBeDefined()
    expect(await show(ui, 90)).toMatch(/^1 running · 1 done$/m)
    // No Hide finished / Show finished: the only button is the Stop of the agent still at work.
    expect((await ui.findAll({ type: 'Button' })).map((b: any) => b.key)).toEqual(['stop-a-deploy'])
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

// What a loop says before it calls a tool shows in place of the call: the first line of its note, then the tool dimmed.
test('the band and the panel show an agent’s note and its tool in place of the command', async ($: any, on) => {
  const { writes } = bench(on)
  mock.clock(on)
  await step($, 'claude-opus-5-5')
  await spawn($, 'deploy', 'haiku')
  await spawn($, 'checks', 'haiku')
  writes('Deploying to staging.')
  await step($, 'claude-haiku-5-5', { agentId: 'a-deploy', effort: 'low' })
  await $.tool.call({ tool: 'Bash', command: './deploy.sh staging', agentId: 'a-deploy' })
  // No note yet: the command, as before.
  await step($, 'claude-haiku-5-5', { agentId: 'a-checks', effort: 'low' })
  await $.tool.call({ tool: 'Grep', pattern: 'TODO', agentId: 'a-checks' })
  for (const surface of SURFACES) {
    // The panel and the terminal's band draw the note and its tool in one line; the desktop's card, a chip beside the note.
    for (const mount of [{ ...BAND_AT(120), surface }, { ...PANE, surface }]) {
      const ui = await $.ui.mount(mount)
      const card = surface === 'desktop' && mount.component === 'AbovePrompt'
      expect(await ui.find({ type: 'Text', text: card ? /^Deploying to staging\.$/ : /Deploying to staging\. · Bash/ })).toBeDefined()
      if (card) expect(await ui.find({ type: 'Text', text: /^Bash$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /deploy\.sh/ })).toBeUndefined()
      await ui.unmount()
    }
    // A narrow terminal keeps the note and drops the tool.
    if (surface === 'terminal') {
      const narrow = await $.ui.mount({ ...BAND_AT(80), surface })
      expect(await narrow.find({ type: 'Text', text: /^Deploying to staging\.$/ })).toBeDefined()
      expect(await narrow.find({ type: 'Text', text: /Bash/ })).toBeUndefined()
      await narrow.unmount()
    }
    const band = await $.ui.mount({ ...BAND_AT(120), surface })
    if (surface === 'terminal') expect(await band.find({ type: 'Text', text: /^ · Bash$/ })).toBeDefined() // the tool is its own, dimmed, piece
    expect(await band.find({ type: 'Text', text: /^Grep TODO$/ })).toBeDefined()
    await band.unmount()
  }
})

test('a note is its first line with the markdown off; a request that writes none keeps the last; the turn’s end clears it', async ($: any, on) => {
  const { writes } = bench(on)
  mock.clock(on)
  await step($, 'claude-opus-5-5')
  await spawn($, 'deploy', 'haiku')
  writes('> - ## **Reading** the `orders` _file_ now\n\nA long second paragraph that is not shown.')
  await step($, 'claude-haiku-5-5', { agentId: 'a-deploy', effort: 'low' })
  await $.tool.call({ tool: 'Read', file_path: '/src/orders.ts', agentId: 'a-deploy' })
  await step($, 'claude-haiku-5-5', { agentId: 'a-deploy', effort: 'low' }) // writes no text
  await $.tool.call({ tool: 'Edit', file_path: '/src/orders.ts', agentId: 'a-deploy' })
  const band = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /^Reading the orders file now · Edit$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /second paragraph/ })).toBeUndefined()
  await band.unmount()
  await complete($, 'a-deploy')
  const after = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /Reading/ })).toBeUndefined() // a finished agent shows how it ended, not its note
  expect(await after.find({ type: 'Text', text: /^└─✓ deploy$/ })).toBeDefined()
  await after.unmount()
  // The panel keeps what it said, as one note: the later request wrote none.
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const text = await show(pane, 100)
  expect(text).toMatch(/└─✓ deploy +haiku·low/)
  await pane.unmount()
})

// The loops record as the plugin last wrote it: a test calls this before its first call on `$`, and reads the loops with the function it
// returns (the kit's own bottom still keeps the value for the plugin).
const watchLoops = (on: any): (() => Record<string, any>) => {
  let loops: Record<string, any> = {}
  on('state.set', (_: unknown, e: any, next: any) => {
    if (e.plugin === 'gearbox' && e.key === 'loops') loops = e.value.value
    return next(e)
  })
  return () => loops
}

test('a loop keeps the last three things it said, each followed by the tool it called; a line a request is still writing is one note; a new prompt clears main’s', async ($: any, on) => {
  const loopsOf = watchLoops(on)
  const { writes } = bench(on)
  mock.clock(on)
  await step($, 'claude-opus-5-5')
  await spawn($, 'deploy', 'haiku')
  const say = async (text: string, call: object) => {
    writes(text)
    await step($, 'claude-haiku-5-5', { agentId: 'a-deploy', effort: 'low' })
    await $.tool.call({ ...call, agentId: 'a-deploy' })
  }
  const notes = () => loopsOf()['a-deploy'].notes.map((n: any) => [n.text, n.tool])
  // The text arrives in pieces of seven characters, and is one note.
  await say('Reading the config.', { tool: 'Read', file_path: '/w/a.ts' })
  expect(notes()).toEqual([['Reading the config.', 'Read']])
  // A request that says nothing and calls a tool: the note is followed by that one.
  await step($, 'claude-haiku-5-5', { agentId: 'a-deploy', effort: 'low' })
  await $.tool.call({ tool: 'Grep', pattern: 'TODO', agentId: 'a-deploy' })
  expect(notes()).toEqual([['Reading the config.', 'Grep']])
  await say('Editing it.', { tool: 'Edit', file_path: '/w/a.ts' })
  await say('Editing it.', { tool: 'Edit', file_path: '/w/b.ts' }) // the same line again is not a new note
  await say('Running the tests.', { tool: 'Bash', command: 'bun test' })
  await say('Reporting.', { tool: 'Read', file_path: '/w/c.ts' })
  expect(notes()).toEqual([['Editing it.', 'Edit'], ['Running the tests.', 'Bash'], ['Reporting.', 'Read']])
  const at = loopsOf()['a-deploy'].notes.map((n: any) => n.at)
  expect(at[0] <= at[1] && at[1] <= at[2] && at[0] > 0).toBe(true)
  // Main's notes are this turn's.
  writes('Waiting for the deploy.')
  await step($, 'claude-opus-5-5')
  expect(loopsOf().main.notes.map((n: any) => n.text)).toEqual(['Waiting for the deploy.'])
  await $.prompt.submit({ text: '/review', command: { name: 'review', args: '' } } as any)
  expect(loopsOf().main.notes).toEqual([])
  expect(loopsOf()['a-deploy'].notes).toHaveLength(3) // an agent keeps its own
})

test('the main conversation shows its own note and tool on its row, and the turn’s end clears it', async ($: any, on) => {
  const { writes } = bench(on)
  writes('Checking the totals against the ledger.')
  await step($, 'claude-opus-5-5')
  await $.tool.call({ tool: 'Bash', command: 'bun test' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND_AT(120), surface })
    expect(await ui.find({ type: 'Text', text: surface === 'terminal' ? /^Checking the totals against the ledger\. · Bash$/ : /^Checking the totals against the ledger\.$/ })).toBeDefined()
    if (surface === 'desktop') expect(await ui.find({ type: 'Text', text: /^Bash$/ })).toBeDefined() // a chip
    await ui.unmount()
  }
  const narrow = await $.ui.mount({ ...BAND_AT(80), surface: 'terminal' })
  expect(await narrow.find({ type: 'Text', text: /^Checking the totals against the ledger\.$/ })).toBeDefined()
  await narrow.unmount()
  await complete($)
  const idle = await $.ui.mount({ ...BAND_AT(120), surface: 'desktop' })
  expect(await idle.find({ type: 'Text', text: /Checking the totals/ })).toBeUndefined()
  expect(await idle.find({ type: 'Text', text: /^waiting for a prompt$/ })).toBeDefined()
  await idle.unmount()
})

test('the desktop band draws a card per agent: a rail in its model’s colour, chips for its gear, who chose the effort and its worktree, the note with a tool chip, the note before it; its own agents inside, a finished one dimmed', CREW, async ($: any, on) => {
  const { run } = await crew($, on)
  await run('t1', 'Creating the worktree for the part', { tool: 'Bash', command: 'git -C /w/app worktree add /tmp/gb-wt-customers -b part/customers' })
  await run('t1', 'Grouping orders by customer and adding the totals', { tool: 'Write', file_path: '/w/app/src/customers.ts' })
  const ui = await $.ui.mount({ ...BAND_AT(120), surface: 'desktop' })
  const card = async (id: string) => JSON.stringify(await ui.find({ key: `card-${id}` }))
  // Main first, then a card for each part; the Explore is inside part 2's card, the review beside it.
  const [main, one, two, review] = [await card('main'), await card('a-t1'), await card('a-t2'), await card('a-t3')]
  expect(two).toContain('card-a-e1')
  for (const other of [main, one, review]) expect(other).not.toContain('card-a-e1')
  expect(one).not.toContain('card-a-t2')
  // Rails: Opus's amber for main and the review, Sonnet's blue for the parts and the Explore.
  expect(main).toContain('"backgroundColor":"#D99A2B"')
  expect(one).toContain('"backgroundColor":"#5B8DEF"')
  expect(review).toContain('"backgroundColor":"#D99A2B"')
  // Chips: gear, who chose the effort, the worktree.
  for (const chip of [/^sonnet·medium$/, /^chosen by main$/, /^⎇ part\/customers$/, /^by rules$/, /^auto$/]) expect(await ui.find({ type: 'Text', text: chip })).toBeDefined()
  // Main's card: its role, the note and the tool chip; the card of a part: the note, the tool chip, the note before.
  expect(main).toContain('main session')
  expect(await ui.find({ type: 'Text', text: /^Waiting for the 2 parts; part 1 already has green tests$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Agent$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Grouping orders by customer and adding the totals$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Write$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^before: Creating the worktree for the part$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^started by part 2$/ })).toBeDefined()
  // The finished review: its result under it, and no note.
  expect(review).toContain('done — 6 findings (1 medium: a fractional discount loses 1 cent)')
  expect(review).not.toContain('before:')
  expect(JSON.stringify(await ui.find({ type: 'Text', text: /^done — 6 findings/ }))).toContain('"dimColor":true')
  await ui.unmount()
})

test('an agent’s worktree is the one Claude Code reports, or its isolation; the agent’s result carries the branch and the path', async ($: any, on) => {
  // Claude Code reports where an agent that ran in a worktree of its own worked, once it has ended.
  on('tool.call', { tool: 'Agent' }, () => ({ result: { agentId: 'a-isolated', worktreePath: '/w/app/.claude/worktrees/agent-1', worktreeBranch: 'worktree-agent-1' } }) as never)
  bench(on)
  mock.clock(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: JSON.stringify({ reach: 'point', depth: 0, mode: 'answer' }), usage: USAGE } }) as never)
  await step($, 'claude-opus-5-5')
  await spawn($, 'isolated', 'sonnet')
  const pane = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const text = await show(ui, 120)
    await ui.unmount()
    return text
  }
  expect(await pane()).not.toContain('⎇')
  await $.tool.call({ tool: 'Agent', tool_use_id: 'isolated', description: 'isolated', prompt: 'p', isolation: 'worktree' })
  expect(await pane()).toMatch(/⎇ worktree-agent-1 {2}\/w\/app\/\.claude\/worktrees\/agent-1/)
})

test('a response stopped early (Esc) reaches the stream beneath, which settles', async ($: any, on) => {
  const { writes, settled } = bench(on)
  writes('Reading the orders, then the totals.') // five pieces
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 })
  await stream.next()
  await stream.next()
  expect(settled()).toBe(0)
  await stream.return(undefined)
  expect(settled()).toBe(1)
})


// ---- the skills an agent loaded ----

// The skills a tool call by `agentId` loads, in order.
const load = async ($: any, agentId: string | undefined, ...names: string[]) => {
  for (const skill of names) await $.tool.call({ tool: 'Skill', skill, ...(agentId ? { agentId } : {}) })
}
// The names of the author's own subagents' skills, twelve of them: more than a line or two of tags hold.
const MANY = ['swanson-db-rls-migrations', 'tdd', 'durable-progress', 'diagnosing-bugs', 'swanson-e2e', 'swanson-frontend', 'swanson-core-architecture', 'swanson-verify', 'swanson-recreation-intelligence', 'swanson-shared-packages', 'swanson-checkout-holds', 'swanson-deploy']

test('an agent’s Skill calls are kept by name, once each, in load order; a call reads "Skill: name"; the main conversation’s own are not shown', async ($: any, on) => {
  bench(on)
  mock.clock(on)
  await step($, 'claude-opus-5-5')
  await spawn($, 'review', 'sonnet')
  await step($, 'claude-sonnet-5-5', { agentId: 'a-review', effort: 'medium' })
  // No skill yet: the agent's row is as it was, with no line for skills.
  const before = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  expectLines(await lines(before, 120), [/^GearBox /, /^─+$/, /^● main /, /^ {2}thinking$/, /^└─● review +sonnet·medium +1 req +Ns +\[ ■ \]$/, /^ {4}thinking$/])
  await before.unmount()
  await load($, 'a-review', 'tdd', 'swanson-e2e', 'tdd', '/diagnosing-bugs')
  await load($, undefined, 'main-only')
  const term = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  expectLines(await lines(term, 120), [
    /^GearBox +opus·high · 1 agent · /,
    /^─+$/,
    /^● main /,
    /^ {2}Skill: main-only$/, // the main conversation's call reads the same, but no tag is drawn for it
    /^└─● review +sonnet·medium +1 req +Ns +\[ ■ \]$/,
    /^ {5}✦ tdd {3}✦ swanson-e2e {3}✦ diagnosing-bugs$/, // between the identity and the note; a skill once, in load order
    /^ {4}Skill: diagnosing-bugs$/,
  ])
  await term.unmount()
  const pane = await $.ui.mount({ ...PANE_AT(110), surface: 'terminal' })
  const text = await show(pane, 110)
  expect(text).toMatch(/^ {4}skills: tdd · swanson-e2e · diagnosing-bugs$/m)
  expect(text).not.toMatch(/skills:.*main-only/)
  expect(text.match(/skills:/g)).toHaveLength(1) // main has none
  await pane.unmount()
})

test('the terminal band draws an agent’s skills as tags, in lines of their own between its identity and its note, with the note’s indent', CREW, async ($: any, on) => {
  await crew($, on)
  await load($, 'a-t1', 'tdd', 'swanson-e2e')
  const ui = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  expectLines(await lines(ui, 120), [
    /^GearBox /,
    /^─+$/,
    /^● main /,
    /^ {2}Waiting for the 2 parts/,
    /^├─● part 1 · customers +sonnet·medium +main +2 req +Ns +\[ ■ \]$/,
    /^│ {4}✦ tdd {3}✦ swanson-e2e$/,
    /^│ {3}Grouping orders by customer and adding the totals · Skill$/,
    /^├─● part 2 · README /,
    /^│ {3}Running the examples to paste real output into the README · Bash$/, // no skill: no line
    /^│ └─● Explore · uses of paginate /,
    /^│ {5}Looking for calls to paginate in src\/ · Grep$/,
    /^└─✓ part 3 · review money\.ts /,
  ])
  // Each tag is a Text of its own, inverse and dimmed (readable in every theme), padded by a space each side; a plain
  // space stands between tags, and the line is the note's: one Text, truncated.
  const line = JSON.parse(JSON.stringify(await ui.find({ type: 'Text', text: /^ ✦ tdd {3}✦ swanson-e2e $/ })))
  expect(line.props).toEqual({ wrap: 'truncate' })
  expect(line.children).toEqual([
    { type: 'Text', props: { inverse: true, dimColor: true }, children: [' ✦ tdd '] },
    ' ',
    { type: 'Text', props: { inverse: true, dimColor: true }, children: [' ✦ swanson-e2e '] },
  ])
  await ui.unmount()
})

// The tag lines that follow the row matching `after` in a drawn band, up to the first line with no tag.
const tagLines = (rows: string[], after: RegExp) => {
  const at = rows.findIndex(l => after.test(l))
  const out: string[] = []
  for (const l of rows.slice(at + 1)) {
    if (!l.includes('✦')) break
    out.push(l)
  }
  return out
}
// The names on a tag line, past the tree's guides: tags stand three spaces apart (a padding, the plain space, a padding).
const namesOn = (line: string) => line.replace(/^[│ ]+/, '').trim().split(/ {3}/).map(t => t.replace(/^✦ /, ''))
// Every skill is there, once, whole and in load order; no … ends a list; no line is wider than `columns`; and a line
// breaks only where the next tag would not have fit (the line as drawn ends one padding short: its trailing space is trimmed).
const expectWrapped = (tags: string[], names: string[], columns: number) => {
  expect(tags.flatMap(namesOn)).toEqual(names)
  for (const l of tags) {
    expect(l).not.toContain('…')
    expect(l.length).toBeLessThanOrEqual(columns)
  }
  tags.slice(1).forEach((l, i) => expect(tags[i]!.length + 1 + 1 + (namesOn(l)[0]!.length + 4)).toBeGreaterThan(columns))
}

test('a long list of skills wraps between tags onto as many lines as it needs, none dropped and no …; no line is wider than the terminal, at 120 columns and at 80', CREW, async ($: any, on) => {
  await crew($, on)
  await load($, 'a-t1', 'tdd', 'swanson-e2e')
  await load($, 'a-t2', ...MANY)
  const wide = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  const rows = await lines(wide, 120)
  expectLines(rows, [
    /^GearBox /,
    /^─+$/,
    /^● main /,
    /^ {2}Waiting for the 2 parts/,
    /^├─● part 1 · customers /,
    /^│ {4}✦ tdd {3}✦ swanson-e2e$/,
    /^│ {3}Grouping orders by customer and adding the totals · Skill$/,
    /^└─● part 2 · README /,
    /^ {5}✦ swanson-db-rls-migrations {3}✦ tdd {3}✦ durable-progress {3}✦ diagnosing-bugs {3}✦ swanson-e2e {3}✦ swanson-frontend$/,
    /^ {5}✦ swanson-core-architecture {3}✦ swanson-verify {3}✦ swanson-recreation-intelligence {3}✦ swanson-shared-packages$/,
    /^ {5}✦ swanson-checkout-holds {3}✦ swanson-deploy$/,
    /^ {4}Running the examples to paste real output into the README · Skill$/,
    /^ {2}└─● Explore · uses of paginate /,
    /^ {6}Looking for calls to paginate in src\/ · Grep$/,
    /^\+1 agent · Panel$/,
  ])
  expectWrapped(tagLines(rows, /part 2 · README/), MANY, 120)
  for (const l of rows) expect(l.length).toBeLessThanOrEqual(120)
  await wide.unmount()
  // Under 100 columns the narrow band keeps every tag too, on lines as wide as its room.
  const narrow = await $.ui.mount({ ...BAND_AT(80), surface: 'terminal' })
  const small = await lines(narrow, 80)
  expectLines(small, [
    /^GearBox /,
    /^─+$/,
    /^● main /,
    /^ {2}Waiting for the 2 parts/,
    /^├─● part 1 {2}/,
    /^│ {4}✦ tdd {3}✦ swanson-e2e$/,
    /^│ {3}Grouping orders by customer and adding the totals$/,
    /^└─● part 2 {2}/,
    /^ {5}✦ swanson-db-rls-migrations {3}✦ tdd {3}✦ durable-progress$/,
    /^ {5}✦ diagnosing-bugs {3}✦ swanson-e2e {3}✦ swanson-frontend$/,
    /^ {5}✦ swanson-core-architecture {3}✦ swanson-verify$/,
    /^ {5}✦ swanson-recreation-intelligence {3}✦ swanson-shared-packages$/,
    /^ {5}✦ swanson-checkout-holds {3}✦ swanson-deploy$/,
    /^ {4}Running the examples to paste real output into the README$/,
    /^ {2}└─● Explore {3}/, // an agent's own agent is one line in the narrow band
    /^\+1 agent · Panel$/,
  ])
  expectWrapped(tagLines(small, /part 2 {2}/), MANY, 80)
  for (const l of small) expect(l.length).toBeLessThanOrEqual(80)
  await narrow.unmount()
})

test('an agent with no skills gets no extra line: the band is as it was', CREW, async ($: any, on) => {
  await crew($, on)
  const ui = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /✦/ })).toBeUndefined()
  expect((await lines(ui, 120)).filter(l => l.includes('✦'))).toHaveLength(0)
  expect(await lines(ui, 120)).toHaveLength(11) // the header, the rule, main's two lines, and each agent's two
  await ui.unmount()
})

test('an agent’s skill lines count against the band’s rows: the finished agents give way first, live ones are always drawn', CREW, async ($: any, on) => {
  await crew($, on)
  const shown = async () => {
    const ui = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
    const rows = await lines(ui, 120)
    await ui.unmount()
    return rows
  }
  // Main's two lines are not counted. 2 + 2 + 2 for the live agents and 1 for the review: 7 of the 8 rows.
  expect(await shown()).toHaveLength(11)
  expect((await shown()).some(l => /review money\.ts/.test(l))).toBe(true)
  // One line of skills (3 + 2 + 2) leaves the review its one row; the twelve skills, in three lines (5 + 2 + 2), leave it none.
  await load($, 'a-t1', 'tdd')
  expect(await shown()).toHaveLength(12)
  expect((await shown()).some(l => /review money\.ts/.test(l))).toBe(true)
  await load($, 'a-t1', ...MANY)
  const full = await shown()
  expect(tagLines(full, /part 1 · customers/)).toHaveLength(3)
  expect(tagLines(full, /part 1 · customers/).flatMap(namesOn)).toEqual(['tdd', ...MANY.filter(n => n !== 'tdd')]) // tdd was loaded first, once
  expect(full.some(l => /review money\.ts/.test(l))).toBe(false)
  expect(full.at(-1)).toBe('+1 agent · Panel')
  // The live agents stay, past the budget.
  for (const name of ['part 1 · customers', 'part 2 · README', 'Explore · uses of paginate']) expect(full.some(l => l.includes(name))).toBe(true)
  await load($, 'a-t2', ...MANY)
  await load($, 'a-e1', ...MANY)
  const over = await shown()
  for (const name of ['part 1 · customers', 'part 2 · README', 'Explore · uses of paginate']) expect(over.some(l => l.includes(name))).toBe(true)
  expect(over.at(-1)).toBe('+1 agent · Panel')
})

test('a finished agent keeps its skills under its line, and they take rows of the budget', async ($: any, on) => {
  bench(on)
  mock.clock(on)
  await $.prompt.submit({ text: 'review it' })
  await step($, 'claude-opus-5-5')
  await spawn($, 'review money.ts', 'opus')
  await step($, 'claude-opus-5-5', { agentId: 'a-review money.ts', effort: 'medium' })
  await load($, 'a-review money.ts', 'security-review', 'code-review')
  await $.turn.complete({ turnId: 't', answer: '## 6 findings', durationMs: 10, isAborted: false, agentId: 'a-review money.ts' })
  const ui = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  expectLines(await lines(ui, 120), [
    /^GearBox /,
    /^─+$/,
    /^● main /,
    /^ {2}thinking$/,
    /^└─✓ review money\.ts +opus·medium +done · 6 findings +1 req +Ns$/,
    /^ {5}✦ security-review {3}✦ code-review$/,
  ])
  await ui.unmount()
  const narrow = await $.ui.mount({ ...BAND_AT(80), surface: 'terminal' })
  expectLines(await lines(narrow, 80), [
    /^GearBox /,
    /^─+$/,
    /^● main /,
    /^ {2}thinking$/,
    /^└─✓ review money\.ts · 6 findings/,
    /^ {5}✦ security-review {3}✦ code-review$/,
  ])
  await narrow.unmount()
})

test('the desktop card shows a chip for each skill, in a row between the identity chips and the note, like the worktree chip; none for an agent with no skills', CREW, async ($: any, on) => {
  const { run } = await crew($, on)
  await run('t1', 'Creating the worktree for the part', { tool: 'Bash', command: 'git -C /w/app worktree add /tmp/gb-wt-customers -b part/customers' })
  await load($, 'a-t1', 'tdd', 'swanson-e2e', 'tdd')
  await load($, 'a-t2', ...MANY) // all of them, wrapping: the desktop does not cut the list
  const ui = await $.ui.mount({ ...BAND_AT(120), surface: 'desktop' })
  const card = async (id: string) => JSON.parse(JSON.stringify(await ui.find({ key: `card-${id}` })))
  const one = await card('a-t1')
  const column = one.children[1]
  expect(column.children).toHaveLength(4) // identity chips, skills, the note, the note before
  const [identity, skills, note] = column.children
  // The identity chips row holds the worktree chip; the skills row follows it, then the note row.
  expect(JSON.stringify(identity)).toContain('⎇ part/customers')
  expect(JSON.stringify(skills)).not.toContain('⎇')
  expect(JSON.stringify(note)).toContain('Creating the worktree for the part')
  // One chip per skill, each once, in load order, in the worktree chip's style: a rounded Box with a dim caption.
  expect(skills.props).toEqual({ flexDirection: 'row', columnGap: 'sm', alignItems: 'center', flexWrap: 'wrap' })
  const chip = (name: string) => ({ type: 'Box', props: { key: `skill-${name}`, borderStyle: 'round', paddingX: 'xs', borderDimColor: true }, children: [{ type: 'Text', props: { size: 'caption', dimColor: true }, children: [`✦ ${name}`] }] })
  expect(skills.children).toEqual([chip('tdd'), chip('swanson-e2e')])
  const worktree = identity.children.find((c: any) => JSON.stringify(c).includes('⎇'))
  expect(worktree).toEqual({ type: 'Box', props: { borderStyle: 'round', paddingX: 'xs', borderDimColor: true }, children: [{ type: 'Text', props: { size: 'caption', dimColor: true }, children: ['⎇ part/customers'] }] })
  // Every skill an agent loaded, without the terminal's cut.
  const two = await card('a-t2')
  expect(two.children[1].children[1].children.map((c: any) => c.children[0].children[0])).toEqual(MANY.map(n => `✦ ${n}`))
  // An agent with no skills, and main: the card is as it was.
  for (const id of ['main', 'a-t3']) expect(JSON.stringify(await card(id))).not.toContain('✦')
  expect((await card('a-t3')).children[1].children).toHaveLength(2)
  await ui.unmount()
})

test('the panel lists every skill an agent loaded, in a skills: line after its files; a finished agent’s block ends with it', CREW, async ($: any, on) => {
  const { run } = await crew($, on)
  await run('t1', 'Testing the grouping', { tool: 'Edit', file_path: '/w/app/src/customers.ts' })
  await load($, 'a-t1', 'tdd', 'swanson-e2e')
  await load($, 'a-t2', ...MANY)
  await load($, 'a-t3', 'code-review') // the review has ended
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE_AT(110), surface })
    const all = (await lines(ui, 110)).filter(l => !/^\s*$/.test(l))
    const at = all.findIndex(l => /^│ {3}files: /.test(l))
    expect(all[at + 1]).toBe('│   skills: tdd · swanson-e2e')
    const two = all.find(l => /skills: swanson-db/.test(l))
    expect(two).toBe(`│   skills: ${MANY.join(' · ')}`) // the whole list, which the band cuts
    // The finished review: its end line, then its skills.
    const end = all.findIndex(l => /done hh:mm:ss — 6 findings/.test(l))
    expect(all[end + 1]).toBe('    skills: code-review')
    await ui.unmount()
  }
  // The main conversation and the agents with no skill have no such line.
  const ui = await $.ui.mount({ ...PANE_AT(110), surface: 'terminal' })
  expect((await show(ui, 110)).match(/skills:/g)).toHaveLength(3)
  await ui.unmount()
})

// ---- Stop: a button on every agent at work ----

// The engine's TaskStop, faked beneath the mod: `tools` is what $.tool.list() answers, `sent` each TaskStop call, and
// `answer` what the call does (by default the tool's own answer).
const taskStop = (on: any, o: { tools?: string[]; answer?: (e: any) => unknown } = {}) => {
  const sent: any[] = []
  on('tool.list', () => ({ value: (o.tools ?? ['Read', 'Bash', 'TaskStop']).map(name => ({ name, description: '', mcp: false })) }))
  on('tool.call', { tool: 'TaskStop' }, (_: unknown, e: any) => (sent.push(e), o.answer ? o.answer(e) : { result: { message: 'stopped', task_id: e.task_id, task_type: 'local_agent' }, text: 'stopped' }))
  return sent
}

// The result of a request, whose stream is read to its end.
const stepResult = async ($: any, model: string, extra: object = {}) => {
  const stream = $.turn.step({ turnId: 't', index: 0, model, effort: 'high', messageCount: 3, ...extra })
  let next = await stream.next()
  while (!next.done) next = await stream.next()
  return next.value
}

// The live agents of the crew: part 1, part 2 and the Explore it started.
const LIVE = ['a-t1', 'a-t2', 'a-e1']
const stopKeys = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Button' })).map((b: any) => b.key as string).filter((k: string) => k.startsWith('stop-'))

test('Stop is on every agent at work and on nothing else (main, a finished agent, a queued part), in the wide band, the narrow band, the panel and the desktop card', CREW, async ($: any, on) => {
  taskStop(on)
  await crew($, on, { owed: true })
  const keys = LIVE.map(id => `stop-${id}`)
  // The wide band: [ ■ ] at the end of the identity line, after the stats; the narrow band's too.
  const wide = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  expect(await stopKeys(wide)).toEqual(keys)
  const rows = await lines(wide, 120)
  expect(rows.filter(l => l.endsWith(' [ ■ ]'))).toHaveLength(3)
  expect(rows.some(l => /^└─◌ part 4 · billing/.test(l))).toBe(true) // queued: drawn, but nothing to stop
  expect(rows.find(l => /^└─✓ part 3/.test(l))).not.toContain('■')
  expect(rows.find(l => /^● main /.test(l))).not.toContain('■')
  expect(await wide.find({ type: 'Button', text: '■' })).toBeDefined()
  await wide.unmount()
  const narrow = await $.ui.mount({ ...BAND_AT(80), surface: 'terminal' })
  expect(await stopKeys(narrow)).toEqual(keys)
  expect((await lines(narrow, 80)).filter(l => l.endsWith(' Ns [ ■ ]'))).toHaveLength(3)
  await narrow.unmount()
  // The panel: at the end of each live agent's identity line.
  const pane = await $.ui.mount({ ...PANE_AT(100), surface: 'terminal' })
  expect(await stopKeys(pane)).toEqual(keys)
  const block = (await lines(pane, 100)).filter(l => /^[│├└─ ]*[●◐✓✗◌] /.test(l))
  expect(block.filter(l => l.endsWith(' [ ■ ]')).map(l => l.replace(/^[│├└─ ]*/, '').split(' ')[1])).toEqual(['part', 'part', 'Explore'])
  expect(block.find(l => /^└─✓ part 3/.test(l))).not.toContain('■')
  await pane.unmount()
  // The desktop: a button in the card's header row after "N req · Ns", the icon alone, named for the agent.
  const desk = await $.ui.mount({ ...BAND_AT(120), surface: 'desktop' })
  expect(await stopKeys(desk)).toEqual(keys)
  const button = (await desk.find({ key: 'stop-a-t1' }))!
  expect(button.props.label).toBe('Stop part 1 · customers')
  expect(button.text).toBe('■')
  const header = (await desk.find({ key: 'card-a-t1' }))!.children[1].children[0]
  expect(header.children.at(-1).props.key).toBe('stop-a-t1')
  expect(header.children.at(-2).children[0]).toMatch(/^2 req · \d+s$/)
  for (const id of ['main', 'a-t3', 'queued:0']) expect(await desk.find({ key: `stop-${id}` })).toBeUndefined()
  await desk.unmount()
  const dpane = await $.ui.mount({ ...PANE_AT(100), surface: 'desktop' })
  expect(await stopKeys(dpane)).toEqual(keys)
  await dpane.unmount()
})

test('a press on Stop calls TaskStop on that agent, with the press as consent; the row says stopping… (… in the narrow band) until the engine reports it ended, then ✗ stopped', CREW, async ($: any, on) => {
  const sent = taskStop(on)
  const agents = listing(on)
  const c = await crew($, on)
  for (const id of LIVE) agents[id] = 'running'
  const wide = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  const narrow = await $.ui.mount({ ...BAND_AT(80), requestId: 'band-narrow', surface: 'terminal' })
  const desk = await $.ui.mount({ ...BAND_AT(120), surface: 'desktop' })
  const pane = await $.ui.mount({ ...PANE_AT(100), surface: 'terminal' })
  await wide.press({ key: 'stop-a-t1' })
  // The engine's own tool, on the agent's id, as the person's own press.
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ tool: 'TaskStop', task_id: 'a-t1' })
  expect(sent[0].consent).toBe('The user pressed Stop in the gearbox readout to stop part 1 · customers (a-t1).')
  expect(c.calls.filter((e: any) => e.tool === 'TaskStop')).toHaveLength(0) // answered by the TaskStop hook, no other
  // Every surface shows it stopping in the place of the button; the other agents keep theirs.
  expect((await lines(wide, 120))[4]).toMatch(/^├─● part 1 · customers +sonnet·medium +main +2 req +Ns +stopping…$/)
  expect((await lines(narrow, 80))[4]).toMatch(/^├─● part 1 +sonnet·medium +Ns +…$/)
  expect(await desk.find({ type: 'Text', text: 'stopping…' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'stopping…' })).toBeDefined()
  for (const ui of [wide, narrow, desk, pane]) {
    expect(await ui.find({ key: 'stop-a-t1' })).toBeUndefined()
    expect(await stopKeys(ui)).toEqual(['stop-a-t2', 'stop-a-e1'])
  }
  // gearbox's own call is no work of the main conversation: its row says nothing of TaskStop.
  expect(await show(wide, 120)).not.toContain('TaskStop')
  // Pressed once: the engine says it ended (killed) at the next look, and the row is the existing ✗ … stopped.
  agents['a-t1'] = 'killed'
  await c.clock.advance(3000)
  expect((await lines(wide, 120))[4]).toMatch(/^├─✗ part 1 · customers +sonnet·medium +main +stopped +2 req +Ns$/)
  expect((await lines(narrow, 80))[4]).toMatch(/^├─✗ part 1 · customers · stopped$/)
  expect(await show(pane, 100)).toMatch(/^├─✗ part 1 · customers +sonnet·medium +chosen… +2 req · Ns · 62\.0k in \/ 4\.2k out · \$0\.17$/m)
  expect(await show(pane, 100)).toMatch(/^│ +stopped hh:mm:ss$/m)
  expect(await stopKeys(wide)).toEqual(['stop-a-t2', 'stop-a-e1'])
  for (const ui of [wide, narrow, desk, pane]) await ui.unmount()
})

// A file system, home and session beneath the mod, for the debug log (one file, the session's).
const LOG_FILE = '/home/tester/.claude/gearbox/logs/s-1.jsonl'
const fakeDisk = (on: any) => {
  const files = new Map<string, string>()
  on('fs.exists', (_: unknown, e: any) => ({ value: files.has(e.path) }))
  on('fs.write', (_: unknown, e: any) => (files.set(e.path, e.text), { value: undefined }))
  on('fs.read', (_: unknown, e: any) => ({ value: e.path.endsWith('plugin.json') ? '{"version":"9.9.9"}' : files.get(e.path) ?? '' }))
  on('env.get', (_: unknown, e: any) => ({ value: e.name === 'HOME' ? '/home/tester' : undefined }))
  on('session.id', () => ({ value: 's-1' }))
  on('session.version', () => ({ value: { version: '2.1.311', base: '2.1.311' } }))
  return files
}
const events = (files: Map<string, string>) => (files.get(LOG_FILE) ?? '').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
const CREW_LOGGED = { options: { ...CREW.options, log: 'on' } }

// The ways TaskStop can be out of a mod's reach, each a session of its own.
const OUT_OF_REACH: [string, { tools?: string[]; answer?: (e: any) => unknown }, RegExp][] = [
  ['it is not among the tools', { tools: ['Read', 'Bash'] }, /TaskStop is not among the tools/],
  ['the call is refused', { answer: () => ({ deny: 'TaskStop is not allowed here' }) }, /TaskStop refused: TaskStop is not allowed here/],
  ['the call reports an error', { answer: () => ({ result: 'No task found with ID', text: 'No task found with ID: a-t1', isError: true }) }, /TaskStop failed: No task found with ID: a-t1/],
  [
    'the call throws',
    {
      answer: () => {
        throw new Error('no such task')
      },
    },
    /TaskStop failed/,
  ],
]

for (const [how, door, why] of OUT_OF_REACH) {
  test(`where ${how}, gearbox stops the agent itself: its tool calls are refused, its next request ends the turn without being sent, and the row ends ✗ stopped`, CREW_LOGGED, async ($: any, on) => {
    taskStop(on, door)
    const log = fakeDisk(on)
    const c = await crew($, on)
    const ui = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
    await ui.press({ key: 'stop-a-t1' })
    // Marked stopping at once, whichever way it goes.
    expect((await lines(ui, 120))[4]).toMatch(/^├─● part 1 · customers .* stopping…$/)
    // Its tool calls are refused with the reason; the other agents' and main's go on.
    const refused = await $.tool.call({ tool: 'Read', file_path: '/w/app/src/orders.ts', agentId: 'a-t1' })
    expect(JSON.stringify(refused)).toContain('the person stopped this agent')
    for (const agentId of ['a-t2', undefined]) expect(JSON.stringify(await $.tool.call({ tool: 'Read', file_path: '/w/app/src/orders.ts', ...(agentId ? { agentId } : {}) }))).not.toContain('the person stopped')
    // Its next request is not sent: the turn ends on the made-up answer, which tells the agent that started it.
    const before = c.settled()
    const end = await stepResult($, 'claude-sonnet-5-5', { agentId: 'a-t1', effort: 'medium' })
    expect(c.settled()).toBe(before)
    expect(end).toMatchObject({ turnId: 't', index: 0, toolUses: [], stopReason: 'end_turn', usage: null })
    expect(end.answer).toMatch(/^The person stopped this agent from gearbox before it finished, so its work is incomplete\./)
    // Another agent's request is sent as ever.
    c.writes('still going')
    expect((await stepResult($, 'claude-sonnet-5-5', { agentId: 'a-t2', effort: 'medium' })).answer).toBe('')
    expect(c.settled()).toBe(before + 1)
    // The loop finishes on it: stopped, with no report of its own (the made-up answer is not one).
    await complete($, 'a-t1', end.answer)
    expect((await lines(ui, 120))[4]).toMatch(/^├─✗ part 1 · customers +sonnet·medium +main +stopped +2 req +Ns$/)
    expect(await show(ui, 120)).not.toContain('incomplete')
    // The log says how, and why TaskStop was not used.
    const stops = events(log).filter(e => e.ev === 'stop')
    expect(stops).toEqual([expect.objectContaining({ agent: 'a-t1', via: 'soft', cascade: [] })])
    expect(stops[0].why).toMatch(why)
    await ui.unmount()
  })
}

test('stopping an agent stops every agent it started too, the agent first; the agents beside it go on', CREW_LOGGED, async ($: any, on) => {
  const sent = taskStop(on)
  const log = fakeDisk(on)
  const agents = listing(on)
  const c = await crew($, on)
  for (const id of LIVE) agents[id] = 'running'
  const ui = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  await ui.press({ key: 'stop-a-t2' })
  expect(sent.map((e: any) => e.task_id)).toEqual(['a-t2', 'a-e1'])
  expect(sent[0].consent).toBe('The user pressed Stop in the gearbox readout to stop part 2 · README (a-t2) and the agents it started.')
  expect(sent[1].consent).toBe('The user pressed Stop in the gearbox readout to stop Explore · uses of paginate (a-e1), which part 2 · README (a-t2) started.')
  // Both say stopping; part 1 keeps its button.
  const rows = await lines(ui, 120)
  expect(rows[4]).toMatch(/\[ ■ \]$/)
  expect(rows[6]).toMatch(/^├─● part 2 · README .* stopping…$/)
  expect(rows[8]).toMatch(/^│ └─● Explore · uses of paginate .* stopping…$/)
  expect(await stopKeys(ui)).toEqual(['stop-a-t1'])
  // The log has one stop per agent: the first with the agents that stopped along with it, those with whose stop they came.
  expect(events(log).filter(e => e.ev === 'stop')).toEqual([
    expect.objectContaining({ agent: 'a-t2', via: 'task', cascade: ['a-e1'] }),
    expect.objectContaining({ agent: 'a-e1', via: 'task', cascade: [], by: 'a-t2' }),
  ])
  // The engine ends both; the next look shows ✗ stopped on both.
  agents['a-t2'] = 'killed'
  agents['a-e1'] = 'killed'
  await c.clock.advance(3000)
  expect((await lines(ui, 120)).filter(l => /✗/.test(l)).map(l => l.replace(/^[│├└─ ]*/, '').split(/ {2,}/)[0])).toEqual(['✗ part 2 · README', '✗ Explore · uses of paginate'])
  await ui.unmount()
})

test('where TaskStop is out of reach, the agents an agent started are stopped by gearbox too, and nothing else is', CREW, async ($: any, on) => {
  taskStop(on, { tools: ['Read'] })
  await crew($, on)
  const ui = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  await ui.press({ key: 'stop-a-t2' })
  for (const [agentId, denied] of [['a-t2', true], ['a-e1', true], ['a-t1', false]] as const) {
    const sent = JSON.stringify(await $.tool.call({ tool: 'Read', file_path: '/w/app/src/orders.ts', agentId }))
    expect(sent.includes('the person stopped this agent')).toBe(denied)
  }
  await ui.unmount()
})

test('TaskStop that answers yes but leaves the agent running is followed by gearbox’s own stop after ten seconds; an agent that ended by then is left alone', CREW_LOGGED, async ($: any, on) => {
  const sent = taskStop(on)
  const log = fakeDisk(on)
  const agents = listing(on)
  const c = await crew($, on)
  for (const id of LIVE) agents[id] = 'running'
  const ui = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  await ui.press({ key: 'stop-a-t1' })
  await ui.press({ key: 'stop-a-t2' })
  expect(sent.map((e: any) => e.task_id)).toEqual(['a-t1', 'a-t2', 'a-e1'])
  // TaskStop said yes to all three; the engine ends a-t1 and a-t2, but not the Explore.
  agents['a-t1'] = 'killed'
  agents['a-t2'] = 'killed'
  await c.clock.advance(3000)
  const call = (agentId: string) => $.tool.call({ tool: 'Read', file_path: '/w/app/src/orders.ts', agentId }).then((r: unknown) => JSON.stringify(r))
  expect(await call('a-e1')).not.toContain('the person stopped')
  await c.clock.advance(7000)
  expect(await call('a-e1')).toContain('the person stopped this agent')
  expect(await call('a-t1')).not.toContain('the person stopped') // ended, so no longer one gearbox holds back
  expect(events(log).filter(e => e.ev === 'stop').map(e => `${e.agent} ${e.via}`)).toEqual(['a-t1 task', 'a-t2 task', 'a-e1 task', 'a-e1 soft'])
  expect(events(log).at(-1)).toMatchObject({ agent: 'a-e1', via: 'soft', why: 'still running 10s after TaskStop' })
  await ui.unmount()
})

test('/gearbox stop all stops every agent at work, once each, and nothing else; /gearbox stop <id or start of its name> stops that agent and the agents it started', CREW_LOGGED, async ($: any, on) => {
  const sent = taskStop(on)
  const log = fakeDisk(on)
  const agents = listing(on)
  const c = await crew($, on, { owed: true })
  for (const id of LIVE) agents[id] = 'running'
  const run = async (args: string) => (await $.command.run({ command: 'gearbox', args })).text as string
  // Nothing named, or a name no agent at work has, says who is at work; an ambiguous one lists the agents it names.
  expect(await run('stop')).toBe('stop which? /gearbox stop all, or an agent’s id or the start of its name. At work: part 1 · customers (a-t1), part 2 · README (a-t2), Explore · uses of paginate (a-e1)')
  expect(await run('stop part 3')).toBe('no agent at work is named "part 3". At work: part 1 · customers (a-t1), part 2 · README (a-t2), Explore · uses of paginate (a-e1)') // it ended
  expect(await run('stop main')).toContain('no agent at work is named "main"')
  expect(await run('stop part')).toBe('"part" names 2 agents: part 1 · customers (a-t1), part 2 · README (a-t2). Give more of the name, or its id.')
  expect(sent).toHaveLength(0)
  // By the start of its name, case ignored, or by its id: the agent and what it started.
  expect(await run('stop Part 2')).toBe('stopping part 2 · README, Explore · uses of paginate. ✗ stopped shows once the engine says they ended')
  expect(sent.map((e: any) => e.task_id)).toEqual(['a-t2', 'a-e1'])
  expect(sent[0].consent).toBe('The user ran /gearbox stop part 2 to stop part 2 · README (a-t2) and the agents it started.')
  // Those two are being stopped already: not stopped again.
  expect(await run('stop part 2')).toBe('part 2 · README (a-t2) is being stopped already')
  expect(sent).toHaveLength(2)
  // All: the agents still at work, each once.
  expect(await run('stop all')).toBe('stopping part 1 · customers. ✗ stopped shows once the engine says it ended')
  expect(sent.map((e: any) => e.task_id)).toEqual(['a-t2', 'a-e1', 'a-t1'])
  expect(sent[2].consent).toBe('The user ran /gearbox stop all to stop part 1 · customers (a-t1).')
  // The queued part (billing) and the finished review were never stopped; the log says how each stopped.
  expect(events(log).filter(e => e.ev === 'stop').map(e => e.agent)).toEqual(['a-t2', 'a-e1', 'a-t1'])
  // Nothing is at work once the engine says so.
  for (const id of LIVE) agents[id] = 'killed'
  await c.clock.advance(3000)
  expect(await run('stop all')).toBe('no agents are at work')
  expect(await run('stop part 1')).toBe('no agents are at work')
})

test('/gearbox stop all with every agent being stopped already does nothing more', CREW, async ($: any, on) => {
  const sent = taskStop(on)
  await crew($, on)
  const run = async (args: string) => (await $.command.run({ command: 'gearbox', args })).text as string
  expect(await run('stop all')).toMatch(/^stopping part 1 · customers, part 2 · README, Explore · uses of paginate\./)
  expect(await run('stop all')).toBe('every agent at work is being stopped already')
  expect(sent.map((e: any) => e.task_id)).toEqual(['a-t1', 'a-t2', 'a-e1'])
})

test('/gearbox stop all where TaskStop is out of reach says which agents gearbox ends at their next request; the command lists stop where it names its words', CREW, async ($: any, on) => {
  taskStop(on, { tools: [] })
  await crew($, on)
  const run = async (args: string) => (await $.command.run({ command: 'gearbox', args })).text as string
  expect(await run('stop all')).toBe(
    'stopping part 1 · customers, part 2 · README, Explore · uses of paginate. ✗ stopped shows once the engine says they ended. Claude Code’s TaskStop could not be used for part 1 · customers, part 2 · README, Explore · uses of paginate: gearbox ends them at the next request',
  )
  const calls = (await Promise.all(LIVE.map((agentId: string) => $.tool.call({ tool: 'Read', file_path: '/w/app/a', agentId })))).map((r: unknown) => JSON.stringify(r))
  expect(calls.every((c: string) => c.includes('the person stopped this agent'))).toBe(true)
  expect(await run('nonsense')).toMatch(/^unknown "nonsense"\. Try settings, panel, stop, model,/)
})

test('the /gearbox command names stop in its description', async ($: any, on) => {
  bench(on)
  const described: any[] = []
  on('tool.register', (_: unknown, e: any) => ({ value: { tool: `mcp__gearbox__${e.name}` } }))
  on('command.register', (_: unknown, e: any) => (described.push(e), { value: { command: e.name } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
  expect(described.find((c: any) => c.name === 'gearbox').description).toContain('| panel | stop <agent>|all | on | off |')
})

test('an agent the engine already ended along with the one stopped (a foreground agent takes the agents it started with it) is not stopped again; one that ended before the press is not stopped by gearbox either', CREW_LOGGED, async ($: any, on) => {
  const agents = listing(on)
  // The engine's TaskStop of part 2 ends the Explore beneath it too; one for an agent that is gone finds no task.
  const sent = taskStop(on, {
    answer: (e: any) => {
      if (e.task_id === 'a-t2') agents['a-e1'] = 'killed'
      return agents[e.task_id] === 'completed' ? { result: 'Error: No task found', text: `<tool_use_error>No task found with ID: ${e.task_id}</tool_use_error>`, isError: true } : { result: { message: 'stopped' }, text: 'stopped' }
    },
  })
  const log = fakeDisk(on)
  const c = await crew($, on)
  for (const id of LIVE) agents[id] = 'running'
  const ui = await $.ui.mount({ ...BAND_AT(120), surface: 'terminal' })
  await ui.press({ key: 'stop-a-t2' })
  expect(sent.map((e: any) => e.task_id)).toEqual(['a-t2']) // no second call for the Explore: the engine ended it
  expect(events(log).filter(e => e.ev === 'stop')).toEqual([
    expect.objectContaining({ agent: 'a-t2', via: 'task', cascade: ['a-e1'] }),
    expect.objectContaining({ agent: 'a-e1', via: 'task', by: 'a-t2', why: 'ended with a-t2' }),
  ])
  // Part 1 finished by itself an instant before the press: the TaskStop finds nothing, and gearbox has nothing to stop.
  agents['a-t1'] = 'completed'
  await ui.press({ key: 'stop-a-t1' })
  expect(sent.map((e: any) => e.task_id)).toEqual(['a-t2', 'a-t1'])
  expect(events(log).filter(e => e.ev === 'stop').at(-1)).toMatchObject({ agent: 'a-t1', via: 'task', why: 'TaskStop failed: <tool_use_error>No task found with ID: a-t1</tool_use_error>; it had ended' })
  expect(JSON.stringify(await $.tool.call({ tool: 'Read', file_path: '/w/app/a', agentId: 'a-t1' }))).not.toContain('the person stopped')
  // The engine's next look settles the rows by what it lists: part 1 done, the Explore stopped, and part 2 (listed as running
  // still) says stopping until the engine ends it.
  await c.clock.advance(3000)
  const rows = (await lines(ui, 120)).filter(l => /^[│├└─ ]*[✓✗●] /.test(l) && !/^[│├└─ ]*● main/.test(l))
  expect(rows.map(l => l.replace(/^[│├└─ ]*/, '').split(/ {2,}/)[0])).toEqual(['✓ part 1 · customers', '● part 2 · README', '✗ Explore · uses of paginate', '✓ part 3 · review money.ts'])
  expect(rows[1]).toMatch(/stopping…$/)
  await ui.unmount()
})
