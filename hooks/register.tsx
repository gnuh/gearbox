import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelEffort, PluginOptions, PromptOrigin, Register, TurnUsage } from 'claude-code'
import type { GearboxLoop } from '../types'
import {
  type Gear,
  type Handoff,
  type Model,
  type Plan,
  type Step,
  isBrowserTool,
  isLongCommand,
  EFFORTS,
  doesHandoffWork,
  upTo,
  workEffort,
  MODELS,
  NOD,
  STARTER,
  SURVEY,
  gearFor,
  handoffNote,
  label,
  mainModel,
  needsConsent,
  nextFloor,
  plan,
  route,
  routeNote,
  ownWords,
  readReading,
  stepDown,
  trimRequest,
  verifyAsk,
} from './policy'

// US$ per million tokens.
// shortcut: copied from the claude-api skill's table (cached 2026-10-06), Haiku's long-prompt rate ignored; update when prices move.
const PRICES: Record<Model, { fresh: number; written: number; cached: number; out: number }> = {
  haiku: { fresh: 0.1, written: 0.125, cached: 0.01, out: 0.5 },
  sonnet: { fresh: 2, written: 2.5, cached: 0.2, out: 10 },
  opus: { fresh: 4, written: 5, cached: 0.2, out: 20 },
  fable: { fresh: 10, written: 12.5, cached: 0.25, out: 50 },
}

const KIND: Record<Handoff['kind'], string> = { drive: 'browser check', wait: 'long command', aside: 'side task', deep: 'deep work' }
const HUE: Record<Model, string> = { haiku: '#2BB3A0', sonnet: '#5B8DEF', opus: '#D99A2B', fable: '#D062B5' }
const PANE = 'gearbox'
const KEEP_LOOPS = 40

// Every loop's model right now, which every readout draws from. The tag declines what another version stored.
const LOOPS = atom({ plugin: 'gearbox', key: 'loops' } as const, {}, { shape: 'loops-1' })
// What /gearbox set, mirrored from the store so the settings panel redraws when a value changes.
const SETTINGS = atom({ plugin: 'gearbox', key: 'settings' } as const, {}, { shape: 'settings-1' })
const SETTINGS_PANE = 'gearbox-settings'

const kilo = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))

// A model id or alias as its family: claude-sonnet-5-5 → sonnet.
const family = (id: string): Model | undefined => MODELS.find(m => id.includes(m))
export const gearText = (l: GearboxLoop) => `${family(l.asked) ?? l.asked}${l.effort ? `·${l.effort}` : ''}`
const hue = (l: GearboxLoop) => HUE[family(l.asked) ?? 'opus']
// A fallback answered on another family than the step asked for.
const swapped = (l: GearboxLoop) => l.answered !== undefined && family(l.answered) !== family(l.asked)

// Applies `fn` to one loop's row; finished subagents past KEEP_LOOPS leave, oldest first.
const patch = ($: EngineInterface, id: string, fn: (l: GearboxLoop | undefined) => GearboxLoop | undefined) =>
  update($, LOOPS, all => {
    const row = fn(all[id])
    const next: Record<string, GearboxLoop> = row ? { ...all, [id]: row } : { ...all }
    const done = Object.keys(next).filter(k => next[k]!.state === 'done')
    for (const k of done.slice(0, Math.max(0, Object.keys(next).length - KEEP_LOOPS))) delete next[k]
    return next
  })

const working = (loops: Record<string, GearboxLoop>) =>
  Object.entries(loops).filter(([id, l]) => id !== 'main' && l.state === 'working')

// What a loop is doing, for the pane and the popup: the tool, with its target where that says something.
export const describeTool = (tool: string, input: Record<string, unknown>): string => {
  const name = tool.includes('__') ? tool.split('__').pop()! : tool
  const first = (v: unknown, n: number) => String(v ?? '').trim().split('\n')[0]!.slice(0, n)
  if (tool === 'Bash' || tool === 'PowerShell') return `${name}: ${first(input.command, 48)}`
  if (tool === 'Agent') return `Agent: ${first(input.description, 40)}`
  if (typeof input.file_path === 'string') return `${name} ${input.file_path.split('/').pop()}`
  if (typeof input.url === 'string') return `${name} ${first(input.url, 40)}`
  if (typeof input.pattern === 'string') return `${name} ${first(input.pattern, 32)}`
  return name
}

// The popup's text: main, then every running subagent as a tree, each with its model·effort and what it is doing.
// Undefined while no subagent runs: the status line covers the main conversation alone.
export const popupText = (loops: Record<string, GearboxLoop>): string | undefined => {
  const running = Object.entries(loops).filter(([id, l]) => id !== 'main' && l.state === 'working')
  if (!running.length) return undefined
  const main = loops.main
  const head = main ? [`main · ${gearText(main)} · ${main.state === 'working' ? (main.doing ?? 'thinking') : main.state}`] : []
  const rows = running.map(
    ([id, l], i) => `${'   '.repeat(Math.max(0, depth(loops, id) - 1))}${i === running.length - 1 ? '└' : '├'} ${l.label} · ${gearText(l)} · ${l.doing ?? 'thinking'}`,
  )
  return [`gearbox · ${running.length} running`, ...head, ...rows].join('\n')
}

type PopupState = { shown?: string }

// Keeps the popup (a toast, the one floating surface a mod has on every client) in step with what runs. A new
// toast takes the place of the mod's own last one, so each change redraws it; it holds while agents run, and a
// short closing toast replaces it when the last one ends. Quiet while the gearbox pane is shown: it says the same.
const refreshPopup = async ($: EngineInterface, popup: PopupState, on: boolean, note: (rec: Record<string, unknown>) => void) => {
  if (!on) return
  // A display, never a gate: whatever fails here must not take the hook that called it down with it.
  try {
    const text = popupText(await read($, LOOPS))
    if (!text) {
      if (popup.shown) {
        $.ui.toast('gearbox · subagents finished', { timeoutMs: 2500 })
        note({ ev: 'popup', closed: true })
      }
      popup.shown = undefined
      return
    }
    if (text === popup.shown) return
    if ((await $.ui.panes()).some(p => p.id === PANE && p.isShown)) return
    $.ui.toast(text, { timeoutMs: 10 * 60_000 })
    popup.shown = text
    note({ ev: 'popup', text })
  } catch (err) {
    $.ui.log(`gearbox: popup not shown: ${err}`, { to: 'debug' })
  }
}

// The status line: the main gear, then the running subagents, else what this turn hands off.
const showStatus = async ($: EngineInterface, handoff?: Handoff, step?: string) => {
  const loops = await read($, LOOPS)
  const main = loops.main
  if (!main) return $.ui.status(undefined)
  const subs = working(loops)
  const tail = subs.length
    ? ` ⇢ ${subs.length} agent${subs.length > 1 ? 's' : ''}: ${subs.map(([, l]) => gearText(l)).join(', ')}`
    : handoff
      ? ` ⇢ ${handoff.gear.model} ${KIND[handoff.kind]}`
      : ''
  $.ui.status(`gearbox ▸ ${gearText(main)}${step ? ` · ${step}` : ''}${tail}`)
}

// How deep a loop sits under main, for the pane's indent.
const depth = (loops: Record<string, GearboxLoop>, id: string) => {
  let d = 0
  for (let p = loops[id]?.parent; p && p !== 'main' && d < 8; p = loops[p]?.parent) d++
  return id === 'main' ? 0 : d + 1
}

const fit = (s: string, w: number) => (s.length > w ? `${s.slice(0, Math.max(0, w - 1))}…` : s.padEnd(w))

// Whether a person typed the prompt (no origin means the person's own); notifications, schedules and peers are not surveyed.
const typedByPerson = (o?: PromptOrigin) =>
  !o || o.kind === 'composer' || o.kind === 'bridge' || o.kind === 'sdk' || (o.kind === 'plugin' && o.asUser === true)

// The person's last few messages, short, so the survey can tell a side task from the work under way.
const recentAsks = async ($: EngineInterface) =>
  (await $.session.messages())
    .filter(m => m.role === 'user' && m.text.trim())
    .slice(-3)
    .map(m => m.text.slice(0, 200))

// One low-effort Haiku call that describes the request; undefined when the reply is unusable.
// The request travels inside JSON, so nothing pasted into it can pose as another field.
const survey = async ($: EngineInterface, request: string, earlier: string[], previous?: Gear) => {
  const r = await $.model.complete({
    model: 'haiku',
    system: SURVEY,
    prompt: JSON.stringify({ request: trimRequest(request), earlier, previous: previous ?? null }),
    effort: 'low',
    // No cap on Haiku's answer: a reply that stops mid-correction is unreadable, and Haiku costs little.
    maxTokens: 64_000,
    timeoutMs: 30_000,
  })
  $.ui.log(`gearbox survey: ${r.isAnswered ? r.text.trim() : `no reply (${r.reason})`}`, { to: 'debug' })
  return { reading: r.isAnswered ? readReading(r.text) : undefined, reply: r.isAnswered ? r.text.trim() : `no reply (${r.reason})` }
}

// The debug log: one JSON line per event in ~/.claude/gearbox/logs/<session>.jsonl. The mod file API replaces a
// whole file, so the session's log is kept and rewritten at the end of each turn.
type LogState = { pending: string[]; path?: string; body?: string }

const flushLog = async ($: EngineInterface, log: LogState) => {
  if (!log.pending.length) return
  try {
    log.path ??= `${(await $.env.get('HOME')) ?? '.'}/.claude/gearbox/logs/${await $.session.id()}.jsonl`
    log.body ??= (await $.fs.exists(log.path)) ? String(await $.fs.read(log.path)) : ''
    log.body += log.pending.splice(0).map(line => `${line}\n`).join('')
    await $.fs.write(log.path, log.body)
  } catch (err) {
    $.ui.log(`gearbox: log not written: ${err}`, { to: 'debug' })
  }
}

// What the log opens with: versions and the settings in force, with where they came from.
const sessionFacts = async ($: EngineInterface, options: PluginOptions) => {
  let gearbox = 'unknown'
  try {
    gearbox = JSON.parse(String(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))).version
  } catch {}
  return { ev: 'session', gearbox, claude: (await $.session.version()).version, model: await $.session.model(), fromGearbox: (await $.store.get('settings')) ?? {}, fromPlugin: options }
}

// Puts a costly gear to the person; a dismissed dialog, or an answer typed under "Other", takes the cheaper one.
const consent = async ($: EngineInterface, g: Gear): Promise<Gear> => {
  const cheaper = stepDown(g)
  try {
    const answer = await $.ui.ask(`gearbox would run this at ${label(g)}${g.model === 'fable' ? ' in a Fable subagent' : ''}. Which gear?`, {
      header: 'gearbox',
      options: [label(g), label(cheaper)],
    })
    return answer === label(g) ? g : cheaper
  } catch {
    $.ui.toast(`gearbox: couldn't ask, so ${label(cheaper)}`)
    return cheaper
  }
}

type Ledger = Record<string, { calls: number; fresh: number; written: number; cached: number; out: number }>

let pending: Promise<unknown> = Promise.resolve()
// Subagent steps can end together, so the ledger is updated one step at a time and none is lost.
// shortcut: two Claude processes writing at once can still drop a step; fine for an estimate.
const tally = ($: EngineInterface, u: TurnUsage) =>
  (pending = pending
    .then(async () => {
      const ledger = ((await $.store.get('usage')) ?? {}) as Ledger
      const row = (ledger[u.model] ??= { calls: 0, fresh: 0, written: 0, cached: 0, out: 0 })
      row.calls += 1
      row.fresh += u.input_tokens
      row.written += u.cache_creation_input_tokens
      row.cached += u.cache_read_input_tokens
      row.out += u.output_tokens
      await $.store.set('usage', ledger)
    })
    .catch(err => $.ui.log(`gearbox: usage not saved: ${err}`, { to: 'debug' })))

const dollars = (model: string, r: Ledger[string]) => {
  const p = PRICES[family(model) ?? 'opus']
  return (r.fresh * p.fresh + r.written * p.written + r.cached * p.cached + r.out * p.out) / 1e6
}

export const usageReport = (ledger: Ledger) => {
  const rows = Object.entries(ledger)
  if (!rows.length) return 'gearbox: nothing used yet'
  const lines = rows.map(([m, r]) => `${m}  ${r.calls} calls  ${kilo(r.fresh + r.written + r.cached)} in  ${kilo(r.out)} out  ≈ $${dollars(m, r).toFixed(2)}`)
  const total = rows.reduce((sum, [m, r]) => sum + dollars(m, r), 0)
  return [...lines, `total ≈ $${total.toFixed(2)} at API list prices, subagents included`].join('\n')
}

const CODE_EFFORTS: readonly ModelEffort[] = ['medium', 'high', 'xhigh']

export type LogMode = 'off' | 'on' | 'full'
export type Settings = { code_effort: ModelEffort; steer: boolean; navigator: 'haiku' | 'sonnet'; strict: boolean; log: LogMode; pane: 'all' | 'running'; popup: boolean }

// The person's settings: what /gearbox set (kept in the store) wins over the plugin's options, which not
// every Claude Code screen lets a person edit.
export const settingsFrom = (options: PluginOptions, stored: unknown): Settings => {
  const o: Record<string, unknown> = { ...options, ...(stored && typeof stored === 'object' ? stored : {}) }
  return {
    code_effort: CODE_EFFORTS.includes(o.code_effort as ModelEffort) ? (o.code_effort as ModelEffort) : 'xhigh',
    steer: o.steer !== false,
    navigator: o.navigator === 'haiku' ? 'haiku' : 'sonnet',
    strict: o.strict !== false,
    log: o.log === 'on' || o.log === 'full' ? o.log : 'off',
    pane: o.pane === 'running' ? 'running' : 'all',
    popup: o.popup !== false,
  }
}

// One `/gearbox <setting> <value>`; undefined when the value is not one the setting takes.
export const settingPatch = (word: string, value: string | undefined): Partial<Settings> | undefined => {
  if (word === 'effort' && CODE_EFFORTS.includes(value as ModelEffort)) return { code_effort: value as ModelEffort }
  if (word === 'navigator' && (value === 'haiku' || value === 'sonnet')) return { navigator: value }
  if (word === 'steer' && (value === 'on' || value === 'off')) return { steer: value === 'on' }
  if (word === 'strict' && (value === 'on' || value === 'off')) return { strict: value === 'on' }
  if (word === 'log' && (value === 'on' || value === 'off' || value === 'full')) return { log: value }
  if (word === 'pane' && (value === 'all' || value === 'running')) return { pane: value }
  if (word === 'popup' && (value === 'on' || value === 'off')) return { popup: value === 'on' }
  return undefined
}

const SETTING_CHOICES: Record<string, string> = { effort: 'medium, high or xhigh', navigator: 'sonnet or haiku', steer: 'on or off', strict: 'on or off', log: 'on, off or full', popup: 'on or off' }
const settingsText = (s: Settings) =>
  `coding effort ${s.code_effort} · navigator ${s.navigator} · steer ${s.steer ? 'on' : 'off'} · strict hand-offs ${s.strict ? 'on' : 'off'} · log ${s.log} · popup ${s.popup ? 'on' : 'off'}`

const loadSettings = async ($: EngineInterface, options: PluginOptions) => settingsFrom(options, await $.store.get('settings'))

const saveSetting = async ($: EngineInterface, patch: Partial<Settings>) => {
  const stored = ((await $.store.get('settings')) ?? {}) as Partial<Settings>
  await $.store.set('settings', { ...stored, ...patch })
  await update($, SETTINGS, held => ({ ...held, ...patch }))
}


export const register: Register = (on, options) => {
  // The person's settings (userConfig): effort for ordinary coding turns, and whether non-Haiku sessions are steered.
  let { code_effort: standing, steer: steers, navigator, strict, log: logMode } = settingsFrom(options, undefined)
  let paneShows: Settings['pane'] = 'all'
  let popupOn = true
  const popup: PopupState = {}
  const current = (): Settings => ({ code_effort: standing, steer: steers, navigator, strict, log: logMode, pane: paneShows, popup: popupOn })
  // The debug log of this session; see /gearbox log.
  const log: LogState = { pending: [] }
  const logEvent = (rec: Record<string, unknown>) => {
    if (logMode !== 'off') log.pending.push(JSON.stringify({ t: Date.now(), ...rec }))
  }
  const apply = (s: Settings) => {
    standing = s.code_effort
    steers = s.steer
    navigator = s.navigator
    strict = s.strict
    logMode = s.log
    paneShows = s.pane
    popupOn = s.popup
  }
  // shortcut: routing state lives in module variables, so a hot reload forgets the floor; the next prompt picks afresh.
  // The readout's loops live in $.state and survive it.
  let enabled = true
  let floor: Model | undefined // the main conversation's model so far: it only rises, and never to fable
  let previous: Gear | undefined // the last main gear, for carry-on replies
  let turnGear: Gear | undefined // the gear of the turn under way
  let turnHandoff: Handoff | undefined
  let turnRoute: Step[] | undefined // the steps of a multi-step request, in order
  let turnStep: number | undefined // the route step under way
  let handedOff = new Set<number>() // route steps (or -1, a single hand-off) whose subagent has started
  let ownEffort: string | undefined // a turn whose effort Claude Code sets: a slash command or skill, or ultrathink
  // The browser check or long command under way that a subagent should be doing, if any.
  // The hand-off the next plain Agent call belongs to: the step marked with phase if it is a subagent step,
  // else the first subagent step not yet started; a single-hand-off turn has its one.
  const nextHandoff = (): { gear: Gear; slot: number } | undefined => {
    if (turnRoute) {
      const marked = turnStep && turnRoute[turnStep - 1]?.by === 'agent' && !handedOff.has(turnStep - 1) ? turnStep - 1 : -1
      const slot = marked >= 0 ? marked : turnRoute.findIndex((s, k) => s.by === 'agent' && !handedOff.has(k))
      return slot >= 0 ? { gear: turnRoute[slot]!.gear, slot } : undefined
    }
    return turnHandoff && !handedOff.has(-1) ? { gear: turnHandoff.gear, slot: -1 } : undefined
  }
  // The gear of the hand-off step under way, for the refusal that points the model at it.
  const handoffGear = (): Gear | undefined =>
    turnRoute ? (turnStep ? turnRoute[turnStep - 1]?.gear : undefined) : turnHandoff?.gear
  const handoffMode = (): 'drive' | 'wait' | undefined => {
    if (turnRoute) {
      const s = turnStep ? turnRoute[turnStep - 1] : undefined
      return s?.by === 'agent' && (s.mode === 'drive' || s.mode === 'wait') ? s.mode : undefined
    }
    return turnHandoff?.kind === 'drive' || turnHandoff?.kind === 'wait' ? turnHandoff.kind : undefined
  }
  const stepLabel = (): string | undefined =>
    ownEffort ? `${ownEffort} sets its own effort` : routeLabel()
  const routeLabel = () => (turnRoute && turnStep ? `step ${turnStep}/${turnRoute.length} ${turnRoute[turnStep - 1]!.what}` : undefined)
  const forget = () => {
    floor = previous = turnGear = turnHandoff = turnRoute = turnStep = ownEffort = undefined
    handedOff = new Set()
  }

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'phase',
      description: 'gearbox: call with a step number from the gearbox route as you start that step; gearbox sets your effort for it.',
      inputSchema: { type: 'object', properties: { step: { type: 'integer', minimum: 1 } }, required: ['step'] },
      isDeferred: false,
    })
    await $.command.register({ name: 'gearbox', description: 'Model routing and readout: /gearbox [settings | effort <level> | navigator <model> | steer on|off | strict on|off | pane | on | off | ask on|off | usage]' })
    enabled = (await $.store.get('enabled')) !== false
    apply(await loadSettings($, options))
    const stored = ((await $.store.get('settings')) ?? {}) as Partial<Settings>
    await update($, SETTINGS, () => stored)
    if (logMode !== 'off') logEvent({ ...(await sessionFacts($, options)), settings: current() })
    return next(e)
  })

  // /clear starts a fresh context, so the next prompt may pick any gear.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      forget()
      await update($, LOOPS, () => ({}))
    }
    logEvent({ ev: 'end', reason: e.reason })
    await flushLog($, log)
    return next(e)
  })

  on('command.run', { command: 'gearbox' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    apply(await loadSettings($, options))
    const [word = '', value] = arg.split(/\s+/)
    if (arg === 'log') {
      if (logMode === 'off') return { text: 'gearbox: the log is off. /gearbox log on starts one for this session; /gearbox log full also keeps the first 200 characters of each prompt.' }
      await flushLog($, log)
      const lines = (log.body ?? '').trim().split('\n').filter(Boolean)
      const last = (ev: string) => lines.map(l => JSON.parse(l)).reverse().find(r => r.ev === ev)
      const gear = last('gear')
      const step = last('step')
      return {
        text: [
          `gearbox log (${logMode}): ${log.path} · ${lines.length} events`,
          gear ? `last decision: ${gear.gear} (${gear.why})` : 'no decision logged yet',
          step ? `last request: ${step.loop} sent ${step.sent}, Claude Code's own setting ${step.engine}, answered by ${step.answered ?? 'unknown'}` : '',
        ].filter(Boolean).join('\n'),
      }
    }
    if (arg === 'settings' || word in SETTING_CHOICES) {
      if (arg === 'settings') {
        const { isPlaced } = await $.ui.open({ id: SETTINGS_PANE, title: 'gearbox settings', focus: true, closeOnEscape: true })
        return {
          text: isPlaced
            ? 'gearbox: settings open. Press a value to use it; Esc closes.'
            : `gearbox: ${settingsText(current())}. The settings panel has no room here; set one with /gearbox effort|navigator|steer|strict <value>.`,
        }
      }
      const change = settingPatch(word, value)
      if (!change) return { text: `gearbox: ${word} takes ${SETTING_CHOICES[word]}` }
      const wasLogging = logMode !== 'off'
      await saveSetting($, change)
      apply(await loadSettings($, options))
      if (!wasLogging && logMode !== 'off') {
        logEvent({ ...(await sessionFacts($, options)), settings: current() })
        await flushLog($, log)
      }
      return { text: `gearbox: ${settingsText(current())} (from your next prompt)` }
    }
    if (word === 'pane') {
      // /gearbox pane running|all also sets what the pane lists, then opens it.
      if (value) {
        const change = settingPatch('pane', value)
        if (!change) return { text: 'gearbox: pane takes running or all' }
        await saveSetting($, change)
        apply(await loadSettings($, options))
      }
      const { isPlaced } = await $.ui.open({ id: PANE, title: 'gearbox: models now' })
      return { text: isPlaced ? 'gearbox: pane open' : 'gearbox: the pane opens once the window has room for it' }
    }
    if (arg === 'on' || arg === 'off') {
      enabled = arg === 'on'
      await $.store.set('enabled', enabled)
      // Off means plain Haiku again, and no readout; on picks afresh at the next prompt.
      if (!enabled) {
        forget()
        await update($, LOOPS, () => ({}))
        $.ui.status(undefined)
      }
    } else if (arg === 'ask on' || arg === 'ask off') {
      await $.store.set('consent', arg === 'ask on')
    } else if (arg === 'usage') {
      return { text: usageReport(((await $.store.get('usage')) ?? {}) as Ledger) }
    } else if (arg === 'usage reset') {
      await $.store.delete('usage')
      return { text: 'gearbox: usage cleared' }
    } else if (arg) {
      return { text: `gearbox: unknown "${arg}". Try settings, effort, navigator, steer, strict, pane, on, off, ask on, ask off, usage or usage reset.` }
    }
    const asks = (await $.store.get('consent')) !== false
    const session = await $.session.model()
    const mode = session.includes('haiku') ? 'shifting models' : steers ? `steering effort on ${family(session) ?? session}` : 'readout only'
    return {
      text: `gearbox ${enabled ? `on, ${mode}` : 'off'} · ${settingsText(current())} · asks before costly gears: ${asks ? 'yes' : 'no'}${floor ? ` · main model ${floor}` : ''}${previous ? ` · last gear ${label(previous)}` : ''}\nChange settings with /gearbox settings, or /gearbox effort|navigator|steer <value>.`,
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.turnId) return next(e) // typed into a running turn, which keeps its gear
    // A slash command or skill owns its turn's effort (its frontmatter, or Claude Code's own): no leftover gear.
    if (enabled && e.command && typedByPerson(e.origin)) {
      turnGear = turnHandoff = turnRoute = turnStep = undefined
      handedOff = new Set()
      ownEffort = `/${e.command.name}`
      logEvent({ ev: 'prompt', kind: 'command', command: e.command.name, gear: 'its own effort' })
      return next(e)
    }
    // A notification (say, a route's subagent finishing) keeps the turn's gear and route.
    if (!enabled || e.command || e.isMeta || !typedByPerson(e.origin)) {
      if (enabled && !e.command) logEvent({ ev: 'prompt', kind: e.origin?.kind ?? 'meta', keeps: turnGear ? label(turnGear) : 'no gear' })
      return next(e)
    }
    turnGear = turnHandoff = turnRoute = turnStep = undefined
    handedOff = new Set()
    // "ultrathink" in the person's own words raises this turn's effort in Claude Code; gearbox leaves it be.
    ownEffort = /\bultrathink\b/i.test(ownWords(e.text)) ? 'ultrathink' : undefined
    apply(await loadSettings($, options))
    // A Haiku session shifts models; any other keeps its model and is only steered (effort and handoffs).
    const session = await $.session.model()
    const shifting = session.includes('haiku')
    const fixed = shifting ? undefined : family(session)
    logEvent({ ev: 'prompt', kind: ownEffort ?? 'typed', chars: e.text.length, ...(logMode === 'full' ? { text: e.text.slice(0, 200) } : {}), session })
    if (!shifting && (!steers || !fixed)) {
      logEvent({ ev: 'gear', gear: 'untouched', why: 'steer is off for sessions not on Haiku' })
      return next(e)
    }
    const base = fixed ?? floor
    let why = ''

    let p: Plan
    let ask: Partial<Gear> = {}
    if (previous && NOD.test(e.text.trim())) {
      p = { main: previous }
      why = 'nod: reused the last work gear'
    } else {
      const earlier = await recentAsks($)
      const started = Date.now()
      const { reading: r, reply } = await survey($, e.text, earlier, previous)
      logEvent({ ev: 'survey', ms: Date.now() - started, reply, reading: r ?? null })
      if (!r) {
        // Unreadable: the last gear, else the person's coding effort; never a lower default.
        p = { main: previous ?? { model: fixed ?? STARTER.model, effort: standing } }
        why = `survey unreadable: ${previous ? 'previous gear' : 'your coding effort'}`
      } else if (r.cont && previous) {
        p = { main: previous }
        why = 'continuation: previous gear'
      } else {
        why = `survey: ${r.mode}, ${r.reach}, depth ${r.depth}${r.care === 'costly' ? ', costly' : ''}${r.sure ? '' : ' (unsure: its best guess, no hand-off)'}`
        ask = verifyAsk(r.ask, e.text)
        const checked = { ...r, ask }
        const asks = (await $.store.get('consent')) !== false
        let want = gearFor(checked, standing)
        if (r.sure && r.phases.length >= 2) {
          // Several steps: one route, each step on its own executor and effort. Fable only as a subagent.
          const lead = fixed ?? mainModel({ main: { model: want.model === 'fable' ? 'opus' : want.model, effort: want.effort } }, ask, base)
          // A model named for a step counts only where the person's own words say it.
          const phases = r.phases.map(ph => ({ ...ph, ask: ph.ask && verifyAsk({ model: ph.ask }, e.text).model === ph.ask ? ph.ask : undefined }))
          turnRoute = route(phases, lead, standing, r.care === 'costly', navigator)
          for (const s of turnRoute) {
            if (s.by === 'main' && asks && needsConsent(s.gear, ask, previous, standing)) {
              s.gear = await consent($, s.gear)
              s.mainEffort = s.gear.effort
            }
          }
          p = { main: { model: lead, effort: workEffort(turnRoute) } }
          why += `; route of ${turnRoute.length} steps, starting at its work effort`
        } else {
          if (asks && needsConsent(want, ask, previous, standing)) {
            const proposed = label(want)
            want = await consent($, want)
            why += `; you chose ${label(want)} over ${proposed}`
          }
          // Unsure: its best guess for the effort, but nothing handed off on a guess.
          p = r.sure ? plan(checked, want, base, earlier.length > 0, fixed, navigator) : { main: fixed ? { model: fixed, effort: want.effort } : want }
          if (ask.model || ask.effort) why += `; you asked for ${[ask.model, ask.effort].filter(Boolean).join(' ')}`
        }
      }
    }
    turnGear = { model: mainModel(p, ask, base), effort: p.main.effort }
    // What a nod, a notification or an unreadable prompt reuses: the gear of the work itself, never the low
    // effort of a turn that only briefs a subagent.
    if (!p.handoff || !previous) previous = turnGear
    turnHandoff = p.handoff
    logEvent({
      ev: 'gear',
      gear: label(turnGear),
      why: ownEffort ? `${why}; ultrathink: Claude Code sets the effort` : why,
      ...(p.handoff ? { handoff: `${p.handoff.kind} → ${label(p.handoff.gear)}` } : {}),
      ...(turnRoute ? { route: turnRoute.map((s, i) => `${i + 1}. ${s.what}: ${s.by} ${label(s.gear)}`) } : {}),
    })
    const note = turnRoute ? routeNote(turnRoute) : p.handoff ? handoffNote(p.handoff) : undefined
    return next(note ? { ...e, context: [...(e.context ?? []), note] } : e)
  })

  // The route's phase tool: the main model calls it as each step starts, and later steps run at that step's effort.
  on('tool.call', { tool: 'mcp__gearbox__phase' }, async ($, e) => {
    const n = Number((e as any).input?.step ?? (e as any).step)
    const s = turnRoute?.[n - 1]
    if (!s || !turnGear) return { result: 'gearbox: no route step with that number in this turn', isError: true as const }
    turnGear = { ...turnGear, effort: s.mainEffort }
    turnStep = n
    logEvent({ ev: 'phase', step: n, what: s.what, by: s.by, effort: s.mainEffort })
    await showStatus($, undefined, stepLabel())
    // A tool's result is a string (or content blocks), never an object.
    return { result: s.by === 'agent' ? `step ${n}: hand it to a ${s.gear.model} subagent at ${s.gear.effort}` : `step ${n}: you now run at effort ${s.mainEffort}` }
  })

  // An Agent call that names no model and no agent type runs on the main conversation's model.
  // Every subagent that starts gets a row in the readout.
  on('agent.spawn', async ($, e, next) => {
    const routed =
      enabled && floor && !e.model && !e.fork && !e.parentAgentId && e.subagentType === 'general-purpose' && e.parentModel.includes('haiku')
        ? { ...e, model: floor }
        : e
    const started = await next(routed)
    if (enabled && !started.deny && started.agentId) {
      // Its first steps may land before this, so keep what they recorded.
      await patch($, started.agentId, l => ({ steps: 0, state: 'working', asked: started.model, ...l, label: e.description, parent: e.parentAgentId ?? 'main' }))
      await showStatus($, turnHandoff, stepLabel())
      await refreshPopup($, popup, popupOn, logEvent)
    }
    return started
  })

  on('tool.call', async ($, e, next) => {
    if (!enabled) return next(e)
    await patch($, e.agentId ?? 'main', l => l && { ...l, doing: describeTool(String(e.tool), e as unknown as Record<string, unknown>) })
    await refreshPopup($, popup, popupOn, logEvent)
    if (e.agentId) return next(e) // subagents do the hand-off work; never stand in their way
    // A plain Agent call during a hand-off runs on that step's model and effort, whatever the call named.
    if (e.tool === 'Agent' && (!e.subagent_type || e.subagent_type === 'general-purpose')) {
      const h = nextHandoff()
      if (!h) return next(e)
      handedOff.add(h.slot)
      logEvent({ ev: 'agent', type: e.subagent_type ?? 'general-purpose', asked: `${e.model ?? 'default'}·${e.effort ?? 'default'}`, set: label(h.gear) })
      return next({ ...e, model: h.gear.model, effort: h.gear.effort })
    }
    const mode = handoffMode()
    if (mode && turnGear) {
      const tool = String(e.tool)
      const inline = mode === 'drive' ? isBrowserTool(tool) : /^(Bash|PowerShell)$/.test(tool) && isLongCommand(String((e as any).command ?? ''))
      // Strict: the main conversation may not do a hand-off step's work itself; the refusal says what to start.
      if (strict && inline) {
        const g = handoffGear()
        logEvent({ ev: 'strict', tool, mode, refused: true })
        const job = mode === 'drive' ? 'click through the browser check and report only what it saw' : 'run the command and report only the outcome'
        return {
          deny: `gearbox: this step is a hand-off. Start an Agent${g ? ` with model "${g.model}" and effort "${g.effort}"` : ''} to ${job}, then judge its report here. (The person can allow doing it here with /gearbox strict off.)`,
        }
      }
      // Not strict: the model does the step's work itself, so low effort no longer fits; at least medium.
      if (doesHandoffWork(tool)) {
        turnGear = { ...turnGear, effort: upTo(EFFORTS, turnGear.effort, 'medium') }
        logEvent({ ev: 'raise', tool, mode, effort: turnGear.effort, why: 'the model does a hand-off step itself' })
        await showStatus($, turnHandoff, stepLabel())
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (enabled) {
      await patch($, e.agentId ?? 'main', l => {
        if (!l) return l
        const { doing: _, ...rest } = l
        return { ...rest, state: e.agentId ? 'done' : 'idle' }
      })
      await showStatus($, turnHandoff, stepLabel())
      await refreshPopup($, popup, popupOn, logEvent)
    }
    if (!e.agentId) {
      logEvent({ ev: 'turn', ms: e.durationMs, aborted: e.isAborted })
      await flushLog($, log)
    }
    return next(e)
  })

  // Only the main conversation is shifted, and only while the session itself is on Haiku: pick another model
  // in the app and gearbox steps aside. Prompts nobody typed run on the floor. Every loop's step is recorded
  // for the readout, in any session, and its usage tallied.
  on('turn.step', async function* ($, e, next) {
    let step = e
    if (!e.agentId && enabled) {
      // Shifting (Haiku session): the turn's model, else the floor. Steering: the session's model, unless the
      // person asked for another this turn. Effort changes are free: they keep the prompt cache (measured).
      const shifting = e.model.includes('haiku')
      const from = shifting ? floor : family(e.model)
      const model = shifting ? turnGear?.model ?? floor : turnGear?.model
      if (model && model !== from && from && e.index === 0) {
        const tokens = (await $.session.usage()).context.tokens ?? 0
        $.ui.toast(`gearbox: shifting to ${model}, re-caching ${kilo(tokens)} tokens ≈ $${((tokens * PRICES[model].written) / 1e6).toFixed(2)}`)
      }
      if (model && shifting) floor = nextFloor(model, floor)
      if (model && (shifting || model !== from)) step = { ...step, model }
      if (turnGear && !ownEffort) step = { ...step, effort: turnGear.effort }
    }
    const id = e.agentId ?? 'main'
    if (enabled) {
      await patch($, id, l => ({
        label: e.agentId ? 'agent' : 'main',
        ...(e.agentId ? { parent: 'main' } : {}),
        steps: 0,
        ...l,
        asked: step.model,
        ...(step.effort !== undefined ? { effort: String(step.effort) } : {}),
        state: 'working',
      }))
      if (!e.agentId) await showStatus($, turnHandoff, stepLabel())
      await refreshPopup($, popup, popupOn, logEvent)
    }
    const result = yield* next(step)
    if (enabled) await patch($, id, l => l && { ...l, ...(result.usage ? { answered: result.usage.model } : {}), steps: l.steps + 1 })
    // What gearbox sent next to what Claude Code would have sent (its own setting), and who answered.
    const u = result.usage
    logEvent({
      ev: 'step',
      loop: id,
      index: e.index,
      sent: `${family(step.model) ?? step.model}·${step.effort ?? 'default'}`,
      engine: `${family(e.model) ?? e.model}·${e.effort ?? 'default'}`,
      answered: u?.model,
      ...(u ? { in: u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens, out: u.output_tokens } : {}),
    })
    if (result.usage) await tally($, result.usage)
    return result
  })

  // The spinner names the model of the loop that is working: "Sauteing… on opus". The engine already shows effort.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!enabled) return next(e)
    const loops = await read($, LOOPS)
    const loop = loops[e.requestId] ?? loops.main
    if (!loop) return next(e)
    return next({ ...e, props: { ...e.props, suffix: `${e.props.suffix ?? '…'} on ${family(loop.asked) ?? loop.asked}` } })
  })

  // While subagents run, a chip per live loop above the prompt; otherwise the band stays empty.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!enabled || e.props.hasSurvey) return next(e)
    const loops = await read($, LOOPS)
    const subs = working(loops)
    if (!subs.length) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const live: [string, GearboxLoop][] = loops.main ? [['main', loops.main], ...subs] : subs
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {live.map(([id, l]) => (
          <Text>
            <Text color={hue(l)}>●</Text> {id === 'main' ? 'main' : l.label}{' '}
            <Text color={hue(l)} bold>
              {gearText(l)}
            </Text>
          </Text>
        ))}
      </Box>
    )
  })

  // /gearbox settings: one row of buttons per setting; the value in use is marked, a press saves another.
  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = settingsFrom(options, await read($, SETTINGS))
    const rows: [string, string, readonly string[], string][] = [
      ['Coding effort', 'effort', ['medium', 'high', 'xhigh'], s.code_effort],
      ['Browser navigator', 'navigator', ['sonnet', 'haiku'], s.navigator],
      ['Steer non-Haiku', 'steer', ['on', 'off'], s.steer ? 'on' : 'off'],
      ['Strict hand-offs', 'strict', ['on', 'off'], s.strict ? 'on' : 'off'],
      ['Debug log', 'log', ['off', 'on', 'full'], s.log],
      ['Models pane shows', 'pane', ['all', 'running'], s.pane],
      ['Popup while agents run', 'popup', ['on', 'off'], s.popup ? 'on' : 'off'],
    ]
    return (
      <Box flexDirection="column" rowGap={1}>
        {rows.map(([title, word, values, current]) => (
          <Box flexDirection="row" columnGap={1} alignItems="center">
            <Text mono>{title.padEnd(18)}</Text>
            {values.map(v => (
              <Button
                key={`${word}-${v}`}
                label={v === current ? `${v} ✓` : v}
                variant={v === current ? 'primary' : 'secondary'}
                onPress={() => saveSetting($, settingPatch(word, v)!)}
              />
            ))}
          </Box>
        ))}
        <Text dimColor>The marked value is in use. Changes apply from your next prompt. Esc closes.</Text>
      </Box>
    )
  })

  // /gearbox pane: every loop of the session, nested under the loop that started it.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    if (!enabled) return <Text dimColor>gearbox is off. /gearbox on turns it back on.</Text>
    const loops = await read($, LOOPS)
    // Reading the settings here redraws the pane when the filter changes.
    const runningOnly = settingsFrom(options, await read($, SETTINGS)).pane === 'running'
    const all = Object.entries(loops).sort(([a], [b]) => (a === 'main' ? -1 : b === 'main' ? 1 : 0))
    if (!all.length) return <Text dimColor>No model calls yet. Rows appear as the session works.</Text>
    // Running only: finished subagents leave; the main conversation stays as the anchor.
    const rows = runningOnly ? all.filter(([id, l]) => id === 'main' || l.state === 'working') : all
    const finished = all.filter(([, l]) => l.state === 'done').length
    const toggle = (
      <Button
        key="pane-filter"
        label={runningOnly ? `Show finished (${finished})` : 'Hide finished'}
        onPress={() => saveSetting($, { pane: runningOnly ? 'all' : 'running' })}
      />
    )
    const width = Math.max(40, e.props.bodyColumns)
    const [gearW, stepsW] = [15, 6]
    const nameW = Math.min(30, Math.max(12, Math.floor((width - gearW - stepsW) * 0.45)))
    const nowW = Math.max(8, width - nameW - gearW - stepsW)
    return (
      <Box flexDirection="column">
        {finished > 0 || runningOnly ? toggle : null}
        {/* mono keeps the padded columns aligned on the desktop; the terminal is monospaced anyway */}
        <Text dimColor mono>
          {fit('LOOP', nameW)}
          {fit('MODEL', gearW)}
          {fit('NOW', nowW)}
          {'STEPS'}
        </Text>
        {rows.map(([id, l]) => {
          const d = depth(loops, id)
          const name = d === 0 ? 'main' : `${'  '.repeat(d - 1)}└ ${l.label}`
          const now = l.state === 'working' ? (l.doing ?? 'thinking') : l.state
          return (
            <Text dimColor={l.state === 'done'} mono>
              {fit(name, nameW)}
              <Text color={hue(l)}>{fit(gearText(l), gearW)}</Text>
              {fit(swapped(l) ? `${now} ⚠ answered by ${family(l.answered!) ?? l.answered}` : now, nowW)}
              {String(l.steps)}
            </Text>
          )
        })}
      </Box>
    )
  })
}
