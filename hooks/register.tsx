import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, ModelEffort, PluginOptions, PromptOrigin, Register, TurnStepChunk, TurnStepResult, TurnUsage } from 'claude-code'
import type { GearboxLoop } from '../types'
import {
  type DeepAgent,
  type Escalate,
  type FanPart,
  type Gear,
  type Handoff,
  BRIEFING,
  BRIEFING_TOOLS,
  BRIEF_READS,
  ESCALATES,
  apartEdits,
  looksUp,
  ownBrief,
  resumable,
  type Model,
  type Plan,
  type Reading,
  type Step,
  isBrowserTool,
  isChoreCommand,
  isLongCommand,
  LONG_CONTEXT,
  SCOUT,
  SCOUT_WARM_MS,
  keepsScout,
  readKind,
  scouts,
  everyday,
  EFFORTS,
  doesHandoffWork,
  escalated,
  handoffLabel,
  isSkillFork,
  reviewGear,
  reviews,
  upFor,
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
  readParts,
  readReading,
  fanReply,
  stepDown,
  trimRequest,
  verifyAsk,
} from './policy'
import { NEUTRAL, ORCHESTRATOR, type Lane, type Lanes, fanOut, fanParts, keepsRoute, laneResumable, laneStart, orchestratorFrom, orchestratorPatch, orchestratorPlan, orchestratorRoute, type OrchestratorSettings, seatParts, whyNoFan } from './orchestrator'

// US$ per million tokens.
// shortcut: copied from the claude-api skill's table (cached 2026-10-06); update when prices move.
const PRICES: Record<Model, { fresh: number; written: number; cached: number; out: number }> = {
  haiku: { fresh: 0.1, written: 0.125, cached: 0.01, out: 0.5 },
  sonnet: { fresh: 2, written: 2.5, cached: 0.2, out: 10 },
  opus: { fresh: 4, written: 5, cached: 0.2, out: 20 },
  fable: { fresh: 10, written: 12.5, cached: 0.25, out: 50 },
}
// Haiku bills a prompt over 100K tokens at five times its rate: scouting on a long conversation pays this one.
const HAIKU_LONG = { fresh: 0.5, written: 0.625, cached: 0.05, out: 2.5 }
const LONG_ROW = ' over 100K'

const KIND: Record<Handoff['kind'], string> = { drive: 'browser check', wait: 'long command', chore: 'git chore', aside: 'side task', deep: 'deep work', lane: 'lane work', fan: 'parallel agents' }
const HUE: Record<Model, string> = { haiku: '#2BB3A0', sonnet: '#5B8DEF', opus: '#D99A2B', fable: '#D062B5' }
const PANE = 'gearbox'
const KEEP_LOOPS = 40

// Every loop's model right now, which every readout draws from. The tag declines what another version stored.
const LOOPS = atom({ plugin: 'gearbox', key: 'loops' } as const, {}, { shape: 'loops-1' })
// What /gearbox set, mirrored from the store so the settings panel redraws when a value changes.
const SETTINGS = atom({ plugin: 'gearbox', key: 'settings' } as const, {}, { shape: 'settings-1' })
const SETTINGS_PANE = 'gearbox-settings'
// The band's per-turn numbers. The tag declines what another version stored.
const TURN = atom({ plugin: 'gearbox', key: 'turn' } as const, { requests: {}, costs: [] }, { shape: 'turn-3' })

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

// What a loop is doing, for the pane and the band: the tool, with its target where that says something.
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


const sessionCost = async ($: EngineInterface) => {
  try {
    return (await $.session.usage()).cost?.usd
  } catch {
    return undefined
  }
}

// A person's prompt starts a new tally; the turn before it joins the costs the band's bars draw.
const startTurnTally = async ($: EngineInterface) => {
  const usd = await sessionCost($)
  await update($, TURN, t => ({
    requests: {},
    ...(usd !== undefined ? { costAtStart: usd } : {}),
    costs: t.costAtStart !== undefined && usd !== undefined && Object.keys(t.requests).length ? [...t.costs, usd - t.costAtStart].slice(-8) : t.costs,
  }))
}

const setWhy = ($: EngineInterface, why: [string, string]) => update($, TURN, t => ({ ...t, why }))

const countRequest = ($: EngineInterface, model: string) =>
  update($, TURN, t => ({ ...t, requests: { ...t.requests, [model]: (t.requests[model] ?? 0) + 1 } }))

const money = (n: number) => `$${n.toFixed(2)}`
const bars = (vals: number[]) => {
  const top = Math.max(...vals, 0)
  return top > 0 ? vals.map(v => '▁▂▃▄▅▆▇█'[Math.min(7, Math.round((v / top) * 7))]).join('') : ''
}
// How long a subagent has run: "42s", "3m 05s".
const ran = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

// Loops by gear, each gear once with its count: "sonnet·low ×2, haiku·low".
export const gearsText = (ls: GearboxLoop[], sep: string) => {
  const n = new Map<string, number>()
  for (const l of ls) n.set(gearText(l), (n.get(gearText(l)) ?? 0) + 1)
  return [...n].map(([g, c]) => (c > 1 ? `${g} ×${c}` : g)).join(sep)
}

// The status line: the main gear, then the running subagents, else what this turn hands off.
const showStatus = async ($: EngineInterface, handoff?: Handoff, step?: string) => {
  const loops = await read($, LOOPS)
  const main = loops.main
  if (!main) return $.ui.status(undefined)
  const subs = working(loops)
  const tail = subs.length
    ? ` ⇢ ${subs.length} agent${subs.length > 1 ? 's' : ''}: ${gearsText(subs.map(([, l]) => l), ', ')}`
    : handoff?.kind === 'fan'
      ? ` ⇢ ${handoff.parts?.length ?? 0} ${KIND.fan}`
      : handoff
        ? ` ⇢ ${handoff.gear.model} ${KIND[handoff.kind]}`
        : ''
  // Claude Code heads a plugin's status line with its name ("gearbox: …"), so the text starts at the gear.
  $.ui.status(`${gearText(main)}${step ? ` · ${step}` : ''}${tail}`)
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

// What the person said lately, `latest` (their turn's prompt) last, for the brief of a stronger model's subagent.
const personSaid = async ($: EngineInterface, latest: string): Promise<string[]> => {
  const said = (await $.session.messages()).filter(m => m.role === 'user' && m.text.trim()).map(m => m.text)
  return latest.trim() && said.at(-1)?.trim() !== latest.trim() ? [...said, latest] : said
}

// One low-effort call that describes the request; undefined when the reply is unusable. A person's prompt is read
// by Sonnet: replaying 79 real prompts, Haiku took main work for side tasks 8 times (Sonnet once) and made a
// question into a route; Sonnet costs about a second more. A subagent's brief only needs its kind of job: Haiku.
// The request travels inside JSON, so nothing pasted into it can pose as another field.
const survey = async ($: EngineInterface, request: string, earlier: string[], previous?: Gear, model: 'sonnet' | 'haiku' = 'sonnet') => {
  const r = await $.model.complete({
    model,
    system: SURVEY,
    prompt: JSON.stringify({ request: trimRequest(request), earlier, previous: previous ?? null }),
    effort: 'low',
    // No cap on the answer: a reply that stops mid-correction is unreadable, and a read costs little.
    maxTokens: 64_000,
    timeoutMs: 30_000,
  })
  $.ui.log(`gearbox survey: ${r.isAnswered ? r.text.trim() : `no reply (${r.reason})`}`, { to: 'debug' })
  return { reading: r.isAnswered ? readReading(r.text) : undefined, reply: r.isAnswered ? r.text.trim() : `no reply (${r.reason})` }
}

// A subagent's effort by its job, read as a prompt is: browsing and long commands run low, code at the coding
// effort, questions and searches by depth. Undefined when the read fails: the call goes as it was.
const jobEffort = async ($: EngineInterface, brief: string, standing: ModelEffort): Promise<ModelEffort | undefined> => {
  const { reading: r } = await survey($, brief, [], undefined, 'haiku')
  if (!r) return undefined
  return r.mode === 'drive' || r.mode === 'wait' ? 'low' : gearFor({ ...r, ask: {} }, standing).effort
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
    $.ui.log(`log not written: ${err}`, { to: 'debug' })
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
    $.ui.log(`couldn't ask, so ${label(cheaper)}`, { to: 'debug' })
    return cheaper
  }
}

// A fan-out's parts as the turn hands them out: a costly part's gear goes to the person as a route step's does; then
// each model's lane, where it is idle and worth going back to, takes the first part of its model. `fresh`: unrelated
// work, which goes back to no lane.
const seatFan = async ($: EngineInterface, fan: readonly FanPart[], o: { asks: boolean; ask: Partial<Gear>; previous?: Gear; standing: ModelEffort; lanes: Lanes; fresh: boolean }): Promise<Handoff> => {
  const parts: FanPart[] = []
  for (const pt of fan) parts.push(o.asks && needsConsent(pt.gear, o.ask, o.previous, o.standing) ? { ...pt, gear: await consent($, pt.gear) } : pt)
  const loops = await read($, LOOPS)
  const seated = seatParts(parts, o.lanes, Date.now(), id => loops[id]?.state === 'working', o.fresh)
  return { kind: 'fan', gear: (seated.find(pt => pt.resume || pt.lane) ?? seated[0]!).gear, parts: seated }
}

type Ledger = Record<string, { calls: number; fresh: number; written: number; cached: number; out: number }>

let pending: Promise<unknown> = Promise.resolve()
// Subagent steps can end together, so the ledger is updated one step at a time and none is lost.
// shortcut: two Claude processes writing at once can still drop a step; fine for an estimate.
const tally = ($: EngineInterface, u: TurnUsage) =>
  (pending = pending
    .then(async () => {
      const ledger = ((await $.store.get('usage')) ?? {}) as Ledger
      const prompt = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens
      const key = u.model.includes('haiku') && prompt > 100_000 ? `${u.model}${LONG_ROW}` : u.model
      const row = (ledger[key] ??= { calls: 0, fresh: 0, written: 0, cached: 0, out: 0 })
      row.calls += 1
      row.fresh += u.input_tokens
      row.written += u.cache_creation_input_tokens
      row.cached += u.cache_read_input_tokens
      row.out += u.output_tokens
      await $.store.set('usage', ledger)
    })
    .catch(err => $.ui.log(`usage not saved: ${err}`, { to: 'debug' })))

const dollars = (model: string, r: Ledger[string]) => {
  const p = model.endsWith(LONG_ROW) ? HAIKU_LONG : PRICES[family(model) ?? 'opus']
  return (r.fresh * p.fresh + r.written * p.written + r.cached * p.cached + r.out * p.out) / 1e6
}

export const usageReport = (ledger: Ledger) => {
  const rows = Object.entries(ledger)
  if (!rows.length) return 'nothing used yet'
  const lines = rows.map(([m, r]) => `${m}  ${r.calls} calls  ${kilo(r.fresh + r.written + r.cached)} in  ${kilo(r.out)} out  ≈ $${dollars(m, r).toFixed(2)}`)
  const total = rows.reduce((sum, [m, r]) => sum + dollars(m, r), 0)
  return [...lines, `total ≈ $${total.toFixed(2)} at API list prices, subagents included`].join('\n')
}

const CODE_EFFORTS: readonly ModelEffort[] = ['medium', 'high', 'xhigh', 'max']
// Typed agents that only search or plan: work handed up never takes them over.
const SEARCHERS = /^(Explore|Plan|claude-code-guide|statusline-setup)$/

export type LogMode = 'off' | 'on' | 'full'
export type Settings = { code_effort: ModelEffort; steer: boolean; escalate: Escalate; navigator: 'haiku' | 'sonnet'; strict: boolean; log: LogMode; pane: 'all' | 'running'; band: boolean } & OrchestratorSettings

// The person's settings: what /gearbox set (kept in the store) wins over the plugin's options, which not
// every Claude Code screen lets a person edit.
export const settingsFrom = (options: PluginOptions, stored: unknown): Settings => {
  const o: Record<string, unknown> = { ...options, ...(stored && typeof stored === 'object' ? stored : {}) }
  return {
    code_effort: CODE_EFFORTS.includes(o.code_effort as ModelEffort) ? (o.code_effort as ModelEffort) : 'xhigh',
    steer: o.steer !== false,
    escalate: ESCALATES.includes(o.escalate as Escalate) ? (o.escalate as Escalate) : 'on',
    navigator: o.navigator === 'haiku' ? 'haiku' : 'sonnet',
    strict: o.strict !== false,
    log: o.log === 'on' || o.log === 'full' ? o.log : 'off',
    pane: o.pane === 'running' ? 'running' : 'all',
    band: o.band !== false,
    ...orchestratorFrom(o),
  }
}

// One `/gearbox <setting> <value>`; undefined when the value is not one the setting takes.
export const settingPatch = (word: string, value: string | undefined): Partial<Settings> | undefined => {
  if (word === 'effort' && CODE_EFFORTS.includes(value as ModelEffort)) return { code_effort: value as ModelEffort }
  if (word === 'navigator' && (value === 'haiku' || value === 'sonnet')) return { navigator: value }
  if (word === 'steer' && (value === 'on' || value === 'off')) return { steer: value === 'on' }
  if (word === 'escalate' && ESCALATES.includes(value as Escalate)) return { escalate: value as Escalate }
  if (word === 'strict' && (value === 'on' || value === 'off')) return { strict: value === 'on' }
  if (word === 'log' && (value === 'on' || value === 'off' || value === 'full')) return { log: value }
  if (word === 'pane' && (value === 'all' || value === 'running')) return { pane: value }
  if (word === 'band' && (value === 'on' || value === 'off')) return { band: value === 'on' }
  return orchestratorPatch(word, value)
}

const SETTING_CHOICES: Record<string, string> = { effort: 'medium, high, xhigh or max', navigator: 'sonnet or haiku', steer: 'on or off', escalate: 'on, code or off', strict: 'on or off', log: 'on, off or full', band: 'on or off', orchestrator: 'on or off', 'orchestrator-model': 'haiku, sonnet or opus', 'orchestrator-effort': 'low, medium, high, xhigh or max', 'orchestrator-agents': 'a number from 1 to 6 (1: no fan-out)' }
const settingsText = (s: Settings) =>
  `coding effort ${s.code_effort} · navigator ${s.navigator} · steer ${s.steer ? 'on' : 'off'} · escalate ${s.escalate} · strict hand-offs ${s.strict ? 'on' : 'off'} · log ${s.log} · band ${s.band ? 'on' : 'off'} · orchestrator ${s.orchestrator ? `on (${s.orchestrator_model}·${s.orchestrator_effort}, up to ${s.orchestrator_agents} agent${s.orchestrator_agents === 1 ? '' : 's'} at once)` : 'off'}`

const loadSettings = async ($: EngineInterface, options: PluginOptions) => settingsFrom(options, await $.store.get('settings'))

// The settings that differ from those in force, at their new values.
export const settingsChanged = (was: Settings, now: Settings): Partial<Settings> =>
  Object.fromEntries(Object.entries(now).filter(([k, v]) => was[k as keyof Settings] !== v)) as Partial<Settings>

// The session's agents as the engine lists them, forked skills included; undefined when it cannot say.
const listAgents = async ($: EngineInterface): Promise<AgentInfo[] | undefined> => {
  try {
    return await $.agent.list()
  } catch {
    return undefined
  }
}
// A session on Haiku: gearbox shifts its models.
const onHaiku = async ($: EngineInterface) => (await $.session.model()).includes('haiku')

// A reviewing skill the model called, with the effort of the turn's own work, until the loop it forked is known.
type SkillCall = { skill: string; args: string; useId?: string; effort: ModelEffort }
// A known fork of one: how it was told (the Skill tool's answer, the agents' listing, or, as a fallback, the first
// agent the listing does not know), and whether its re-gearing is logged yet.
type SkillFork = { call: SkillCall; match: 'result' | 'listed' | 'fallback'; logged?: boolean }

const saveSetting = async ($: EngineInterface, patch: Partial<Settings>) => {
  const stored = ((await $.store.get('settings')) ?? {}) as Partial<Settings>
  await $.store.set('settings', { ...stored, ...patch })
  await update($, SETTINGS, held => ({ ...held, ...patch }))
}


export const register: Register = (on, options) => {
  // The person's settings (userConfig): effort for ordinary coding turns, and whether non-Haiku sessions are steered.
  let { code_effort: standing, steer: steers, escalate, navigator, strict, log: logMode, orchestrator, orchestrator_model: orchModel, orchestrator_effort: orchEffort, orchestrator_agents: orchAgents } = settingsFrom(options, undefined)
  let paneShows: Settings['pane'] = 'all'
  let bandOn = true
  const current = (): Settings => ({ code_effort: standing, steer: steers, escalate, navigator, strict, log: logMode, pane: paneShows, band: bandOn, orchestrator, orchestrator_model: orchModel, orchestrator_effort: orchEffort, orchestrator_agents: orchAgents })
  // The debug log of this session; see /gearbox log.
  const log: LogState = { pending: [] }
  const logEvent = (rec: Record<string, unknown>) => {
    if (logMode !== 'off') log.pending.push(JSON.stringify({ t: Date.now(), ...rec }))
  }
  const apply = (s: Settings) => {
    standing = s.code_effort
    steers = s.steer
    escalate = s.escalate
    navigator = s.navigator
    strict = s.strict
    logMode = s.log
    paneShows = s.pane
    bandOn = s.band
    orchestrator = s.orchestrator
    orchModel = s.orchestrator_model
    orchEffort = s.orchestrator_effort
    orchAgents = s.orchestrator_agents
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
  let turnLong = false // the turn started on a long conversation
  let readStreak = 0 // main requests in a row this turn that only read
  let scoutedAt: number | undefined // when Haiku last took a main request: its cache of the conversation lasts an hour
  let turnText = '' // the person's prompt of the turn under way
  // Deep work goes on where it started: `lastDeep` is the gear of the last typed turn's deep hand-off (a nod or a
  // continuation carries it on), `deepAgent` the agent that took it, which follow-ups go back to while worth it.
  let lastDeep: Gear | undefined
  let deepAgent: DeepAgent | undefined
  // The Agent call of a deep or handed-up step, by its tool_use_id: the agent it starts becomes `deepAgent`.
  let spawningDeep: { useId?: string; gear: Gear } | undefined
  let deepReads = 0 // reads the main model made this turn while deep work waits for its agent
  // The orchestrator's lanes: one long-lived agent per model, which jobs go back to while worth it. `laneEffort` is
  // the effort of the job each agent gearbox started at the top effort is on (a lane, or a fan-out's part): every
  // message lowers it to that.
  let lanes: Lanes = {}
  const laneEffort = new Map<string, ModelEffort>()
  // The models whose lane an agent of this turn took or was sent: any other plain agent of that model started this
  // turn, even in the same message, is a fresh agent for the turn only.
  let laneTaken = new Set<Model>()
  // The reading of the turn's prompt, with the asks its words bear out: what the fan tool splits parts on.
  let turnReading: Reading | undefined
  // Agent calls whose agent is about to start, by tool_use_id, so several started in one message each get their
  // own job: its gear, whether the agent becomes its model's lane, and the fan-out part it is. A call that carries no
  // id waits under a key of its own, and the first spawn no id claims takes it.
  const spawningLanes = new Map<string, { gear: Gear; lane: boolean; part?: number }>()
  let unnamed = 0
  const expectSpawn = (useId: string | undefined, job: { gear: Gear; lane: boolean; part?: number }) => spawningLanes.set(useId ?? `\u0000${unnamed++}`, job)
  const claimSpawn = (useId: string | undefined) => {
    const key = useId !== undefined && spawningLanes.has(useId) ? useId : [...spawningLanes.keys()].find(k => k.startsWith('\u0000'))
    const job = key === undefined ? undefined : spawningLanes.get(key)
    if (key !== undefined) spawningLanes.delete(key)
    return job
  }
  let mainMayEdit = false // the orchestrator's turn is a one-spot change it makes itself
  // Forked skills: a skill that forks runs in a loop of its own on the session's model and effort, which no
  // agent.spawn announces, so a reviewing skill's fork is re-geared on each of its requests instead. `turnWant` is
  // what the rules gave this turn's prompt; `skillCalls` the reviewing skills called whose fork is not known yet;
  // `skillForks` the forks known, by agent id; `notForks` the agents looked up that are none.
  let turnWant: Gear | undefined
  let skillCalls: SkillCall[] = []
  const skillForks = new Map<string, SkillFork>()
  const notForks = new Set<string>()
  const laneOf = (id: string): (Lane & { model: Model }) | undefined => {
    const model = (Object.keys(lanes) as Model[]).find(m => lanes[m]?.id === id)
    return model ? { ...lanes[model]!, model } : undefined
  }
  // The browser check or long command under way that a subagent should be doing, if any.
  // The hand-off the next plain Agent call belongs to: the step marked with phase if it is a subagent step,
  // else the first subagent step not yet started; a single-hand-off turn has its one.
  // A fan-out's: the part the call's description names ("part 2: ..."), else the first part not started, those a
  // lane takes by SendMessage last.
  const nextHandoff = (description?: string): { gear: Gear; slot: number } | undefined => {
    if (turnHandoff?.kind === 'fan') {
      const parts = turnHandoff.parts ?? []
      const open = (k: number) => k >= 0 && k < parts.length && !handedOff.has(k)
      const named = Number(/^\s*part\s+(\d)\b/i.exec(description ?? '')?.[1] ?? 0) - 1
      const first = parts.findIndex((p, k) => open(k) && !p.resume)
      const slot = open(named) ? named : first >= 0 ? first : parts.findIndex((_, k) => open(k))
      return slot >= 0 ? { gear: parts[slot]!.gear, slot } : undefined
    }
    if (turnRoute) {
      const marked = turnStep && turnRoute[turnStep - 1]?.by === 'agent' && !handedOff.has(turnStep - 1) ? turnStep - 1 : -1
      const slot = marked >= 0 ? marked : turnRoute.findIndex((s, k) => s.by === 'agent' && !handedOff.has(k))
      return slot >= 0 ? { gear: turnRoute[slot]!.gear, slot } : undefined
    }
    if (turnHandoff && !handedOff.has(-1)) return { gear: turnHandoff.gear, slot: -1 }
    // A browser check judged by a stronger model: its second subagent.
    return turnHandoff?.judge && !handedOff.has(-2) ? { gear: turnHandoff.judge, slot: -2 } : undefined
  }
  // A hand-off slot whose subagent takes the main model's own work on a stronger model: deep work, a route's
  // handed-up step, or the judge of a browser check. `keeps`: its agent is the one later follow-ups go back to.
  const upSlot = (slot: number): { keeps: boolean } | undefined => {
    if (turnRoute) {
      const s = turnRoute[slot]
      return s && escalated(s) ? { keeps: s.mode !== 'analyze' } : undefined
    }
    return slot === -1 && turnHandoff?.kind === 'deep' ? { keeps: true } : slot === -2 ? { keeps: false } : undefined
  }
  // The gear of the hand-off step under way, for the refusal that points the model at it.
  const handoffGear = (): Gear | undefined =>
    turnRoute ? (turnStep ? turnRoute[turnStep - 1]?.gear : undefined) : turnHandoff?.gear
  const handoffMode = (): 'drive' | 'wait' | 'chore' | undefined => {
    if (turnRoute) {
      const s = turnStep ? turnRoute[turnStep - 1] : undefined
      return s?.by !== 'agent' ? undefined : s.mode === 'drive' || s.mode === 'wait' ? s.mode : s.mode === 'commit' ? 'chore' : undefined
    }
    return turnHandoff?.kind === 'drive' || turnHandoff?.kind === 'wait' || turnHandoff?.kind === 'chore' ? turnHandoff.kind : undefined
  }
  // Work owed to a stronger model's agent that has not started yet: the turn's deep hand-off, or the route step
  // under way when it is one that goes up.
  const deepPending = (): boolean => {
    if (turnRoute) {
      const s = turnStep ? turnRoute[turnStep - 1] : undefined
      return !!s && escalated(s) && !handedOff.has(turnStep! - 1)
    }
    if (turnHandoff?.kind === 'fan') return fanOwed() > 0
    return (turnHandoff?.kind === 'deep' || turnHandoff?.kind === 'lane') && !handedOff.has(-1)
  }
  // A fan-out's parts whose agent has not started yet.
  const fanOwed = (): number => (turnHandoff?.kind === 'fan' ? (turnHandoff.parts ?? []).filter((_, k) => !handedOff.has(k)).length : 0)
  const stepLabel = (): string | undefined =>
    ownEffort ? `${ownEffort} sets its own effort` : routeLabel()
  const routeLabel = () => (turnRoute && turnStep ? `step ${turnStep}/${turnRoute.length} ${turnRoute[turnStep - 1]!.what}` : undefined)
  const warmScout = () => scoutedAt !== undefined && Date.now() - scoutedAt < SCOUT_WARM_MS
  const forget = () => {
    floor = previous = turnGear = turnHandoff = turnRoute = turnStep = ownEffort = scoutedAt = undefined
    lastDeep = deepAgent = spawningDeep = undefined
    spawningLanes.clear()
    mainMayEdit = false
    lanes = {}
    laneEffort.clear()
    laneTaken = new Set()
    turnReading = undefined
    handedOff = new Set()
    turnLong = false
    turnWant = undefined
    skillCalls = []
    skillForks.clear()
    notForks.clear()
  }
  // A reviewing skill the model calls, in any loop, while gearbox routes the session: remembered until its fork is
  // known. The Skill tool's answer names a fork's agent, but the fork may send its first request before that answer
  // is back, so it is remembered first.
  const callSkill = async <R,>(e: { skill?: unknown; args?: unknown; tool_use_id?: string }, routed: boolean, run: () => Promise<R>): Promise<R> => {
    const skill = String(e.skill ?? '')
    if (!reviews(skill) || !routed) return run()
    const call: SkillCall = { skill, args: String(e.args ?? ''), useId: e.tool_use_id, effort: turnWant?.effort ?? 'medium' }
    skillCalls.push(call)
    const done = await run()
    const answer = done as { deny?: string; isError?: boolean; result?: { status?: string; agentId?: string } }
    const fork = answer.result?.status === 'forked' ? answer.result.agentId : undefined
    // Refused, failed or run inline: no fork comes. An answer of another shape leaves the call to the listing.
    if (answer.deny || answer.isError || answer.result?.status === 'inline' || fork) skillCalls = skillCalls.filter(c => c !== call)
    if (fork) {
      // The answer is the surest word: an agent taken for this call on a guess gives way to it.
      for (const [id, f] of skillForks) if (f.call === call && id !== fork) skillForks.delete(id)
      if (!skillForks.has(fork)) skillForks.set(fork, { call, match: 'result' })
    }
    return done
  }
  // The fork an agent's loop is, if any: known already, or looked up in the agents' listing while a reviewing skill
  // waits for its fork. An agent the listing does not know at all is taken for the oldest such fork (a fallback).
  const skillFork = async (id: string, list: () => Promise<AgentInfo[] | undefined>): Promise<SkillFork | undefined> => {
    const known = skillForks.get(id)
    if (known || !skillCalls.length || notForks.has(id)) return known
    const row = (await list())?.find(a => a.id === id)
    const call = row ? skillCalls.find(c => isSkillFork(row, c.skill)) : skillCalls[0]
    if (!call) {
      notForks.add(id)
      return undefined
    }
    skillCalls = skillCalls.filter(c => c !== call)
    const fork: SkillFork = { call, match: row ? 'listed' : 'fallback' }
    skillForks.set(id, fork)
    return fork
  }

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'phase',
      description: 'gearbox: call with a step number from the gearbox route as you start that step; gearbox sets your effort for it.',
      inputSchema: { type: 'object', properties: { step: { type: 'integer', minimum: 1 } }, required: ['step'] },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'fan',
      description:
        'gearbox: with the orchestrator on, call this BEFORE starting agents whenever the work you are about to do or hand to a lane splits into independent pieces (separate services, repos, pull requests, investigations, reviews by angle) that do not need each other\'s results and do not edit the same files. Pass the pieces as parts; it answers how many agents to start, with which models, and how. Do not call it for sequential work, where a step needs an earlier one\'s result.',
      inputSchema: {
        type: 'object',
        properties: {
          parts: {
            type: 'array',
            minItems: 1,
            maxItems: 6,
            items: {
              type: 'object',
              properties: {
                what: { type: 'string', description: 'the piece, in a few words' },
                mode: { type: 'string', enum: ['code', 'answer', 'review', 'wait', 'lookup'], description: 'code: changes files; answer: explains or investigates; review: looks a change over; wait: one long command (build, deploy, test run); lookup: fetches a ticket, page or docs' },
                depth: { type: 'integer', minimum: 0, maximum: 3, description: '0 mechanical, 1 ordinary, 2 subtle, 3 exceptionally hard' },
                files: { type: 'array', items: { type: 'string' }, description: 'the files, folders or repos it touches' },
              },
              required: ['what', 'mode', 'depth'],
            },
          },
        },
        required: ['parts'],
      },
      isDeferred: false,
    })
    await $.command.register({ name: 'gearbox', description: 'Model routing and readout: /gearbox [settings | effort <level> | navigator <model> | steer on|off | escalate on|code|off | strict on|off | orchestrator on|off | orchestrator-model <model> | orchestrator-effort <level> | orchestrator-agents <1-6> | pane | on | off | ask on|off | usage]' })
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
      await update($, TURN, () => ({ requests: {}, costs: [] }))
    }
    logEvent({ ev: 'end', reason: e.reason })
    await flushLog($, log)
    return next(e)
  })

  // Claude Code shows a command's reply under the plugin's name, so the replies do not repeat it.
  on('command.run', { command: 'gearbox' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    apply(await loadSettings($, options))
    const [word = '', value] = arg.split(/\s+/)
    if (arg === 'log') {
      if (logMode === 'off') return { text: 'the log is off. /gearbox log on starts one for this session; /gearbox log full also keeps the first 200 characters of each prompt.' }
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
            ? 'settings open. Press a value to use it; Esc closes.'
            : `${settingsText(current())}. The settings panel has no room here; set one with /gearbox effort|navigator|steer|strict <value>.`,
        }
      }
      const change = settingPatch(word, value)
      if (!change) return { text: `${word} takes ${SETTING_CHOICES[word]}` }
      const wasLogging = logMode !== 'off'
      await saveSetting($, change)
      apply(await loadSettings($, options))
      if (!wasLogging && logMode !== 'off') {
        logEvent({ ...(await sessionFacts($, options)), settings: current() })
        await flushLog($, log)
      }
      return { text: `${settingsText(current())} (from your next prompt)` }
    }
    if (word === 'pane' || word === 'panel') {
      // /gearbox panel (or pane) running|all also sets what the pane lists, then opens it.
      if (value) {
        const change = settingPatch('pane', value)
        if (!change) return { text: 'pane takes running or all' }
        await saveSetting($, change)
        apply(await loadSettings($, options))
      }
      const { isPlaced } = await $.ui.open({ id: PANE, title: 'gearbox: models now' })
      return { text: isPlaced ? 'pane open' : 'the pane opens once the window has room for it' }
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
      return { text: 'usage cleared' }
    } else if (arg) {
      return { text: `unknown "${arg}". Try settings, panel, effort, navigator, steer, escalate, strict, log, band, orchestrator, orchestrator-model, orchestrator-effort, orchestrator-agents, on, off, ask on, ask off, usage or usage reset.` }
    }
    const asks = (await $.store.get('consent')) !== false
    const session = await $.session.model()
    const mode = session.includes('haiku') ? 'shifting models' : steers ? `steering effort on ${family(session) ?? session}` : 'readout only'
    return {
      text: `${enabled ? `on, ${mode}` : 'off'} · ${settingsText(current())} · asks before costly gears: ${asks ? 'yes' : 'no'}${floor ? ` · main model ${floor}` : ''}${previous ? ` · last gear ${label(previous)}` : ''}\nChange settings with /gearbox settings, or /gearbox effort|navigator|steer <value>.`,
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.turnId) return next(e) // typed into a running turn, which keeps its gear
    // A slash command or skill owns its turn's effort (its frontmatter, or Claude Code's own): no leftover gear.
    if (enabled && e.command && typedByPerson(e.origin)) {
      turnGear = turnHandoff = turnRoute = turnStep = turnWant = turnReading = undefined
      handedOff = new Set()
      laneTaken = new Set()
      skillCalls = []
      ownEffort = `/${e.command.name}`
      logEvent({ ev: 'prompt', kind: 'command', command: e.command.name, gear: 'its own effort' })
      await startTurnTally($)
      await setWhy($, [`/${e.command.name}`, 'sets its own effort'])
      return next(e)
    }
    // A notification (say, a route's subagent finishing) keeps the turn's gear and route.
    if (!enabled || e.command || e.isMeta || !typedByPerson(e.origin)) {
      if (enabled && !e.command) logEvent({ ev: 'prompt', kind: e.origin?.kind ?? 'meta', keeps: turnGear ? label(turnGear) : 'no gear' })
      return next(e)
    }
    // A deep hand-off the last turn's model never started: what to count before tuning when work goes up.
    if (turnHandoff?.kind === 'deep' && !handedOff.has(-1)) logEvent({ ev: 'skipped', handoff: handoffLabel(turnHandoff) })
    // A fan-out some of whose agents the last turn's model never started.
    if (turnHandoff?.kind === 'fan' && fanOwed()) logEvent({ ev: 'skipped', handoff: handoffLabel(turnHandoff), owed: fanOwed() })
    turnGear = turnHandoff = turnRoute = turnStep = turnWant = turnReading = undefined
    handedOff = new Set()
    laneTaken = new Set()
    spawningLanes.clear()
    skillCalls = []
    turnText = e.text
    deepReads = 0
    // "ultrathink" in the person's own words raises this turn's effort in Claude Code; gearbox leaves it be.
    ownEffort = /\bultrathink\b/i.test(ownWords(e.text)) ? 'ultrathink' : undefined
    // Settings changed outside /gearbox (the settings panel, another session) take hold here.
    const loaded = await loadSettings($, options)
    const changed = settingsChanged(current(), loaded)
    apply(loaded)
    if (Object.keys(changed).length) logEvent({ ev: 'settings', changed })
    await startTurnTally($)
    // A Haiku session shifts models; any other keeps its model and is only steered (effort and handoffs).
    const session = await $.session.model()
    const shifting = session.includes('haiku')
    const fixed = shifting ? undefined : family(session)
    logEvent({ ev: 'prompt', kind: ownEffort ?? 'typed', chars: e.text.length, ...(logMode === 'full' ? { text: e.text.slice(0, 200) } : {}), session })
    if (!orchestrator && !shifting && (!steers || !fixed)) {
      logEvent({ ev: 'gear', gear: 'untouched', why: 'steer is off for sessions not on Haiku' })
      await setWhy($, ['untouched', 'steer is off'])
      return next(e)
    }
    const base = fixed ?? floor
    // A long conversation hands git chores to a fresh subagent: every request here re-reads the whole context.
    const context = (await $.session.usage()).context.tokens ?? 0
    const long = context >= LONG_CONTEXT
    turnLong = long
    let why = ''
    let brief: [string, string] = ['', '']

    let p: Plan
    let ask: Partial<Gear> = {}
    let lastMode: Reading['mode'] | undefined // what the survey read this turn as
    // Deep work goes on in the agent that holds it while that is worth it (its cache warm, its context not
    // yet past a fresh brief's), else in a fresh one on the same gear: never quietly back on this model.
    // With the orchestrator on, the agent is the model's lane; Fable's work is never a lane, always a fresh agent.
    const orchGear: Gear = { model: orchModel, effort: orchEffort }
    const sameAgent = (g: Gear) =>
      orchestrator && g.model !== 'fable'
        ? laneResumable(lanes[g.model], Date.now()) ? { resume: lanes[g.model]!.id } : {}
        : resumable(deepAgent, Date.now()) && deepAgent.gear.model === g.model ? { resume: deepAgent.id } : {}
    const goesOn = lastDeep && !(fixed && escalate === 'off' && !orchestrator) ? lastDeep : undefined
    const goOn = (g: Gear): Plan => ({
      main: orchestrator ? orchGear : { model: base ?? STARTER.model, effort: BRIEFING },
      handoff: { kind: orchestrator && g.model !== 'fable' ? 'lane' : 'deep', gear: g, ...sameAgent(g) },
    })
    if (goesOn && NOD.test(e.text.trim())) {
      p = goOn(goesOn)
      why = 'nod after deep work: it goes on in the subagent'
      brief = ['nod', 'deep work goes on']
    } else if (previous && NOD.test(e.text.trim())) {
      // A nod after a proposal is usually the go-ahead to write it: never below the coding effort.
      p = { main: { ...previous, effort: upTo(EFFORTS, previous.effort, everyday(standing)) } }
      why = 'nod: the last work gear, at least your coding effort'
      brief = ['nod', 'last gear, at least your coding effort']
    } else {
      const earlier = await recentAsks($)
      const started = Date.now()
      const { reading: r, reply } = await survey($, e.text, earlier, previous)
      logEvent({ ev: 'survey', ms: Date.now() - started, reply, reading: r ?? null })
      turnReading = r && { ...r, ask: verifyAsk(r.ask, e.text) }
      // Carrying on does not swallow independent parts: a continuation the plan would split fans out instead.
      const splits = !!turnReading && orchestrator && orchestratorPlan(turnReading, gearFor(turnReading, standing), orchGear, orchAgents, standing).handoff?.kind === 'fan'
      if ((!r || r.cont) && goesOn && !splits) {
        // Carrying on deep work, or unreadable right after it (a failed read errs up): the same hand-off.
        p = goOn(goesOn)
        why = `${r ? 'continuation' : 'survey unreadable'} after deep work: it goes on in the subagent`
        brief = [r ? 'continuation' : 'unreadable', 'deep work goes on']
      } else if (!r) {
        // Unreadable: the last gear, never below the person's coding effort; a failed read errs up.
        p = { main: previous ? { ...previous, effort: upTo(EFFORTS, previous.effort, everyday(standing)) } : { model: fixed ?? STARTER.model, effort: everyday(standing) } }
        why = `survey unreadable: ${previous ? 'previous gear, at least your coding effort' : 'your coding effort'}`
        brief = ['unreadable', previous ? 'last gear, at least your coding effort' : 'your coding effort']
      } else if (r.cont && previous && !splits) {
        p = { main: previous }
        why = 'continuation: previous gear'
        brief = ['continuation', 'kept the previous gear']
      } else {
        why = `survey: ${r.mode}, ${r.reach}, depth ${r.depth}${r.care === 'costly' ? ', costly' : ''}${r.sure ? '' : r.mode === 'review' ? ' (unsure: its best guess)' : ' (unsure: its best guess, no hand-off)'}`
        brief = [`${r.mode} · ${r.reach}`, `depth ${r.depth}${r.care === 'costly' ? ' · costly' : ''}${r.sure ? '' : ' · unsure'}`]
        ask = verifyAsk(r.ask, e.text)
        lastMode = r.mode
        const checked = { ...r, ask }
        const asks = (await $.store.get('consent')) !== false
        let want = gearFor(checked, standing)
        // A model named for a step counts only where the person's own words say it.
        const phases = r.phases.map(ph => ({ ...ph, ask: ph.ask && verifyAsk({ model: ph.ask }, e.text).model === ph.ask ? ph.ask : undefined }))
        // The orchestrator reads a request with several steps as one piece of work for one lane.
        if (!orchestrator && r.sure && r.phases.length >= 2) {
          // Several steps: one route, each step on its own executor and effort. Fable only as a subagent.
          const lead = fixed ?? mainModel({ main: { model: want.model === 'fable' ? 'opus' : want.model, effort: want.effort } }, ask, base)
          turnRoute = route(phases, lead, standing, r.care === 'costly', navigator, long, upFor(want), escalate)
          for (const s of turnRoute) {
            if ((s.by === 'main' || escalated(s)) && asks && needsConsent(s.gear, ask, previous, standing)) {
              s.gear = await consent($, s.gear)
              if (s.by === 'main') s.mainEffort = s.gear.effort
            }
          }
          p = { main: { model: lead, effort: workEffort(turnRoute) } }
          why += `; route of ${turnRoute.length} steps, starting at its work effort`
          brief = [`route · ${turnRoute.length} steps`, `starts at ${workEffort(turnRoute)}`]
        } else {
          if (asks && needsConsent(want, ask, previous, standing)) {
            const proposed = label(want)
            want = await consent($, want)
            why += `; you chose ${label(want)} over ${proposed}`
          }
          // Unsure: its best guess for the effort, but nothing handed off on a guess; a review is handed off all the same.
          p = orchestrator ? orchestratorPlan(checked, want, orchGear, orchAgents, standing) : plan(checked, want, base, earlier.length > 0, fixed, navigator, long, escalate)
          // More of the same work: back to the agent that holds it. Unrelated work starts clean.
          if ((p.handoff?.kind === 'deep' || p.handoff?.kind === 'lane') && !r.aside) p = { ...p, handoff: { ...p.handoff, ...sameAgent(p.handoff.gear) } }
          if (orchestrator && r.parts.length) {
            const groups = fanOut(r.parts, orchAgents)
            logEvent({ ev: 'fan', parts: r.parts, cap: orchAgents, kept: p.handoff?.kind === 'fan' ? (p.handoff.parts?.length ?? 0) : 0, merged: groups.filter(g => g.length > 1).map(g => g.map(pt => pt.what).join(' + ')) })
          }
          // A fan-out: a costly part's gear goes to the person as a route step's does; then each model's lane, where it
          // is idle and worth going back to, takes the first part of its model. A nod goes back to the first part a
          // lane takes.
          if (p.handoff?.kind === 'fan') p = { ...p, handoff: await seatFan($, p.handoff.parts ?? [], { asks, ask, previous, standing, lanes, fresh: r.aside }) }
          // A turn the orchestrator keeps still hands out its lookups, long commands and browser checks: a route
          // whose other steps it does itself, at its own gear.
          if (orchestrator && keepsRoute(checked, p)) {
            const own: Gear = { model: ask.model ?? orchModel, effort: ask.effort ?? orchEffort }
            turnRoute = orchestratorRoute(route(phases, own.model, standing, r.care === 'costly', navigator, long, own.model, escalate), own)
            why += `; route of ${turnRoute.length} steps, the rest here at ${label(own)}`
            brief = [`route · ${turnRoute.length} steps`, `the rest at ${label(own)}`]
          }
          if (ask.model || ask.effort) why += `; you asked for ${[ask.model, ask.effort].filter(Boolean).join(' ')}`
        }
        turnWant = want
      }
    }
    // The orchestrator's main conversation runs on its own model, whatever the session or the floor.
    // A person's ask moves the turn only when it stays here; with a lane doing the work the orchestrator is the same.
    turnGear = orchestrator
      ? p.handoff ? orchGear : { model: ask.model ?? orchModel, effort: ask.effort ?? orchEffort }
      : { model: mainModel(p, ask, base), effort: p.main.effort }
    // The orchestrator edits files itself only for a one-spot change the plan kept here.
    mainMayEdit = orchestrator && !p.handoff && lastMode === 'code'
    // What a nod, a notification or an unreadable prompt reuses: the gear of the work itself, never the low
    // effort of a turn that only briefs a subagent.
    if (!p.handoff || !previous) previous = turnGear
    turnHandoff = p.handoff
    lastDeep = p.handoff?.kind === 'deep' || p.handoff?.kind === 'lane' || p.handoff?.kind === 'fan' ? p.handoff.gear : undefined
    logEvent({
      ev: 'gear',
      gear: label(turnGear),
      context,
      why: ownEffort ? `${why}; ultrathink: Claude Code sets the effort` : why,
      ...(p.handoff ? { handoff: handoffLabel(p.handoff) } : {}),
      ...(turnRoute ? { route: turnRoute.map((s, i) => `${i + 1}. ${s.what}: ${s.by} ${label(s.gear)}`) } : {}),
    })
    if (p.handoff) brief = [brief[0], `${brief[1]} · ${handoffLabel(p.handoff)}`]
    await setWhy($, ownEffort ? ['ultrathink', 'Claude Code sets the effort'] : brief)
    const note = turnRoute ? routeNote(turnRoute) : p.handoff ? handoffNote(p.handoff) : undefined
    return next(note ? { ...e, context: [...(e.context ?? []), note] } : e)
  })

  // The route's phase tool: the main model calls it as each step starts, and later steps run at that step's effort.
  // The orchestrator's main conversation stays at its own gear throughout.
  on('tool.call', { tool: 'mcp__gearbox__phase' }, async ($, e) => {
    const n = Number((e as any).input?.step ?? (e as any).step)
    const s = turnRoute?.[n - 1]
    if (!s || !turnGear) return { result: 'gearbox: no route step with that number in this turn', isError: true as const }
    if (!orchestrator) turnGear = { ...turnGear, effort: s.mainEffort }
    turnStep = n
    logEvent({ ev: 'phase', step: n, what: s.what, by: s.by, effort: s.mainEffort })
    await setWhy($, [`route ${n}/${turnRoute!.length}`, `${s.what} · ${s.by === 'agent' ? label(s.gear) : s.mainEffort}`])
    await showStatus($, undefined, stepLabel())
    // A tool's result is a string (or content blocks), never an object.
    return { result: s.by === 'agent' ? `step ${n}: hand it to a ${s.gear.model} subagent at ${s.gear.effort}` : `step ${n}: you now run at effort ${s.mainEffort}` }
  })

  // The fan tool: the main conversation names the independent pieces it found, once the work is known, and gearbox
  // splits them as it would a survey's parts, on this turn's reading and the cap now set. Agents of the turn that
  // have started keep their work: a late call changes nothing.
  on('tool.call', { tool: 'mcp__gearbox__fan' }, async ($, e) => {
    const say = (text: string) => ({ result: text })
    if (!enabled || !orchestrator) return say('gearbox: the orchestrator is off, so gearbox splits nothing here; start agents as you see fit.')
    if (e.agentId) return say('gearbox: only the main conversation splits work; carry on with your own brief.')
    const parts = readParts((e as any).input?.parts ?? (e as any).parts)
    if (!parts.length) return { result: 'gearbox: no usable parts: each needs what, a mode (code, answer, review, wait or lookup) and a depth from 0 to 3.', isError: true as const }
    if (handedOff.size) return say("gearbox: this turn's agents have already started, and a split now would reshuffle running work. Let them finish; split the next piece of work when it comes.")
    if (turnRoute) return say('gearbox: this turn is a route of steps one after another, and a split inside a step is not supported yet. Follow the route.')
    if (turnHandoff?.kind === 'deep') return say('gearbox: open-ended work goes to one Fable agent and is never split. Start it as the hand-off note says.')
    const r: Reading = { ...(turnReading ?? NEUTRAL), parts }
    const fan = fanParts(r, orchAgents, standing)
    const merged = fanOut(parts, orchAgents).filter(g => g.length > 1).map(g => g.map(pt => pt.what).join(' + '))
    if (!fan.length) {
      const why = whyNoFan(parts, orchAgents)
      logEvent({ ev: 'fan', via: 'tool', parts, cap: orchAgents, kept: 0, merged, why })
      return say(`gearbox: not worth splitting: ${why}. Go on with it as one piece of work${turnHandoff ? ', as the hand-off note says' : ''}.`)
    }
    const handoff = await seatFan($, fan, { asks: (await $.store.get('consent')) !== false, ask: r.ask, previous, standing, lanes, fresh: r.aside })
    // The turn's hand-off is now the fan-out, as if the survey had listed these parts.
    turnHandoff = handoff
    handedOff = new Set()
    deepReads = 0
    mainMayEdit = false
    turnGear = { model: orchModel, effort: orchEffort }
    lastDeep = handoff.gear
    logEvent({ ev: 'fan', via: 'tool', parts, cap: orchAgents, kept: fan.length, merged, handoff: handoffLabel(handoff) })
    await setWhy($, ['fan-out', handoffLabel(handoff)])
    await showStatus($, handoff, stepLabel())
    return say(fanReply(handoff.parts ?? []))
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
      await patch($, started.agentId, l => ({ steps: 0, state: 'working', asked: started.model, since: Date.now(), ...l, label: e.description, parent: e.parentAgentId ?? 'main' }))
      await showStatus($, turnHandoff, stepLabel())
      // The agent a deep or handed-up step started: follow-ups go back to it.
      const deep = !e.parentAgentId && !e.resume && spawningDeep !== undefined && (spawningDeep.useId === undefined || spawningDeep.useId === e.tool_use_id)
      if (deep) {
        deepAgent = { id: started.agentId, gear: spawningDeep!.gear, at: Date.now(), tokens: 0 }
        spawningDeep = undefined
      } else if (e.resume && deepAgent?.id === e.resume.agentId) deepAgent = { ...deepAgent, at: Date.now() }
      // The agent a lane hand-off or a fan-out's part started runs on the job's effort; a lane's becomes that
      // model's lane, a part's only when the plan gave it the lane.
      const job = !e.parentAgentId && !e.resume ? claimSpawn(e.tool_use_id) : undefined
      if (job) {
        laneEffort.set(started.agentId, job.gear.effort)
        if (job.lane) lanes = { ...lanes, [job.gear.model]: { id: started.agentId, at: Date.now(), tokens: 0 } }
      }
      logEvent({ ev: 'spawn', agent: started.agentId, type: e.subagentType, model: started.model, ...(deep ? { deep: true } : {}), ...(job?.lane ? { lane: true } : {}), ...(job?.part ? { part: job.part } : {}), ...(e.resume ? { resume: true } : {}) })
    }
    return started
  })

  on('tool.call', async ($, e, next) => {
    if (!enabled) return next(e)
    await patch($, e.agentId ?? 'main', l => l && { ...l, doing: describeTool(String(e.tool), e as unknown as Record<string, unknown>) })
    // Subagents do the hand-off work; never stand in their way. A reviewing skill one calls is still remembered.
    if (e.agentId) return e.tool === 'Skill' ? callSkill(e, orchestrator || steers || (await onHaiku($)), () => next(e)) : next(e)
    // A plain Agent call during a hand-off runs on that step's model and effort, whatever the call named; any
    // other plain one keeps its model and gets an effort by its job, not the session's. Work handed up to a
    // stronger model keeps its gear even when the call names a typed agent that works (not a read-only search),
    // and its brief gets the person's own recent words under it.
    const plain = e.tool === 'Agent' && (!e.subagent_type || e.subagent_type === 'general-purpose')
    const h = e.tool === 'Agent' ? nextHandoff(String(e.description ?? '')) : undefined
    const up = h && upSlot(h.slot)
    if (e.tool === 'Agent' && h && (plain || (up && !SEARCHERS.test(String(e.subagent_type))))) {
      const asked = `${e.model ?? 'default'}·${e.effort ?? 'default'}`
      handedOff.add(h.slot)
      if (up?.keeps) spawningDeep = { useId: e.tool_use_id, gear: h.gear }
      // A lane starts at the top effort and every message lowers it to the job's. So does a fan-out's part, which
      // runs in the foreground beside the others, in a worktree of its own when two or more parts edit.
      const lane = orchestrator && !turnRoute && turnHandoff?.kind === 'lane'
      const part = orchestrator && !turnRoute && turnHandoff?.kind === 'fan' ? turnHandoff.parts?.[h.slot] : undefined
      const apart = !!part?.edits && apartEdits(turnHandoff?.parts ?? [])
      const start = lane || part ? laneStart(h.gear.effort, standing) : h.gear.effort
      if (lane || part?.lane || part?.resume) laneTaken.add(h.gear.model)
      if (lane || part) expectSpawn(e.tool_use_id, { gear: h.gear, lane: lane || !!part?.lane || !!part?.resume, ...(part ? { part: h.slot + 1 } : {}) })
      logEvent({ ev: 'agent', type: e.subagent_type ?? 'general-purpose', asked, set: label(h.gear), ...(lane || part ? { lane: start } : {}), ...(part ? { part: h.slot + 1, ...(apart ? { isolation: 'worktree' } : {}) } : {}), ...(up ? { up: true } : {}) })
      return next({
        ...e,
        model: h.gear.model,
        effort: start,
        ...(part ? { run_in_background: false, ...(apart ? { isolation: 'worktree' as const } : {}) } : {}),
        ...(up || lane || part ? { prompt: `${e.prompt ?? ''}${ownBrief(await personSaid($, turnText), !!part)}` } : {}),
      })
    }
    // The orchestrator's turn without a hand-off (a nod, an unreadable prompt): a plain agent is still that model's
    // lane, the first of its model this turn only; another beside it is a fresh agent for the turn. Past a fan-out's
    // parts it is not: it gets an effort by its job, below.
    if (orchestrator && e.tool === 'Agent' && plain && !h && turnHandoff?.kind !== 'fan') {
      const model = (family(String(e.model ?? '')) ?? 'sonnet') as Model
      if (model !== 'fable') {
        const job: Gear = { model, effort: everyday(standing) }
        const first = !laneTaken.has(model)
        laneTaken.add(model)
        expectSpawn(e.tool_use_id, { gear: job, lane: first })
        logEvent({ ev: 'agent', type: 'general-purpose', asked: `${e.model ?? 'default'}·${e.effort ?? 'default'}`, set: label(job), lane: laneStart(job.effort, standing), why: first ? 'a lane without a hand-off' : `beside the ${model} lane, for this turn only` })
        return next({ ...e, model, effort: laneStart(job.effort, standing) })
      }
    }
    if (e.tool === 'Agent' && plain) {
      const asked = `${e.model ?? 'default'}·${e.effort ?? 'default'}`
      const effort = await jobEffort($, String(e.prompt ?? e.description ?? ''), standing)
      logEvent({ ev: 'agent', type: e.subagent_type ?? 'general-purpose', asked, set: effort ? `${e.model ?? 'default'}·${effort}` : 'unchanged', why: 'its job' })
      return next(effort ? { ...e, effort } : e)
    }
    // Going back to the agent that holds deep work counts as this turn's hand-off.
    const sendTo = e.tool === 'SendMessage' ? String((e as any).to ?? '') : ''
    const lane = sendTo ? laneOf(sendTo) : undefined
    if (lane) {
      // A message to a lane is a job: set its effort before the lane's requests go out. In a fan-out the job is the
      // part the lane was given, else a part of its model not started yet.
      const parts = turnHandoff?.kind === 'fan' ? (turnHandoff.parts ?? []) : []
      const k = [parts.findIndex((p, i) => !handedOff.has(i) && p.resume === lane.id), parts.findIndex((p, i) => !handedOff.has(i) && p.gear.model === lane.model)].find(i => i >= 0)
      const job = k !== undefined ? parts[k]!.gear.effort : (handoffGear()?.effort ?? everyday(standing))
      const sent = await next(e)
      if (!('isError' in sent && sent.isError)) {
        handedOff.add(k ?? -1)
        laneTaken.add(lane.model)
        laneEffort.set(lane.id, job)
        lanes = { ...lanes, [lane.model]: { id: lane.id, at: Date.now(), tokens: lane.tokens } }
        logEvent({ ev: 'resume', agent: lane.id, lane: true, effort: job, ...(k !== undefined ? { part: k + 1 } : {}) })
      }
      return sent
    }
    if (e.tool === 'SendMessage' && deepAgent && sendTo === deepAgent.id) {
      const sent = await next(e)
      if (!('isError' in sent && sent.isError)) {
        handedOff.add(-1)
        deepAgent = { ...deepAgent, at: Date.now() }
        logEvent({ ev: 'resume', agent: deepAgent.id })
      }
      return sent
    }
    const tool = String(e.tool)
    // The orchestrator does not write code: a change goes to a lane, except the one-spot edit its plan kept here.
    if (orchestrator && strict && !mainMayEdit && !deepPending() && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
      logEvent({ ev: 'strict', tool, mode: 'orchestrator', refused: true })
      const held = laneResumable(lanes.sonnet, Date.now()) ? lanes.sonnet : undefined
      return {
        deny: `gearbox orchestrator: the main conversation does not write code. Start an Agent with no subagent_type and model "sonnet" with a brief that stands on its own${held ? ` (or SendMessage to "${held.id}", the sonnet lane that already holds this work)` : ''}; it makes the change and you review what it returns. (The person can allow doing it here with /gearbox strict off, or turn the orchestrator off with /gearbox orchestrator off.)`,
      }
    }
    // Strict: deep work is the stronger model's. Until its agent starts, the main model may read a little to write
    // the brief, but not edit, run commands or keep reading: a note alone was ignored (bench/escalation, layer B).
    if (strict && deepPending() && !BRIEFING_TOOLS.test(tool)) {
      if (!looksUp(tool, String((e as any).command ?? '')) || ++deepReads > BRIEF_READS) {
        const g = handoffGear()
        const owed = fanOwed()
        logEvent({ ev: 'strict', tool, mode: owed ? 'fan' : 'deep', refused: true, ...(owed ? { owed } : {}) })
        if (owed)
          return {
            deny: `gearbox: this request is split between ${turnHandoff?.parts?.length ?? owed} agents that run at the same time, and ${owed} of them ${owed === 1 ? 'has' : 'have'} not started yet. Start ${owed === 1 ? 'it' : 'them'} as the hand-off note says, all in one message: plain Agents (no subagent_type), each on its part's model with a brief for that part alone; they do the work, and you review what they return. Until then edits, commands and more reads are refused here. (The person can allow doing it here with /gearbox strict off.)`,
          }
        return {
          deny: `gearbox: this work is owed to an ${g?.model ?? 'opus'} agent. Start an Agent with no subagent_type, model "${g?.model ?? 'opus'}" and effort "${g?.effort ?? 'high'}", with a brief that stands on its own${turnHandoff?.resume ? ` (or SendMessage to "${turnHandoff.resume}", the agent that already holds it)` : ''}; it does the work, and you review what it returns. Until then edits, commands and more reads are refused here. (The person can allow doing it here with /gearbox strict off.)`,
        }
      }
    }
    const mode = handoffMode()
    if (mode && turnGear) {
      const command = String((e as any).command ?? '')
      const shell = /^(Bash|PowerShell)$/.test(tool)
      const inline = mode === 'drive' ? isBrowserTool(tool) : mode === 'wait' ? shell && isLongCommand(command) : shell && isChoreCommand(command)
      // Strict: the main conversation may not do a hand-off step's work itself; the refusal says what to start.
      if (strict && inline) {
        const g = handoffGear()
        logEvent({ ev: 'strict', tool, mode, refused: true })
        const job =
          mode === 'drive' ? 'click through the browser check and report only what it saw' : mode === 'wait' ? 'run the command and report only the outcome' : 'do the git or GitHub work and report what it did'
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
    // What the turn does outranks the survey's guess: editing files is writing code, and a failed test or build
    // means debugging. Either way the rest of the turn runs at least at the coding effort.
    const below = () => turnGear !== undefined && !ownEffort && EFFORTS.indexOf(turnGear.effort) < EFFORTS.indexOf(everyday(standing))
    const lift = (why: string) => {
      turnGear = previous = { ...turnGear!, effort: everyday(standing) }
      logEvent({ ev: 'raise', tool, effort: everyday(standing), why })
    }
    if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) && below()) {
      lift('the turn edits files')
      await showStatus($, turnHandoff, stepLabel())
    }
    const result = tool === 'Skill' ? await callSkill(e, orchestrator || steers || (await onHaiku($)), () => next(e)) : await next(e)
    if (/^(Bash|PowerShell)$/.test(tool) && isLongCommand(String((e as any).command ?? '')) && 'isError' in result && result.isError && below()) {
      lift('a test or build failed')
      await showStatus($, turnHandoff, stepLabel())
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (enabled) {
      await patch($, e.agentId ?? 'main', l => {
        if (!l) return l
        const { doing: _, ...rest } = l
        return { ...rest, state: e.agentId ? 'done' : 'idle' }
      })
      await showStatus($, turnHandoff, stepLabel())
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
    let scout = false
    if (!e.agentId && enabled && orchestrator) {
      // The orchestrator: the main conversation runs on its own model at its own effort, whatever the session is on.
      // The first request on another model writes the conversation into that model's cache once.
      const from = family(e.model)
      if (turnGear && turnGear.model !== from && e.index === 0) {
        const tokens = (await $.session.usage()).context.tokens ?? 0
        logEvent({ ev: 'shift', from, to: turnGear.model, recache: tokens, usd: (tokens * PRICES[turnGear.model].written) / 1e6, why: 'orchestrator' })
      }
      if (turnGear) step = { ...step, model: turnGear.model, ...(ownEffort ? {} : { effort: turnGear.effort }) }
    } else if (!e.agentId && enabled) {
      // Shifting (Haiku session): the turn's model, else the floor. Steering: the session's model, unless the
      // person asked for another this turn. Effort changes are free: they keep the prompt cache (measured).
      const shifting = e.model.includes('haiku')
      const from = shifting ? floor : family(e.model)
      const model = shifting ? turnGear?.model ?? floor : turnGear?.model
      if (model && model !== from && from && e.index === 0) {
        const tokens = (await $.session.usage()).context.tokens ?? 0
        logEvent({ ev: 'shift', from, to: model, recache: tokens, usd: (tokens * PRICES[model].written) / 1e6 })
      }
      if (model && shifting) floor = nextFloor(model, floor)
      if (model && (shifting || model !== from)) step = { ...step, model }
      if (turnGear && !ownEffort) step = { ...step, effort: turnGear.effort }
      if (e.index === 0) readStreak = 0
      scout = turnLong && turnGear !== undefined && !ownEffort && family(step.model) !== 'haiku' && scouts(readStreak, warmScout())
    }
    // A lane's request goes at the effort of the job it is on, lower than the effort the lane started at.
    const job = e.agentId ? laneEffort.get(e.agentId) : undefined
    if (job) step = { ...step, effort: job }
    // A reviewing skill's fork goes at a review's gear on every request: at least Opus, at the effort of the turn's
    // own work. A fork takes no model from agent.spawn, so its requests are where it is re-geared.
    const fork = enabled && e.agentId && !laneOf(e.agentId) && !laneEffort.has(e.agentId) && e.agentId !== deepAgent?.id ? await skillFork(e.agentId, () => listAgents($)) : undefined
    if (fork) {
      const from = family(e.model) ?? 'sonnet'
      const set = reviewGear({ model: from, effort: fork.call.effort })
      step = { ...step, ...(set.model !== from ? { model: set.model } : {}), effort: set.effort }
      if (!fork.logged) {
        fork.logged = true
        // Its arguments, like a prompt's text, only in a full log.
        const args = logMode === 'full' && fork.call.args ? { args: fork.call.args.slice(0, 200) } : {}
        logEvent({ ev: 'agent', type: 'skill', skill: fork.call.skill, agent: e.agentId, match: fork.match, asked: `${family(e.model) ?? e.model}·${e.effort ?? 'default'}`, set: label(set), ...args })
      }
    }
    const id = e.agentId ?? 'main'
    const sending = async (s: typeof e) => {
      if (!enabled) return
      await patch($, id, l => ({
        label: fork ? `/${fork.call.skill}` : e.agentId ? 'agent' : 'main',
        ...(e.agentId ? { parent: 'main', since: Date.now() } : {}),
        steps: 0,
        ...l,
        asked: s.model,
        ...(s.effort !== undefined ? { effort: String(s.effort) } : {}),
        state: 'working',
      }))
      if (!e.agentId) await showStatus($, turnHandoff, stepLabel())
      await countRequest($, family(s.model) ?? String(s.model))
    }
    let result: TurnStepResult | undefined
    let sent = step
    if (scout) {
      // Haiku's reply is held back until it is known to be only reads; a reply never yielded is never recorded.
      const tried = { ...step, model: SCOUT.model, effort: SCOUT.effort }
      const recache = warmScout() ? undefined : (await $.session.usage()).context.tokens ?? 0
      await sending(tried)
      const held: TurnStepChunk[] = []
      let r: TurnStepResult | undefined
      try {
        const s = next(tried)
        for await (const c of s) held.push(c)
        r = await s.result
      } catch {
        // A failed try goes to the main model below.
      }
      scoutedAt = Date.now()
      const kept = r !== undefined && (keepsScout(r) || next.signal.aborted)
      const u = r?.usage
      logEvent({
        ev: 'scout',
        index: e.index,
        kept,
        uses: r?.toolUses.map(t => t.name) ?? [],
        ...(u ? { in: u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens, out: u.output_tokens } : {}),
        ...(recache !== undefined ? { recache, usd: (recache * (recache > 100_000 ? HAIKU_LONG : PRICES.haiku).written) / 1e6 } : {}),
      })
      if (kept) {
        for (const c of held) yield c
        result = r
        sent = tried
      } else if (u) await tally($, u)
    }
    if (!result) {
      await sending(step)
      result = yield* next(step)
    }
    if (enabled) await patch($, id, l => l && { ...l, ...(result.usage ? { answered: result.usage.model } : {}), steps: l.steps + 1 })
    if (!e.agentId) {
      const kind = readKind(result.toolUses)
      readStreak = kind === 'read' ? readStreak + 1 : kind === 'aside' ? readStreak : 0
    }
    // What gearbox sent next to what Claude Code would have sent (its own setting), and who answered.
    const u = result.usage
    logEvent({
      ev: 'step',
      loop: id,
      index: e.index,
      sent: `${family(sent.model) ?? sent.model}·${sent.effort ?? 'default'}`,
      engine: `${family(e.model) ?? e.model}·${e.effort ?? 'default'}`,
      answered: u?.model,
      ...(u ? { in: u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens, out: u.output_tokens } : {}),
    })
    if (u) await tally($, u)
    // How big the deep agent's context has grown, and when its cache was last warmed.
    if (u && e.agentId && e.agentId === deepAgent?.id)
      deepAgent = { ...deepAgent, at: Date.now(), tokens: u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens }
    const held = u && e.agentId ? laneOf(e.agentId) : undefined
    if (u && held) lanes = { ...lanes, [held.model]: { id: held.id, at: Date.now(), tokens: u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens } }
    return result
  })

  // The spinner names the model and effort of the loop's request in flight: "Sauteing… on opus · xhigh". The
  // surface's own effort display shows the session setting, not what gearbox sent.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!enabled) return next(e)
    const loops = await read($, LOOPS)
    const loop = loops[e.requestId] ?? loops.main
    if (!loop) return next(e)
    return next({ ...e, props: { ...e.props, suffix: `${e.props.suffix ?? '…'} on ${family(loop.asked) ?? loop.asked}${loop.effort ? ` · ${loop.effort}` : ''}` } })
  })

  // The band above the prompt: coding-effort tabs and actions, five live columns of what gearbox does now, then a
  // row per running subagent. Whatever the mods below draw in this slot stays, under it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!enabled || !bandOn || e.props.hasSurvey) return next(e)
    const below = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const loops = await read($, LOOPS)
    const turn = await read($, TURN)
    const s = settingsFrom(options, await read($, SETTINGS))
    const usd = await sessionCost($)
    const main = loops.main
    const works = main?.state === 'working'
    const subs = working(loops)
    const thisTurn = usd !== undefined && turn.costAtStart !== undefined ? usd - turn.costAtStart : undefined
    const turnCosts = thisTurn !== undefined ? [...turn.costs, thisTurn] : turn.costs
    const requests = Object.entries(turn.requests)
    const total = requests.reduce((n, [, c]) => n + c, 0)
    const avg = turnCosts.length ? turnCosts.reduce((a, b) => a + b, 0) / turnCosts.length : undefined
    // Bars and an average only once there are turns to compare.
    const compare = turnCosts.length > 1
    // [label, value, the line under it, the value's colour, bars after the value]. Nothing unknown is drawn as a dash.
    const cols: [string, string, string, string | undefined, string?][] = [
      ['now', works ? gearText(main!) : 'idle', works ? (main!.doing ?? 'thinking') : main ? `last ${gearText(main)}` : 'waiting for a prompt', works ? hue(main!) : undefined],
      ['agents', subs.length ? `${subs.length} running` : 'none', subs.length ? gearsText(subs.map(([, l]) => l), ' · ') : 'no hand-off running', undefined],
      ['this turn', `${total} request${total === 1 ? '' : 's'}`, requests.map(([m, c]) => `${m} ${c}`).join(' · ') || 'none sent yet', undefined],
      [
        'cost',
        usd !== undefined ? money(usd) : 'not known',
        [thisTurn !== undefined ? `this turn ${money(thisTurn)}` : '', compare && avg !== undefined ? `avg ${money(avg)}` : ''].filter(Boolean).join(' · '),
        undefined,
        compare ? bars(turnCosts) : undefined,
      ],
      ['why', turn.why?.[0] ?? 'waiting for a prompt', turn.why?.[1] ?? '', '#E9A23B'],
    ]
    // A narrow band keeps what matters most, so nothing wraps. The desktop app counts fewer, wider cells than a terminal.
    const term = e.surface === 'terminal'
    const shown = e.props.bodyColumns < (term ? 100 : 60) ? [cols[0]!, cols[1]!, cols[3]!] : cols
    // The terminal draws a │ between columns, a cell of gap on each side of it.
    const width = Math.max(12, Math.floor((e.props.bodyColumns - (term ? 3 : 2) * (shown.length - 1)) / shown.length))
    // Rules only where text draws them as lines: the terminal. A desktop draws the band as a card.
    const rule = (glyph: string) => (term ? <Text dimColor wrap="truncate">{glyph.repeat(Math.max(1, e.props.bodyColumns))}</Text> : null)
    // Up to five subagent rows; past that, four and a count of the rest.
    const listed = subs.length > 5 ? subs.slice(0, 4) : subs
    const labelW = Math.min(24, Math.max(0, ...listed.map(([, l]) => l.label.length)) + 2)
    // shortcut: the run time is as of the band's last redraw (any loop's request or tool call); add a clock tick if a long silent tool makes it look stuck.
    const now = Date.now()
    const choose = async (change: Partial<Settings>) => {
      await saveSetting($, change)
      apply(await loadSettings($, options))
    }
    const mine = (
      <Box flexDirection="column" rowGap="sm">
        <Box flexDirection="row" columnGap={term ? 2 : 1} alignItems="center">
          <Text weight="bold">GearBox</Text>
          <Box flexGrow={1} />
          <Button key="band-pane" dimColor label="Panel" onPress={() => void $.ui.open({ id: PANE, title: 'gearbox: models now' })} />
          <Button
            key="band-log"
            dimColor
            label={s.log === 'off' ? 'Log' : 'Log ✓'}
            onPress={async () => {
              await choose({ log: s.log === 'off' ? 'on' : 'off' })
              if (s.log === 'off') {
                logEvent({ ...(await sessionFacts($, options)), settings: current() })
                await flushLog($, log)
              }
            }}
          />
          <Button key="band-settings" dimColor label="Settings" onPress={() => void $.ui.open({ id: SETTINGS_PANE, title: 'gearbox settings', focus: true, closeOnEscape: true })} />
        </Box>
        {rule('─')}
        <Box flexDirection="row" columnGap={term ? 1 : 2}>
          {shown.flatMap(([k, v, sub, color, extra], i) => [
            term && i > 0 ? (
              <Box flexDirection="column" width={1} flexShrink={0}>
                <Text dimColor>│</Text>
                <Text dimColor>│</Text>
                <Text dimColor>│</Text>
              </Box>
            ) : null,
            <Box flexDirection="column" width={width} flexGrow={1} flexShrink={1}>
              <Text dimColor size="caption" wrap="truncate">
                {k}
              </Text>
              <Text size="heading" weight="semibold" wrap="truncate" {...(color ? { color } : {})}>
                {v}
                {extra ? (
                  <Text dimColor mono weight="regular" size="caption">
                    {` ${extra}`}
                  </Text>
                ) : null}
              </Text>
              <Text dimColor size="caption" wrap="truncate">
                {sub}
              </Text>
            </Box>,
          ])}
        </Box>
        {listed.length ? (
          <Box flexDirection="column">
            {rule('┄')}
            {listed.map(([id, l]) => (
              <Box key={`band-agent-${id}`} flexDirection="row" columnGap={2}>
                <Box width={labelW} flexShrink={0}>
                  <Text wrap="truncate">{`⇢ ${l.label}`}</Text>
                </Box>
                <Box width={14} flexShrink={0}>
                  <Text weight="semibold" wrap="truncate" color={hue(l)}>
                    {gearText(l)}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text dimColor wrap="truncate">
                    {swapped(l) ? `${l.doing ?? 'thinking'} · answered by ${family(l.answered!) ?? l.answered}` : (l.doing ?? 'thinking')}
                  </Text>
                </Box>
                <Text dimColor tabular>{`${l.steps} request${l.steps === 1 ? '' : 's'}${l.since !== undefined ? `  ${ran(now - l.since)}` : ''}`}</Text>
              </Box>
            ))}
            {subs.length > listed.length ? <Text dimColor>{`+${subs.length - listed.length} more · Panel`}</Text> : null}
          </Box>
        ) : null}
      </Box>
    )
    return below ? (
      <Box flexDirection="column" rowGap={1}>
        {mine}
        {below}
      </Box>
    ) : (
      mine
    )
  })

  // /gearbox settings: one row of buttons per setting; the value in use is marked, a press saves another.
  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = settingsFrom(options, await read($, SETTINGS))
    const rows: [string, string, readonly string[], string][] = [
      ['Coding effort', 'effort', ['medium', 'high', 'xhigh', 'max'], s.code_effort],
      ['Browser navigator', 'navigator', ['sonnet', 'haiku'], s.navigator],
      ['Steer non-Haiku', 'steer', ['on', 'off'], s.steer ? 'on' : 'off'],
      ['Hand work up', 'escalate', ['on', 'code', 'off'], s.escalate],
      ['Strict hand-offs', 'strict', ['on', 'off'], s.strict ? 'on' : 'off'],
      ['Debug log', 'log', ['off', 'on', 'full'], s.log],
      ['Models panel shows', 'pane', ['all', 'running'], s.pane],
      ['Band', 'band', ['on', 'off'], s.band ? 'on' : 'off'],
      ['Orchestrator', 'orchestrator', ['on', 'off'], s.orchestrator ? 'on' : 'off'],
      // Its model, effort and parallel agents only matter while it is on.
      ...(s.orchestrator
        ? ([
            ['Orchestrator model', 'orchestrator-model', ['sonnet', 'opus', 'haiku'], s.orchestrator_model],
            ['Orchestrator effort', 'orchestrator-effort', ['low', 'medium', 'high', 'xhigh', 'max'], s.orchestrator_effort],
            ['Parallel agents', 'orchestrator-agents', ['1', '2', '3', '4', '5', '6'], String(s.orchestrator_agents)],
          ] as [string, string, readonly string[], string][])
        : []),
    ]
    return (
      <Box flexDirection="column" rowGap={1}>
        {rows.map(([title, word, values, current]) => (
          <Box flexDirection="row" columnGap={1} alignItems="center">
            <Text mono>{title.padEnd(20)}</Text>
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
