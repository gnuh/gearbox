import { atom, read, update } from 'claude-code'
import type { AgentInfo, AgentStatus, ClassicHookInputs, ElementTable, EngineInterface, RenderElement, ModelEffort, PluginOptions, PromptOrigin, Register, TurnUsage } from 'claude-code'
import type { GearboxLoop, GearboxReports } from '../types'
import {
  type CodeEffort,
  type CodeModel,
  type DeepAgent,
  ARTIFACT_MAX,
  CODE_EFFORTS,
  capXhigh,
  chosenEffort,
  effortLine,
  standingOf,
  type FanPart,
  type Gear,
  type Handoff,
  BRIEFING,
  BRIEFING_TOOLS,
  BRIEF_READS,
  CODE_MODELS,
  apartEdits,
  looksUp,
  ownBrief,
  NESTING,
  notesIn,
  typedLanguage,
  resumable,
  type Model,
  type Plan,
  type Reading,
  type Step,
  isBrowserTool,
  isChoreCommand,
  isLongCommand,
  LONG_CONTEXT,
  everyday,
  EFFORTS,
  doesHandoffWork,
  escalated,
  handoffLabel,
  hookBrief,
  htmlText,
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
  goAhead,
  workFloor,
  handoffNote,
  label,
  mainModel,
  needsConsent,
  nextFloor,
  pinnedModel,
  pins,
  plan,
  route,
  routeNote,
  ownWords,
  readParts,
  readReading,
  readingWhy,
  referencedFiles,
  staysPut,
  fanReply,
  WORKTREE_FAILED,
  stepDown,
  trimRequest,
  verifyAsk,
  writesNoCode,
} from './policy'
import { runHooks } from './classic'
import { NARROW, type Queued, type Summary, desktopBand, panelBody, terminalBand } from './agents'
import { NOTE_EVERY_MS, ended, family, gearText, grown, kilo, live, noteOf, revived, toolName, withFile, withNote, withTool, withUsage, withWorktree, worktreeAdd } from './loops'
import { NEUTRAL, ORCHESTRATOR_EFFORTS, type Lane, type Lanes, fanOut, fanParts, keepsRoute, laneResumable, laneStart, orchestratorFrom, orchestratorPatch, orchestratorPlan, orchestratorRoute, type OrchestratorSettings, seatParts, whyNoFan } from './orchestrator'

// US$ per million tokens.
// shortcut: copied from the claude-api skill's table (cached 2026-10-06); update when prices move.
const PRICES: Record<Model, { fresh: number; written: number; cached: number; out: number }> = {
  haiku: { fresh: 0.1, written: 0.125, cached: 0.01, out: 0.5 },
  sonnet: { fresh: 2, written: 2.5, cached: 0.2, out: 10 },
  opus: { fresh: 4, written: 5, cached: 0.2, out: 20 },
  fable: { fresh: 10, written: 12.5, cached: 0.25, out: 50 },
}
// Haiku bills a prompt over 100K tokens at five times its rate.
const HAIKU_LONG = { fresh: 0.5, written: 0.625, cached: 0.05, out: 2.5 }
const LONG_ROW = ' over 100K'

const KIND: Record<Handoff['kind'], string> = { drive: 'browser check', wait: 'long command', chore: 'git chore', aside: 'side task', deep: 'deep work', lane: 'lane work', fan: 'parallel agents' }
const PANE = 'gearbox'
const PANE_TITLE = 'gearbox: agents'
const KEEP_LOOPS = 40
const WAIT_POLL_MS = 3000

// Every loop's model right now, which every readout draws from. The tag declines what another version stored.
const LOOPS = atom({ plugin: 'gearbox', key: 'loops' } as const, {}, { shape: 'loops-1' })
// What /gearbox set, mirrored from the store so the settings panel redraws when a value changes.
const SETTINGS = atom({ plugin: 'gearbox', key: 'settings' } as const, {}, { shape: 'settings-1' })
const SETTINGS_PANE = 'gearbox-settings'
// The band's per-turn numbers. The tag declines what another version stored.
const TURN = atom({ plugin: 'gearbox', key: 'turn' } as const, { requests: {}, costs: [] }, { shape: 'turn-3' })
// The reports agents the main conversation started handed back, drawn under their notification or call.
const REPORTS = atom({ plugin: 'gearbox', key: 'reports' } as const, {} as GearboxReports, { shape: 'reports-1' })
const KEEP_REPORTS = 30
// The agent types that only read: what an agent may start itself.
const READERS = /^(Explore|Plan)$/

// Re-exported for the readouts' tests and anyone importing them from here.
export { gearText, noteOf }

// Applies `fn` to one loop's row; finished subagents past KEEP_LOOPS leave, oldest first.
const patch = ($: EngineInterface, id: string, fn: (l: GearboxLoop | undefined) => GearboxLoop | undefined) =>
  update($, LOOPS, all => {
    const row = fn(all[id])
    const next: Record<string, GearboxLoop> = row ? { ...all, [id]: row } : { ...all }
    const done = Object.keys(next).filter(k => next[k]!.state === 'done')
    for (const k of done.slice(0, Math.max(0, Object.keys(next).length - KEEP_LOOPS))) delete next[k]
    return next
  })

const alive = (loops: Record<string, GearboxLoop>) => Object.entries(loops).filter(([id, l]) => id !== 'main' && live(l))
// The engine still counts an agent whose turn ended as alive: its turn is not over yet, or it waits on its own work.
const held = (s?: AgentStatus) => s === 'waiting' || s === 'running' || s === 'pending'
// The live subagents in the order they nest: each right under the loop that started it.
const nested = (loops: Record<string, GearboxLoop>) => {
  const rows = alive(loops)
  const out: typeof rows = []
  const under = (p: string) => {
    for (const r of rows) if ((r[1].parent ?? 'main') === p && !out.includes(r)) out.push(r), under(r[0])
  }
  under('main')
  return [...out, ...rows.filter(r => !out.includes(r))]
}
const counted = (subs: [string, GearboxLoop][]) => {
  const waits = subs.filter(([, l]) => l.state === 'waiting').length
  return [subs.length > waits ? `${subs.length - waits} running` : '', waits ? `${waits} waiting` : ''].filter(Boolean).join(' · ')
}

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

// A tool call made: what the loop is doing, the tool its latest note is followed by, and the file it touches.
const called = (l: GearboxLoop, tool: string, input: Record<string, unknown>): GearboxLoop => {
  const doing = describeTool(tool, input)
  return withFile(withTool({ ...l, doing }, toolName(doing)), tool, input.file_path)
}

const sessionCost = async ($: EngineInterface) => {
  try {
    return (await $.session.usage()).cost?.usd
  } catch {
    return undefined
  }
}

// A person's prompt starts a new tally; the turn before it joins the costs the band's bars draw. The main
// conversation's own count, clock, notes and cost start over with it, and the agents finished before it are no longer drawn.
const startTurnTally = async ($: EngineInterface) => {
  const usd = await sessionCost($)
  const at = Date.now()
  await update($, TURN, t => ({
    requests: {},
    at,
    ...(usd !== undefined ? { costAtStart: usd } : {}),
    costs: t.costAtStart !== undefined && usd !== undefined && Object.keys(t.requests).length ? [...t.costs, usd - t.costAtStart].slice(-8) : t.costs,
  }))
  await patch($, 'main', l => {
    if (!l) return l
    const { usage: _, files: __, ...rest } = l
    return { ...rest, steps: 0, since: at, notes: [] }
  })
}

const setWhy = ($: EngineInterface, why: [string, string]) => update($, TURN, t => ({ ...t, why }))

const countRequest = ($: EngineInterface, model: string) =>
  update($, TURN, t => ({ ...t, requests: { ...t.requests, [model]: (t.requests[model] ?? 0) + 1 } }))

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
  const subs = alive(loops)
  const waits = subs.filter(([, l]) => l.state === 'waiting').length
  const tail = subs.length
    ? ` ⇢ ${subs.length} agent${subs.length > 1 ? 's' : ''}: ${gearsText(subs.map(([, l]) => l), ', ')}${waits ? `, ${waits} waiting` : ''}`
    : handoff?.kind === 'fan'
      ? ` ⇢ ${handoff.parts?.length ?? 0} ${KIND.fan}`
      : handoff
        ? ` ⇢ ${handoff.gear.model} ${KIND[handoff.kind]}`
        : ''
  // Claude Code heads a plugin's status line with its name ("gearbox: …"), so the text starts at the gear.
  $.ui.status(`${gearText(main)}${step ? ` · ${step}` : ''}${tail}`)
}

// Whether a person typed the prompt (no origin means the person's own); notifications, schedules and peers are not surveyed.
const typedByPerson = (o?: PromptOrigin) =>
  !o || o.kind === 'composer' || o.kind === 'bridge' || o.kind === 'sdk' || (o.kind === 'plugin' && o.asUser === true)

// The person's last few messages, short, so the survey can tell a side task from the work under way.
const recentAsks = async ($: EngineInterface) =>
  (await $.session.messages())
    .filter(m => m.role === 'user' && m.text.trim())
    .slice(-3)
    .map(m => m.text.slice(0, 200))

// The assistant's last reply: the work a "lets do it" or a "continue" goes ahead with. Null when there is none.
const lastReply = async ($: EngineInterface): Promise<string | null> =>
  (await $.session.messages()).filter(m => m.role === 'assistant' && m.text.trim()).at(-1)?.text.trim() ?? null
// How much of it goes beside a message the survey reads: its end, where a proposal asks to go ahead.
const REPLY_TAIL = 1500
// How much of it the survey reads when it is the work itself.
const PROPOSAL_MAX = 8000

// What the person said lately, `latest` (their turn's prompt) last, for the brief of a stronger model's subagent.
const personSaid = async ($: EngineInterface, latest: string): Promise<string[]> => {
  const said = (await $.session.messages()).filter(m => m.role === 'user' && m.text.trim()).map(m => m.text)
  return latest.trim() && said.at(-1)?.trim() !== latest.trim() ? [...said, latest] : said
}

// The language of the person's recent typed messages, for the notes an agent writes between steps: read again only when
// those messages change, so a session reads it once per prompt. Undefined when it cannot be told.
type TypedIn = { key?: string; language?: string }
const typedIn = async ($: EngineInterface, memo: TypedIn, latest: string): Promise<string | undefined> => {
  try {
    const said = await personSaid($, latest)
    const key = said.slice(-3).join('\u0000')
    if (memo.key !== key) Object.assign(memo, { key, language: typedLanguage(said) })
    return memo.language
  } catch {
    return undefined
  }
}

// One low-effort call that describes the request; undefined when the reply is unusable. A person's prompt is read
// by Sonnet: replaying 79 real prompts, Haiku took main work for side tasks 8 times (Sonnet once) and made a
// question into a route; Sonnet costs about a second more. A subagent's brief only needs its kind of job: Haiku.
// The request travels inside JSON, so nothing pasted into it can pose as another field. `approved`: the request is
// the assistant's proposal, which the person approved, read as the work it lays out. `files`: the text of the files the
// proposal points to (approvedFiles), after it, so its trim never cuts them.
type SurveyInput = { request: string; earlier: string[]; previous?: Gear; reply?: string | null; approved?: boolean; files?: string }
const survey = async ($: EngineInterface, { request, earlier, previous, reply = null, approved = false, files = '' }: SurveyInput, model: 'sonnet' | 'haiku' = 'sonnet') => {
  const r = await $.model.complete({
    model,
    system: SURVEY,
    prompt: JSON.stringify({
      request: `${trimRequest(request, approved ? PROPOSAL_MAX : undefined)}${files ? `\n\n---\nThe files this proposal points to, as text:${files}` : ''}`,
      earlier,
      previous: previous ?? null,
      reply: reply && reply.slice(-REPLY_TAIL),
      ...(approved ? { approved } : {}),
    }),
    effort: 'low',
    // No cap on the answer: a reply that stops mid-correction is unreadable, and a read costs little.
    maxTokens: 64_000,
    timeoutMs: 30_000,
  })
  $.ui.log(`gearbox survey: ${r.isAnswered ? r.text.trim() : `no reply (${r.reason})`}`, { to: 'debug' })
  return { reading: r.isAnswered ? readReading(r.text) : undefined, reply: r.isAnswered ? r.text.trim() : `no reply (${r.reason})` }
}

// A subagent's effort by its job, read as a prompt is: browsing and long commands run low, code at the coding
// effort, questions and searches by depth. Code also takes the coding model the person fixed (`code`), if any; any
// other job keeps the model its call named. `writes`: the job is code; `reviews`: it is a review. Undefined when the
// read fails: the call goes as it was.
type Job = { model?: Model; effort: ModelEffort; writes: boolean; reviews: boolean }
const jobGear = async ($: EngineInterface, brief: string, standing: ModelEffort, code?: Model): Promise<Job | undefined> => {
  const { reading: r } = await survey($, { request: brief, earlier: [] }, 'haiku')
  if (!r) return undefined
  if (r.mode === 'drive' || r.mode === 'wait') return { effort: 'low', writes: false, reviews: false }
  const g = gearFor({ ...r, ask: {} }, standing, code)
  return { ...(pins({ ...r, ask: {} }, code) ? { model: g.model } : {}), effort: g.effort, writes: r.mode === 'code', reviews: r.mode === 'review' }
}

// The files a go-ahead's proposal points to (referencedFiles), as the survey of the work it approves reads them: each
// that exists, an HTML page as its text, ARTIFACT_MAX characters in all. A relative path is the session folder's, else
// the repository's. Anything that cannot be read is left out; this only sharpens a reading. `read`: each file as the
// reply names it and how many characters of it the survey got, for the log.
const approvedFiles = async ($: EngineInterface, reply: string): Promise<{ text: string; read: { path: string; chars: number }[] }> => {
  const read: { path: string; chars: number }[] = []
  let text = ''
  try {
    const paths = referencedFiles(reply)
    if (!paths.length) return { text, read }
    const cwd = await $.session.cwd().catch(() => '')
    const root = await repoRoot($)
    let home: string | undefined
    for (const p of paths) {
      if (text.length >= ARTIFACT_MAX || read.length >= 3) break
      if (p.startsWith('~/')) home ??= (await $.env.get('HOME').catch(() => undefined)) ?? ''
      const places = p.startsWith('~/') ? (home ? [`${home}${p.slice(1)}`] : []) : p.startsWith('/') ? [p] : [cwd, root].filter(Boolean).map(d => `${d}/${p.replace(/^\.\//, '')}`)
      for (const full of new Set(places)) {
        if (!(await $.fs.exists(full).catch(() => false))) continue
        const raw = String(await $.fs.read(full))
        const body = (/\.(html?|svg)$/i.test(full) ? htmlText(raw) : raw.trim()).slice(0, ARTIFACT_MAX - text.length)
        if (body) {
          text += `\n\n[${p}]\n${body}`
          read.push({ path: p, chars: body.length })
        }
        break
      }
    }
  } catch (err) {
    $.ui.log(`files the proposal points to not read: ${err}`, { to: 'debug' })
  }
  return { text, read }
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
  return { ev: 'session', gearbox, claude: (await $.session.version()).version, model: await $.session.model(), fromGearbox: (await storedSettings($)).kept, fromPlugin: withoutRemoved(options) }
}

// Whether the session's folder is in a git repository, which Claude Code needs to make an agent's worktree: it or a
// folder above it holds a `.git` (a folder, or a file in a linked worktree or a submodule). A folder gearbox cannot
// read is not one. (A WorktreeCreate hook can make worktrees elsewhere; gearbox does not look for one.)
const repoRoot = async ($: EngineInterface): Promise<string | undefined> => {
  try {
    const dirs = (await $.session.cwd()).split(/[\\/]+/).filter((d, i) => d || i === 0)
    for (let n = dirs.length; n > 0; n--) if (await $.fs.exists(`${dirs.slice(0, n).join('/')}/.git`)) return dirs.slice(0, n).join('/')
  } catch {}
  return undefined
}
const inGitRepo = async ($: EngineInterface): Promise<boolean> => (await repoRoot($)) !== undefined

// A tool call that came back refused or in error.
const failed = (r: { deny?: unknown; isError?: unknown }): boolean => r.deny !== undefined || !!r.isError

// The person's own hooks for agents (classic.ts): what the main conversation's last prompt gave its hooks to run on,
// what its UserPromptSubmit hooks said (which stands in when none can be run here), and the agents a Stop hook sent
// back to work, so their next stop tells the hooks they are continuing.
type AgentHooks = { base: Record<string, unknown>; context: string[]; continued: Set<string> }

// The UserPromptSubmit hooks on a task an agent is given, as a prompt in the main conversation gets them: the text to
// add to the task, or why a hook stopped it. A hook that cannot run leaves the task as it is.
const taskHooks = async ($: EngineInterface, h: AgentHooks, logEvent: (rec: Record<string, unknown>) => void, task: string, agent: string): Promise<{ brief: string; deny?: string } | undefined> => {
  try {
    const said = await runHooks($, 'UserPromptSubmit', { session_id: await $.session.id(), transcript_path: '', cwd: await $.session.cwd(), ...h.base, prompt: task, agent_type: agent }, h.context)
    const stopped = said.block ?? said.stop
    logEvent({ ev: 'hooks', event: 'UserPromptSubmit', agent, context: said.context.length, ...(stopped ? { stopped } : {}) })
    return stopped ? { brief: '', deny: `gearbox: your UserPromptSubmit hook stopped this task: ${stopped}` } : { brief: hookBrief(said.context) }
  } catch (err) {
    $.ui.log(`hooks not run for an agent's task: ${err}`, { to: 'debug' })
  }
}

// An agent that stops, put to the person's Stop hooks as the main conversation is: what they say to send it back to
// work (a block, or feedback they print), or nothing.
const stopHooks = async ($: EngineInterface, h: AgentHooks, logEvent: (rec: Record<string, unknown>) => void, e: ClassicHookInputs['SubagentStop']): Promise<{ block?: string; context: string[] }> => {
  try {
    const said = await runHooks($, 'Stop', { ...e, stop_hook_active: e.stop_hook_active || h.continued.has(e.agent_id) })
    // `continue: false` ends it, whatever else the hooks said.
    const again = !said.stop && (said.block !== undefined || said.context.length > 0)
    if (again) h.continued.add(e.agent_id)
    else h.continued.delete(e.agent_id)
    logEvent({ ev: 'hooks', event: 'Stop', agent: e.agent_id, type: e.agent_type, ...(again ? { again: true, ...(said.block ? { block: said.block } : {}) } : {}) })
    return again ? said : { context: [] }
  } catch (err) {
    $.ui.log(`stop hooks not run for an agent: ${err}`, { to: 'debug' })
    return { context: [] }
  }
}

// Puts a costly gear to the person; a dismissed dialog, or an answer typed under "Other", takes the cheaper one.
// `keepModel`: the model is the person's own pick (their coding model), so only the effort steps down.
const consent = async ($: EngineInterface, g: Gear, keepModel = false): Promise<Gear> => {
  const cheaper = keepModel ? { model: g.model, effort: stepDown(g).effort } : stepDown(g)
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

// With the coding effort on `auto` the main conversation decides each agent it starts, once it has read the work: the
// model and effort its call names win, within bounds. The effort runs from medium to xhigh (chosenEffort); a review
// never runs below Opus; Fable is put to the person unless they asked for it (`asked`), it is their coding model
// (`code`), or gearbox's own pick was Fable already. What the call leaves out, gearbox's pick fills (`pick`, raised to
// Opus for a review: the advice). `chosen`: whose the gear is; `effortBy`: whose its effort is, for the readouts.
type Decided = { gear: Gear; effortBy: 'main' | 'rules'; log: { chosen: 'main' | 'rules'; advised: string; agrees: boolean } }
const decide = async ($: EngineInterface, e: { model?: unknown; effort?: unknown }, pick: Gear, o: { review: boolean; asked?: Model; code: CodeModel }): Promise<Decided> => {
  const advised = o.review ? reviewGear(pick) : pick
  const named = family(String(e.model ?? ''))
  const effort = chosenEffort(e.effort)
  let gear: Gear = { model: named ?? advised.model, effort: effort ?? advised.effort }
  if (o.review) gear = reviewGear(gear)
  if (gear.model === 'fable' && advised.model !== 'fable' && o.asked !== 'fable' && o.code !== 'fable' && (await $.store.get('consent')) !== false) gear = await consent($, gear)
  const chosen = named || effort ? 'main' : 'rules'
  return { gear, effortBy: effort ? 'main' : 'rules', log: { chosen, advised: label(advised), agrees: label(gear) === label(advised) } }
}

// The engine's list says which agents are alive. The rows come from the events gearbox heard, and an agent can be
// alive with none of them saying so: its turn ended while it waits on background work it started, a reload, a spawn
// gearbox did not hear. No event says when that changes, so while any agent is alive the list is read every few
// seconds and the rows follow it. An agent it does not list (a workflow's) keeps what its own events said.
type AgentWatch = { timer?: { cancel: () => void } }
const syncAgents = async ($: EngineInterface, w: AgentWatch, changed: () => Promise<void>) => {
  const agents = await listAgents($)
  if (!agents) return
  const loops = await read($, LOOPS)
  let moved = false
  for (const a of agents) {
    const l = loops[a.id]
    const state = a.status === 'waiting' ? 'waiting' : held(a.status) ? 'working' : live(l) ? 'done' : undefined
    // One held at its turn's end is working again by its next step, not by the list's lag.
    if (!state || l?.state === state || (l?.state === 'waiting' && state === 'working')) continue
    moved = true
    await patch($, a.id, r => {
      const row: GearboxLoop = { steps: 0, since: Date.now(), parent: a.parentId ?? 'main', asked: a.type, ...r, label: r?.label && r.label !== 'agent' ? r.label : a.description, state }
      return state === 'done' ? ended(row, Date.now(), a.status === 'failed' ? { failed: 'failed' } : a.status === 'killed' ? { failed: 'stopped' } : {}) : row
    })
  }
  const listed = new Set(agents.map(a => a.id))
  for (const [id, l] of Object.entries(loops)) {
    if (l.state !== 'waiting' || listed.has(id)) continue
    moved = true
    await patch($, id, r => (r?.state === 'waiting' ? ended(r, Date.now()) : r))
  }
  if (moved) await changed()
  if (!agents.some(a => held(a.status)) && !alive(await read($, LOOPS)).length) {
    w.timer?.cancel()
    w.timer = undefined
  }
}
const watchAgents = ($: EngineInterface, w: AgentWatch, changed: () => Promise<void>) => {
  w.timer ??= $.clock.every(WAIT_POLL_MS, () => void syncAgents($, w, changed).catch(() => undefined))
}

// An agent's report under the row where its end shows, the engine's own drawing kept above it.
const reportBelow = ({ Box, Text, Markdown }: Pick<ElementTable, 'Box' | 'Text' | 'Markdown'>, own: RenderElement, texts: readonly string[]) => (
  <Box flexDirection="column">
    {own}
    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
      <Text dimColor>{texts.length > 1 ? `its report (the latest of ${texts.length}; ctrl+o shows each)` : 'its report'}</Text>
      <Markdown text={texts.at(-1)!} />
    </Box>
  </Box>
)

// A fan-out's parts as the turn hands them out: a costly part's gear goes to the person as a route step's does; then
// each model's lane, where it is idle and worth going back to, takes the first part of its model. `fresh`: unrelated
// work, which goes back to no lane. `code`: the coding model the person fixed, which a part that writes code is
// never put to them for. `chooses`: the coding effort is `auto`, so a part that writes code is never put to them for
// its effort either: the main conversation picks it.
const seatFan = async ($: EngineInterface, fan: readonly FanPart[], o: { asks: boolean; ask: Partial<Gear>; previous?: Gear; standing: ModelEffort; lanes: Lanes; fresh: boolean; code?: Model; chooses?: boolean }): Promise<Handoff> => {
  const parts: FanPart[] = []
  for (const pt of fan) {
    const fixedModel = !!o.code && pt.edits && pt.gear.model === o.code
    const ask = fixedModel ? { ...o.ask, model: pt.gear.model } : o.ask
    parts.push(o.asks && needsConsent(pt.gear, ask, o.previous, o.chooses && pt.edits ? 'xhigh' : o.standing) ? { ...pt, gear: await consent($, pt.gear, fixedModel) } : pt)
  }
  const loops = await read($, LOOPS)
  const seated = seatParts(parts, o.lanes, Date.now(), id => live(loops[id]), o.fresh)
  return { kind: 'fan', gear: nodPart(seated)!.gear, parts: seated }
}

// The part of a fan-out a nod goes back to: the first a lane takes, else the first.
const nodPart = (parts: readonly FanPart[]): FanPart | undefined => parts.find(pt => pt.resume || pt.lane) ?? parts[0]
// Whether the work a nod after a fan-out goes on with writes code.
const nodPartEdits = (h: Handoff): boolean => !!nodPart(h.parts ?? [])?.edits

type Ledger = Record<string, { calls: number; fresh: number; written: number; cached: number; out: number }>

// The ledger's row for a request: its model, a Haiku prompt over 100K priced apart.
const ledgerKey = (u: TurnUsage) => (u.model.includes('haiku') && u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens > 100_000 ? `${u.model}${LONG_ROW}` : u.model)

let pending: Promise<unknown> = Promise.resolve()
// Subagent steps can end together, so the ledger is updated one step at a time and none is lost.
// shortcut: two Claude processes writing at once can still drop a step; fine for an estimate.
const tally = ($: EngineInterface, u: TurnUsage) =>
  (pending = pending
    .then(async () => {
      const ledger = ((await $.store.get('usage')) ?? {}) as Ledger
      const key = ledgerKey(u)
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

// What one request used and cost at list price, for the loop that sent it.
const spent = (u: TurnUsage) => ({
  in: u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens,
  out: u.output_tokens,
  usd: dollars(ledgerKey(u), { calls: 1, fresh: u.input_tokens, written: u.cache_creation_input_tokens, cached: u.cache_read_input_tokens, out: u.output_tokens }),
})

export const usageReport = (ledger: Ledger) => {
  const rows = Object.entries(ledger)
  if (!rows.length) return 'nothing used yet'
  const lines = rows.map(([m, r]) => `${m}  ${r.calls} calls  ${kilo(r.fresh + r.written + r.cached)} in  ${kilo(r.out)} out  ≈ $${dollars(m, r).toFixed(2)}`)
  const total = rows.reduce((sum, [m, r]) => sum + dollars(m, r), 0)
  return [...lines, `total ≈ $${total.toFixed(2)} at API list prices, subagents included`].join('\n')
}

// Typed agents that only search or plan: work handed up never takes them over.
const SEARCHERS = /^(Explore|Plan|claude-code-guide|statusline-setup)$/

export type LogMode = 'off' | 'on' | 'full'
export type Settings = { code_model: CodeModel; code_effort: CodeEffort; navigator: 'haiku' | 'sonnet'; strict: boolean; log: LogMode; agent_hooks: boolean } & OrchestratorSettings

// Settings gearbox once had and now always applies as they were when on: steering a session not on Haiku, handing
// work up to a stronger model, the band above the prompt, and a models panel that lists every loop.
// What an older version stored or a plugin option still says for them is ignored, and dropped from the store.
export const REMOVED_SETTINGS = ['steer', 'escalate', 'band', 'pane'] as const
const removedKey = (k: string) => (REMOVED_SETTINGS as readonly string[]).includes(k)
const withoutRemoved = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !removedKey(k)))

// The person's settings: what /gearbox set (kept in the store) wins over the plugin's options, which not
// every Claude Code screen lets a person edit. Only known keys are read: a removed setting's value has no say.
export const settingsFrom = (options: PluginOptions, stored: unknown): Settings => {
  const o: Record<string, unknown> = { ...options, ...(stored && typeof stored === 'object' ? stored : {}) }
  return {
    code_model: CODE_MODELS.includes(o.code_model as CodeModel) ? (o.code_model as CodeModel) : 'auto',
    // A stored or plugin `max` is no longer offered: it falls back to the default, xhigh.
    // `main` is what `auto` was called before 0.20.0.
    code_effort: o.code_effort === 'main' ? 'auto' : CODE_EFFORTS.includes(o.code_effort as CodeEffort) ? (o.code_effort as CodeEffort) : 'xhigh',
    navigator: o.navigator === 'haiku' ? 'haiku' : 'sonnet',
    strict: o.strict !== false,
    log: o.log === 'on' || o.log === 'full' ? o.log : 'off',
    agent_hooks: o.agent_hooks !== false,
    ...orchestratorFrom(o),
  }
}

// One `/gearbox <setting> <value>`; undefined when the value is not one the setting takes.
export const settingPatch = (word: string, value: string | undefined): Partial<Settings> | undefined => {
  if (word === 'model' && CODE_MODELS.includes(value as CodeModel)) return { code_model: value as CodeModel }
  if (word === 'effort' && CODE_EFFORTS.includes(value as CodeEffort)) return { code_effort: value as CodeEffort }
  if (word === 'navigator' && (value === 'haiku' || value === 'sonnet')) return { navigator: value }
  if (word === 'strict' && (value === 'on' || value === 'off')) return { strict: value === 'on' }
  if (word === 'log' && (value === 'on' || value === 'off' || value === 'full')) return { log: value }
  if (word === 'hooks' && (value === 'on' || value === 'off')) return { agent_hooks: value === 'on' }
  return orchestratorPatch(word, value)
}

const SETTING_CHOICES: Record<string, string> = { model: 'auto, sonnet, opus or fable', effort: 'medium, high, xhigh or auto (the main conversation decides each agent’s model and effort)', navigator: 'sonnet or haiku', strict: 'on or off', log: 'on, off or full', hooks: 'on or off', orchestrator: 'on or off', 'orchestrator-model': 'haiku, sonnet or opus', 'orchestrator-effort': 'auto, low, medium, high or xhigh (auto: the effort follows the prompt)', 'orchestrator-agents': 'a number from 1 to 6 (1: no fan-out)' }
// What `/gearbox <word>` of a removed setting answers.
const REMOVED_WORDS: Record<string, string> = {
  steer: 'steer is no longer a setting: gearbox always steers a session not on Haiku. To leave sessions alone, turn gearbox off (/gearbox off) or disable the plugin.',
  escalate: 'escalate is no longer a setting: work a session is below is always handed up (code, reviews, costly work, subtle questions). To fix the model code runs on, use /gearbox model.',
  band: 'band is no longer a setting: the band above the prompt is always shown.',
}
// The settings panel's blocks, each under its heading: a row per setting, as [label, /gearbox word, values, the value
// in use]. The orchestrator's model, effort and parallel agents only matter, and only show, while it is on.
export type SettingRow = [string, string, readonly string[], string]
export const settingsSections = (s: Settings): { id: string; title: string; rows: SettingRow[] }[] => [
  {
    id: 'coding',
    title: 'Coding',
    rows: [
      ['Model', 'model', CODE_MODELS, s.code_model],
      ['Effort', 'effort', CODE_EFFORTS, s.code_effort],
    ],
  },
  {
    id: 'handoffs',
    title: 'Hand-offs',
    rows: [
      ['Browser navigator', 'navigator', ['sonnet', 'haiku'], s.navigator],
      ['Strict', 'strict', ['on', 'off'], s.strict ? 'on' : 'off'],
      ['Hooks for agents', 'hooks', ['on', 'off'], s.agent_hooks ? 'on' : 'off'],
    ],
  },
  {
    id: 'orchestrator',
    title: 'Orchestrator',
    rows: [
      ['Orchestrator', 'orchestrator', ['on', 'off'], s.orchestrator ? 'on' : 'off'],
      ...(s.orchestrator
        ? ([
            ['Model', 'orchestrator-model', ['sonnet', 'opus', 'haiku'], s.orchestrator_model],
            ['Effort', 'orchestrator-effort', ORCHESTRATOR_EFFORTS, s.orchestrator_effort],
            ['Parallel agents', 'orchestrator-agents', ['1', '2', '3', '4', '5', '6'], String(s.orchestrator_agents)],
          ] satisfies SettingRow[])
        : []),
    ],
  },
  { id: 'debug', title: 'Debug', rows: [['Log', 'log', ['off', 'on', 'full'], s.log]] },
]

const settingsText = (s: Settings) =>
  `coding model ${s.code_model} · coding effort ${s.code_effort} · navigator ${s.navigator} · strict hand-offs ${s.strict ? 'on' : 'off'} · hooks for agents ${s.agent_hooks ? 'on' : 'off'} · orchestrator ${s.orchestrator ? `on (${s.orchestrator_model}·${s.orchestrator_effort}, up to ${s.orchestrator_agents} agent${s.orchestrator_agents === 1 ? '' : 's'} at once)` : 'off'} · log ${s.log}`

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

// A reviewing skill the model called, with the effort of the turn's own work, until the loop it forked is known.
type SkillCall = { skill: string; args: string; useId?: string; effort: ModelEffort }
// A known fork of one: how it was told (the Skill tool's answer, the agents' listing, or, as a fallback, the first
// agent the listing does not know), and whether its re-gearing is logged yet.
type SkillFork = { call: SkillCall; match: 'result' | 'listed' | 'fallback'; logged?: boolean }

// What /gearbox stored, without the keys of removed settings; `stale` says whether it held any.
const storedSettings = async ($: EngineInterface): Promise<{ kept: Partial<Settings>; stale: boolean }> => {
  const raw = await $.store.get('settings')
  const all: Record<string, unknown> = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return { kept: withoutRemoved(all) as Partial<Settings>, stale: Object.keys(all).some(removedKey) }
}

const saveSetting = async ($: EngineInterface, patch: Partial<Settings>) => {
  const { kept } = await storedSettings($)
  await $.store.set('settings', { ...kept, ...patch })
  await update($, SETTINGS, held => ({ ...held, ...patch }))
}


export const register: Register = (on, options) => {
  // The person's settings (userConfig): the model and effort for code, and the rest of /gearbox settings.
  let { code_model: codeModel, code_effort: codeEffort, navigator, strict, log: logMode, agent_hooks: agentHooks, orchestrator, orchestrator_model: orchModel, orchestrator_effort: orchEffort, orchestrator_agents: orchAgents } = settingsFrom(options, undefined)
  // The rules' coding effort; with `auto` (`chooses`), their floor, and the main conversation decides delegation once
  // it has read the work: whether to hand off, to which model, at which effort. gearbox then sets only the main
  // conversation's effort for the turn's first request, advises the rest and holds each agent to safe bounds (decide).
  let standing = standingOf(codeEffort)
  const chooses = () => codeEffort === 'auto'
  // The effort up to which a gear is not put to the person: their coding effort, and for code with `auto`, any, since
  // they left code's effort to the main conversation.
  const askFloor = (writes: boolean): ModelEffort => (chooses() && writes ? 'xhigh' : standing)
  const current = (): Settings => ({ code_model: codeModel, code_effort: codeEffort, navigator, strict, log: logMode, agent_hooks: agentHooks, orchestrator, orchestrator_model: orchModel, orchestrator_effort: orchEffort, orchestrator_agents: orchAgents })
  // What the main conversation runs on while the orchestrator hands off: its model, at its effort, or with `auto` at
  // BRIEFING, since briefing and reviewing the agent is the work (orchestratorPlan sets the rest per turn).
  const orchMain = (): Gear => ({ model: orchModel, effort: orchEffort === 'auto' ? BRIEFING : orchEffort })
  // The debug log of this session; see /gearbox log.
  const log: LogState = { pending: [] }
  const logEvent = (rec: Record<string, unknown>) => {
    if (logMode !== 'off') log.pending.push(JSON.stringify({ t: Date.now(), ...rec }))
  }
  const apply = (s: Settings) => {
    codeModel = s.code_model
    codeEffort = s.code_effort
    standing = standingOf(codeEffort)
    navigator = s.navigator
    strict = s.strict
    logMode = s.log
    agentHooks = s.agent_hooks
    orchestrator = s.orchestrator
    orchModel = s.orchestrator_model
    orchEffort = s.orchestrator_effort
    orchAgents = s.orchestrator_agents
  }
  // What the person's own hooks for agents need (see taskHooks).
  const hookState: AgentHooks = { base: {}, context: [], continued: new Set() }
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
  let mainSet = false // the main conversation set its own effort this turn, with the effort tool
  let turnText = '' // the person's prompt of the turn under way
  const typed: TypedIn = {} // the language the person writes in (see typedIn)
  // Deep work goes on where it started: `lastDeep` is the gear of the last typed turn's deep hand-off (a go-ahead
  // carries it on while its model is enough for the work approved), `deepAgent` the agent that took it, which
  // follow-ups go back to while worth it.
  let lastDeep: Gear | undefined
  let lastDeepCode = false // whether that work writes code, for a nod no reading says it of
  let heldDeep: { gear: Gear; code: boolean } | undefined // the deep work a planned hand-off replaced, back if its agent never starts
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
  const expectSpawn = (useId: string | undefined, job: { gear: Gear; lane: boolean; part?: number }) => {
    const key = useId ?? `\u0000${unnamed++}`
    spawningLanes.set(key, job)
    return key
  }
  const claimSpawn = (useId: string | undefined) => {
    const key = useId !== undefined && spawningLanes.has(useId) ? useId : [...spawningLanes.keys()].find(k => k.startsWith('\u0000'))
    const job = key === undefined ? undefined : spawningLanes.get(key)
    if (key !== undefined) spawningLanes.delete(key)
    return job
  }
  // Agent calls whose agent has started, by tool_use_id, until the call comes back: a call that fails with its agent
  // started (it ran, then ended in error) was a start; one that fails before is not.
  const begun = new Set<string>()
  // What the readouts are told of an agent about to start, by its Agent call's tool_use_id: who set its effort, and
  // whether it runs in a worktree of Claude Code's own. The loop takes it when the agent starts.
  const spawnMeta = new Map<string, { effortBy?: 'main' | 'rules'; isolated?: boolean }>()
  const expectMeta = (useId: string | undefined, meta: { effortBy?: 'main' | 'rules'; isolated?: boolean }) => {
    if (useId !== undefined) spawnMeta.set(useId, { ...spawnMeta.get(useId), ...meta })
  }
  // Whether this turn's fan-out starts its parts that edit with isolation "worktree": the session's folder is a git
  // repository (checked when the note is made, so the note and the calls agree), and no worktree has failed to be made.
  let turnIsolate = false
  let noWorktree = false
  // An Agent call that came back failed with no agent started, so it counted for nothing.
  const unstarted = (sent: { deny?: unknown; isError?: unknown }, useId: string | undefined): boolean => {
    const began = useId !== undefined && begun.delete(useId)
    return failed(sent) && !began
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
  // Whether a hand-off slot's work is a review: a fan-out's part that reviews, or the turn's own hand-off of a review.
  const reviewSlot = (slot: number): boolean =>
    turnHandoff?.kind === 'fan' ? !!turnHandoff.parts?.[slot]?.review : !turnRoute && slot === -1 && (turnHandoff?.kind === 'deep' || turnHandoff?.kind === 'lane' || turnHandoff?.kind === 'aside') && turnReading?.mode === 'review'
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
  // The fan-out's parts whose agent has not started, which the readouts draw as queued (◌) under main.
  const queuedParts = (): Queued[] =>
    turnHandoff?.kind === 'fan' ? (turnHandoff.parts ?? []).flatMap((pt, k) => (handedOff.has(k) ? [] : [{ label: `part ${k + 1} · ${pt.what}`, model: pt.gear.model, effort: pt.gear.effort }])) : []
  const stepLabel = (): string | undefined =>
    ownEffort ? `${ownEffort} sets its own effort` : routeLabel()
  const routeLabel = () => (turnRoute && turnStep ? `step ${turnStep}/${turnRoute.length} ${turnRoute[turnStep - 1]!.what}` : undefined)
  const agentWatch: AgentWatch = {}
  const forget = () => {
    floor = previous = turnGear = turnHandoff = turnRoute = turnStep = ownEffort = undefined
    mainSet = false
    lastDeep = deepAgent = spawningDeep = undefined
    lastDeepCode = false
    heldDeep = undefined
    spawningLanes.clear()
    begun.clear()
    spawnMeta.clear()
    noWorktree = false
    mainMayEdit = false
    lanes = {}
    laneEffort.clear()
    hookState.continued.clear()
    laneTaken = new Set()
    turnReading = undefined
    handedOff = new Set()
    turnWant = undefined
    skillCalls = []
    skillForks.clear()
    notForks.clear()
  }
  // A reviewing skill the model calls, in any loop: remembered until its fork is known. The Skill tool's answer names
  // a fork's agent, but the fork may send its first request before that answer is back, so it is remembered first.
  const callSkill = async <R,>(e: { skill?: unknown; args?: unknown; tool_use_id?: string }, run: () => Promise<R>): Promise<R> => {
    const skill = String(e.skill ?? '')
    if (!reviews(skill)) return run()
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
    await $.tool.register({
      name: 'effort',
      description:
        'gearbox: sets your own effort for the rest of this turn. Your effort was set before you read anything; call this when what you have read shows the turn needs more thought than it was given (subtle logic, a costly mistake, many files to keep consistent) or less (it turned out mechanical). The prompt cache is kept. xhigh is the top. It works while the coding effort is auto; otherwise the settings fix it.',
      inputSchema: {
        type: 'object',
        properties: {
          effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], description: 'the effort the rest of this turn needs' },
          why: { type: 'string', description: 'what you read that calls for it, in a few words' },
        },
        required: ['effort', 'why'],
      },
      isDeferred: false,
    })
    await $.command.register({ name: 'gearbox', description: 'Model routing and readout: /gearbox [settings | model auto|sonnet|opus|fable | effort <level> | navigator <model> | strict on|off | hooks on|off | log on|off|full | orchestrator on|off | orchestrator-model <model> | orchestrator-effort <level> | orchestrator-agents <1-6> | panel | on | off | ask on|off | usage]' })
    enabled = (await $.store.get('enabled')) !== false
    // What an older version stored for a removed setting is dropped once, so nothing reads or logs it again.
    const { kept: stored, stale } = await storedSettings($)
    if (stale) await $.store.set('settings', stored)
    apply(await loadSettings($, options))
    await update($, SETTINGS, () => stored)
    // A reload keeps the loops but drops the timer: the engine's list says again what is alive.
    if (enabled) {
      watchAgents($, agentWatch, () => showStatus($, turnHandoff, stepLabel()))
      await syncAgents($, agentWatch, () => showStatus($, turnHandoff, stepLabel()))
    }
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
            : `${settingsText(current())}. The settings panel has no room here; set one with /gearbox model|effort|navigator|strict <value>.`,
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
    if (Object.hasOwn(REMOVED_WORDS, word)) return { text: REMOVED_WORDS[word]! }
    if (word === 'pane' || word === 'panel') {
      // It lists every loop, finished ones included; an old `running` or `all` after it opens it all the same.
      const { isPlaced } = await $.ui.open({ id: PANE, title: PANE_TITLE })
      return { text: `${isPlaced ? 'pane open' : 'the pane opens once the window has room for it'}${value ? '. It lists every loop, finished ones included: panel running|all is gone' : ''}` }
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
      return { text: `unknown "${arg}". Try settings, panel, model, effort, navigator, strict, log, hooks, orchestrator, orchestrator-model, orchestrator-effort, orchestrator-agents, on, off, ask on, ask off, usage or usage reset.` }
    }
    const asks = (await $.store.get('consent')) !== false
    const session = await $.session.model()
    const mode = session.includes('haiku') ? 'shifting models' : family(session) || orchestrator ? `steering effort on ${family(session) ?? session}` : `readout only (${session} is not a model gearbox knows)`
    return {
      text: `${enabled ? `on, ${mode}` : 'off'} · ${settingsText(current())} · asks before costly gears: ${asks ? 'yes' : 'no'}${floor ? ` · main model ${floor}` : ''}${previous ? ` · last gear ${label(previous)}` : ''}\nChange settings with /gearbox settings, or /gearbox model|effort|navigator <value>.`,
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.turnId) return next(e) // typed into a running turn, which keeps its gear
    // A slash command or skill owns its turn's effort (its frontmatter, or Claude Code's own): no leftover gear.
    if (enabled && e.command && typedByPerson(e.origin)) {
      turnGear = turnHandoff = turnRoute = turnStep = turnWant = turnReading = undefined
      mainSet = false
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
      // With the orchestrator on `auto`, a notification (an agent's report coming back) is read and reviewed here: BRIEFING.
      if (enabled && orchestrator && orchEffort === 'auto' && turnGear && !e.command && !typedByPerson(e.origin)) {
        turnGear = { ...turnGear, effort: BRIEFING }
        mainSet = false
      }
      if (enabled && !e.command) logEvent({ ev: 'prompt', kind: e.origin?.kind ?? 'meta', keeps: turnGear ? label(turnGear) : 'no gear' })
      return next(e)
    }
    // A deep hand-off the last turn's model never started: what to count before tuning when work goes up.
    if (turnHandoff?.kind === 'deep' && !handedOff.has(-1)) logEvent({ ev: 'skipped', handoff: handoffLabel(turnHandoff) })
    // A fan-out some of whose agents the last turn's model never started.
    if (turnHandoff?.kind === 'fan' && fanOwed()) logEvent({ ev: 'skipped', handoff: handoffLabel(turnHandoff), owed: fanOwed() })
    // A hand-off planned but never started is not deep work under way (the main model may have answered itself):
    // the work it replaced, if any, is still the work under way.
    if ((turnHandoff?.kind === 'deep' || turnHandoff?.kind === 'lane' || turnHandoff?.kind === 'fan') && !handedOff.size) {
      lastDeep = heldDeep?.gear
      lastDeepCode = !!heldDeep?.code
    }
    heldDeep = undefined
    turnGear = turnHandoff = turnRoute = turnStep = turnWant = turnReading = undefined
    mainSet = false
    handedOff = new Set()
    laneTaken = new Set()
    spawningLanes.clear()
    begun.clear()
    spawnMeta.clear()
    skillCalls = []
    turnText = e.text
    hookState.context = []
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
    if (!orchestrator && !shifting && !fixed) {
      logEvent({ ev: 'gear', gear: 'untouched', why: 'the session runs a model gearbox does not know' })
      await setWhy($, ['untouched', 'unknown model'])
      return next(e)
    }
    const base = fixed ?? floor
    // A long conversation hands git chores to a fresh subagent: every request here re-reads the whole context.
    const context = (await $.session.usage()).context.tokens ?? 0
    const long = context >= LONG_CONTEXT
    let why = ''
    let brief: [string, string] = ['', '']

    let p: Plan
    let ask: Partial<Gear> = {}
    let lastMode: Reading['mode'] | undefined // what the survey read this turn as
    // Deep work goes on in the agent that holds it while that is worth it (its cache warm, its context not
    // yet past a fresh brief's), else in a fresh one on the same gear: never quietly back on this model.
    // With the orchestrator on, the agent is the model's lane; Fable's work is never a lane, always a fresh agent.
    const orchGear = orchMain()
    const sameAgent = (g: Gear) =>
      orchestrator && g.model !== 'fable'
        ? laneResumable(lanes[g.model], Date.now()) ? { resume: lanes[g.model]!.id } : {}
        : resumable(deepAgent, Date.now()) && deepAgent.gear.model === g.model ? { resume: deepAgent.id } : {}
    const goesOn = lastDeep
    // Deep work goes on in its agent for code, a question or a review; a commit, a long command or a browser check
    // has rules of its own.
    const goesOnIn = (mode: Reading['mode']) => mode === 'code' || mode === 'answer' || mode === 'review'
    // The model code is fixed to, if the person picked one: code runs on exactly it (see plan).
    const code = pinnedModel(codeModel)
    const goOn = (g: Gear): Plan => ({
      main: orchestrator ? orchGear : { model: base ?? STARTER.model, effort: BRIEFING },
      handoff: { kind: orchestrator && g.model !== 'fable' ? 'lane' : 'deep', gear: g, ...sameAgent(g) },
    })
    const describe = (r: Reading) => `${r.mode}, ${r.reach}, depth ${r.depth}${r.care === 'costly' ? ', costly' : ''}`
    // The rules on a reading: its gear, a route of its steps, or a hand-off. `goes`: the reading is of the work a
    // go-ahead approves, not of the message's words.
    const byRules = async (r: Reading, goes: boolean): Promise<Plan> => {
      let p: Plan
      why = `${goes ? 'go-ahead, the work it approves' : 'survey'}: ${describe(r)}${r.sure ? '' : r.mode === 'review' ? ' (unsure: its best guess)' : ' (unsure: its best guess, no hand-off)'}`
      brief = [`${goes ? 'go-ahead · ' : ''}${r.mode} · ${r.reach}`, `depth ${r.depth}${r.care === 'costly' ? ' · costly' : ''}${r.sure ? '' : ' · unsure'}`]
      ask = verifyAsk(r.ask, e.text)
      lastMode = r.mode
      const checked = { ...r, ask }
      const asks = (await $.store.get('consent')) !== false
      // Code on the coding model the person fixed runs on exactly that model, and is never put to them for it: they
      // chose it, as they chose their coding effort. A model they name for this request wins over it.
      const pinned = pins(checked, code)
      const stepCode = ask.model ? undefined : code
      const consentAsk = (g: Gear, fixedModel: boolean): Partial<Gear> => (fixedModel ? { ...ask, model: g.model } : ask)
      let want = gearFor(checked, standing, code)
      // A model named for a step counts only where the person's own words say it.
      const phases = r.phases.map(ph => ({ ...ph, ask: ph.ask && verifyAsk({ model: ph.ask }, e.text).model === ph.ask ? ph.ask : undefined }))
      // The orchestrator reads a request with several steps as one piece of work for one lane.
      if (!orchestrator && r.sure && r.phases.length >= 2) {
        // Several steps: one route, each step on its own executor and effort. Fable only as a subagent. Steps other
        // than code go up to the model the rules give the request.
        const lead = fixed ?? mainModel({ main: { model: upFor(want), effort: want.effort } }, ask, base)
        turnRoute = route(phases, lead, standing, r.care === 'costly', navigator, long, upFor(gearFor(checked, standing)), stepCode)
        for (const s of turnRoute) {
          const fixedModel = s.mode === 'code' && !!stepCode
          if ((s.by === 'main' || escalated(s)) && asks && needsConsent(s.gear, consentAsk(s.gear, fixedModel), previous, askFloor(s.mode === 'code'))) {
            s.gear = await consent($, s.gear, fixedModel)
            if (s.by === 'main') s.mainEffort = s.gear.effort
          }
        }
        p = { main: { model: lead, effort: workEffort(turnRoute) } }
        why += `; route of ${turnRoute.length} steps, starting at its work effort`
        brief = [`route · ${turnRoute.length} steps`, `starts at ${workEffort(turnRoute)}`]
      } else {
        if (asks && needsConsent(want, consentAsk(want, pinned), previous, askFloor(checked.mode === 'code'))) {
          const proposed = label(want)
          want = await consent($, want, pinned)
          why += `; you chose ${label(want)} over ${proposed}`
        }
        if (pinned) why += `; code on your coding model, ${want.model}`
        // Unsure: its best guess for the effort, but nothing handed off on a guess; a review is handed off all the same.
        // With the coding effort on `auto` the plan is advice, and what stays put gets none (staysPut).
        p = orchestrator ? orchestratorPlan(checked, want, orchGear, orchAgents, standing, code, orchEffort === 'auto', chooses()) : plan(checked, want, base, earlier.length > 0, fixed, navigator, long, pinned, chooses())
        // More of the same work: back to the agent that holds it. Unrelated work starts clean.
        if ((p.handoff?.kind === 'deep' || p.handoff?.kind === 'lane') && !r.aside) p = { ...p, handoff: { ...p.handoff, ...sameAgent(p.handoff.gear) } }
        if (orchestrator && r.parts.length) {
          const groups = fanOut(r.parts, orchAgents)
          logEvent({ ev: 'fan', parts: r.parts, cap: orchAgents, kept: p.handoff?.kind === 'fan' ? (p.handoff.parts?.length ?? 0) : 0, merged: groups.filter(g => g.length > 1).map(g => g.map(pt => pt.what).join(' + ')) })
        }
        // A fan-out: a costly part's gear goes to the person as a route step's does; then each model's lane, where it
        // is idle and worth going back to, takes the first part of its model. A nod goes back to the first part a
        // lane takes.
        if (p.handoff?.kind === 'fan') p = { ...p, handoff: await seatFan($, p.handoff.parts ?? [], { asks, ask, previous, standing, lanes, fresh: r.aside, code: stepCode, chooses: chooses() }) }
        // A turn the orchestrator keeps still hands out its lookups, long commands and browser checks: a route
        // whose other steps it does itself, at its own gear.
        if (orchestrator && keepsRoute(checked, p)) {
          // With `auto` and no effort asked for, its effort follows the steps' through the phase tool, as in steer mode.
          const follow = orchEffort === 'auto' && !ask.effort
          const own: Gear = { model: ask.model ?? orchModel, effort: ask.effort ?? (orchEffort === 'auto' ? p.main.effort : orchEffort) }
          turnRoute = orchestratorRoute(route(phases, own.model, standing, r.care === 'costly', navigator, long, own.model, stepCode), own, follow)
          if (follow) p = { ...p, main: { ...p.main, effort: capXhigh(workEffort(turnRoute)) } }
          const rest = follow ? `${own.model}, its effort following the steps` : label(own)
          why += `; route of ${turnRoute.length} steps, the rest here at ${rest}`
          brief = [`route · ${turnRoute.length} steps`, `the rest at ${rest}`]
        }
        if (ask.model || ask.effort) why += `; you asked for ${[ask.model, ask.effort].filter(Boolean).join(' ')}`
      }
      turnWant = want
      return p
    }

    // A message that goes ahead with work the assistant proposed or is doing ("lets do it", "continue", "yes, but
    // skip the docs") is geared by that work, never by its own few words: the assistant's last reply, which lays the
    // work out, is read as a request of its own, and what its text shows for sure (a schema migration, source files
    // across the project) lifts that reading (goAhead). A nod adds nothing to read, so only the work is read; only
    // when neither can be read does a nod keep the last gear.
    const nod = NOD.test(e.text.trim())
    const proposal = await lastReply($)
    const earlier = await recentAsks($)
    let msg: Reading | undefined // the message's own reading; none for a nod
    if (!nod || (!proposal && !previous && !goesOn)) {
      const started = Date.now()
      const s = await survey($, { request: e.text, earlier, previous, reply: proposal })
      msg = s.reading
      logEvent({ ev: 'survey', ms: Date.now() - started, reply: s.reply, reading: msg ?? null })
    }
    let work: Reading | undefined // the work a go-ahead approves, as the rules read it
    if (proposal && (nod || msg?.ahead || msg?.cont)) {
      const started = Date.now()
      // With the coding effort on `auto`, the survey reads what was approved, not only the reply's summary of it: the
      // spec, plan or mockup the reply points to. It only sharpens gearbox's advice; the main conversation decides.
      const files = chooses() ? await approvedFiles($, proposal) : { text: '', read: [] }
      const s = await survey($, { request: proposal, earlier, approved: true, files: files.text })
      const floor = workFloor(proposal)
      work = goAhead(s.reading, msg, floor)
      logEvent({ ev: 'survey', of: 'work', ms: Date.now() - started, reply: s.reply, reading: s.reading ?? null, ...(floor.care || floor.reach ? { floor } : {}), files: files.read })
    }
    const r = work ?? msg
    turnReading = r && { ...r, ask: verifyAsk(r.ask, e.text) }
    // Carrying on does not swallow independent parts: a continuation the plan would split fans out instead.
    const splits = !!turnReading && orchestrator && orchestratorPlan(turnReading, gearFor(turnReading, standing, code), orchGear, orchAgents, standing, code, false, chooses()).handoff?.kind === 'fan'
    // With the coding effort on `auto`, an answer that needs no deep look, or a guess, is the main conversation's own:
    // it goes on in no agent, by advice or otherwise.
    const putting = (reading: Reading | undefined) => chooses() && !!reading && staysPut(reading)
    if (work) {
      const checked = turnReading!
      const want = gearFor(checked, standing, code)
      // Code on a fixed coding model goes on only in an agent on that very model.
      const pinned = pins(checked, code)
      const enough = (held: Gear) => (pinned ? want.model === held.model : MODELS.indexOf(want.model) <= MODELS.indexOf(held.model))
      if (goesOn && !splits && !checked.ask.model && goesOnIn(checked.mode) && enough(goesOn) && !putting(checked)) {
        // Deep work under way, and its agent's model is enough for what comes next: it goes on there, never below the
        // work's effort (an effort the person names wins). Work that needs a stronger model, or a model the person
        // names, goes by the rules.
        let g: Gear = { model: goesOn.model, effort: checked.ask.effort ?? upTo(EFFORTS, goesOn.effort, want.effort) }
        why = `go-ahead after deep work, the work it approves: ${describe(work)}; it goes on in the subagent`
        if ((await $.store.get('consent')) !== false && needsConsent(g, pinned ? { ...checked.ask, model: g.model } : checked.ask, goesOn, askFloor(checked.mode === 'code'))) {
          const proposed = label(g)
          g = await consent($, g, pinned)
          why += `; you chose ${label(g)} over ${proposed}`
        }
        p = goOn(g)
        brief = ['go-ahead', `deep work goes on · ${work.mode} · ${work.reach}`]
        turnWant = want
      } else p = await byRules(work, true)
    } else if (nod && goesOn) {
      p = goOn(goesOn)
      why = `nod after deep work${proposal ? ', the work it approves unreadable' : ''}: it goes on in the subagent`
      brief = ['nod', 'deep work goes on']
    } else if (nod && previous) {
      // Nothing to read the work by: a nod after a proposal is usually the go-ahead to write it, never below the coding effort.
      p = { main: { ...previous, effort: upTo(EFFORTS, previous.effort, everyday(standing)) } }
      why = `nod${proposal ? ', the work it approves unreadable' : ''}: the last work gear, at least your coding effort`
      brief = ['nod', 'last gear, at least your coding effort']
    } else if ((!msg || (msg.cont && goesOnIn(msg.mode))) && goesOn && !splits && !putting(msg)) {
      // Carrying on deep work, or unreadable right after it (a failed read errs up): the same hand-off.
      p = goOn(goesOn)
      why = `${msg ? 'continuation' : 'survey unreadable'} after deep work: it goes on in the subagent`
      brief = [msg ? 'continuation' : 'unreadable', 'deep work goes on']
    } else if (!msg) {
      // Unreadable: the last gear, never below the person's coding effort; a failed read errs up.
      p = { main: previous ? { ...previous, effort: upTo(EFFORTS, previous.effort, everyday(standing)) } : { model: fixed ?? STARTER.model, effort: everyday(standing) } }
      why = `survey unreadable: ${previous ? 'previous gear, at least your coding effort' : 'your coding effort'}`
      brief = ['unreadable', previous ? 'last gear, at least your coding effort' : 'your coding effort']
    } else if (msg.cont && previous && !splits && !(goesOn && !goesOnIn(msg.mode))) {
      // A continuation with no work to read it by.
      p = { main: previous }
      why = 'continuation: previous gear'
      brief = ['continuation', 'kept the previous gear']
    } else p = await byRules(msg, false)
    // The orchestrator's main conversation runs on its own model, whatever the session or the floor.
    // A person's ask moves the turn only when it stays here; with a lane doing the work the orchestrator is the same.
    // With `auto`, its effort is the plan's (a nod, a continuation or an unreadable prompt reuse the last effort), xhigh at most.
    const orchEffortNow = orchEffort === 'auto' ? capXhigh(p.main.effort) : orchEffort
    turnGear = orchestrator
      ? p.handoff ? { model: orchModel, effort: orchEffortNow } : { model: ask.model ?? orchModel, effort: ask.effort ?? orchEffortNow }
      : { model: mainModel(p, ask, base), effort: p.main.effort }
    // The orchestrator edits files itself only for a one-spot change the plan kept here.
    mainMayEdit = orchestrator && !p.handoff && lastMode === 'code'
    // What a nod, a notification or an unreadable prompt reuses: the gear of the work itself, never the low
    // effort of a turn that only briefs a subagent.
    if (!p.handoff || !previous) previous = turnGear
    // Whether the work handed off writes code: what the turn's reading says, or, for a nod no reading says it of, what
    // the work it goes on with did. A fan-out's parts say it each.
    if (p.handoff?.kind === 'deep' || p.handoff?.kind === 'lane' || p.handoff?.kind === 'aside')
      p = { ...p, handoff: { ...p.handoff, code: turnReading ? turnReading.mode === 'code' : lastDeepCode } }
    turnHandoff = p.handoff
    heldDeep = lastDeep && (p.handoff?.kind === 'deep' || p.handoff?.kind === 'lane' || p.handoff?.kind === 'fan') ? { gear: lastDeep, code: lastDeepCode } : undefined
    lastDeep = p.handoff?.kind === 'deep' || p.handoff?.kind === 'lane' || p.handoff?.kind === 'fan' ? p.handoff.gear : undefined
    lastDeepCode = !!lastDeep && (p.handoff?.kind === 'fan' ? nodPartEdits(p.handoff) : !!p.handoff?.code)
    // byRules sets the route in a closure, which the type checker does not follow from the reset above.
    const steps = turnRoute as Step[] | undefined
    logEvent({
      ev: 'gear',
      gear: label(turnGear),
      context,
      why: ownEffort ? `${why}; ultrathink: Claude Code sets the effort` : why,
      ...(p.handoff ? { handoff: handoffLabel(p.handoff) } : {}),
      ...(steps ? { route: steps.map((s, i) => `${i + 1}. ${s.what}: ${s.by} ${label(s.gear)}`) } : {}),
    })
    if (p.handoff) brief = [brief[0], `${brief[1]} · ${handoffLabel(p.handoff)}`]
    await setWhy($, ownEffort ? ['ultrathink', 'Claude Code sets the effort'] : brief)
    turnIsolate = p.handoff?.kind === 'fan' && apartEdits(p.handoff.parts ?? []) && !noWorktree && (await inGitRepo($))
    // With the coding effort on `auto`, a deep, lane or fan note is advice, with the reading it comes from.
    const note = turnRoute ? routeNote(turnRoute, chooses()) : p.handoff ? handoffNote(p.handoff, chooses(), turnIsolate, turnReading ? readingWhy(turnReading) : 'more of the work under way') : undefined
    return next(note ? { ...e, context: [...(e.context ?? []), note] } : e)
  })

  // The route's phase tool: the main model calls it as each step starts, and later steps run at that step's effort.
  // The orchestrator's main conversation stays at its own gear throughout.
  on('tool.call', { tool: 'mcp__gearbox__phase' }, async ($, e) => {
    const n = Number((e as any).input?.step ?? (e as any).step)
    const s = turnRoute?.[n - 1]
    if (!s || !turnGear) return { result: 'gearbox: no route step with that number in this turn', isError: true as const }
    if (!orchestrator || orchEffort === 'auto') turnGear = { ...turnGear, effort: s.mainEffort }
    mainSet = false
    turnStep = n
    logEvent({ ev: 'phase', step: n, what: s.what, by: s.by, effort: s.mainEffort })
    await setWhy($, [`route ${n}/${turnRoute!.length}`, `${s.what} · ${s.by === 'agent' ? label(s.gear) : s.mainEffort}`])
    await showStatus($, undefined, stepLabel())
    // A tool's result is a string (or content blocks), never an object.
    // With the coding effort on `auto`, the step's agent is gearbox's suggestion: the model and effort the call names win.
    return { result: s.by === 'agent' ? (chooses() ? `step ${n}: gearbox suggests a ${s.gear.model} subagent at ${s.gear.effort}; the model and effort you name on its call win` : `step ${n}: hand it to a ${s.gear.model} subagent at ${s.gear.effort}`) : `step ${n}: you now run at effort ${s.mainEffort}` }
  })

  // The effort tool: the main conversation's effort is set before it reads anything, so once it has read the work it may
  // raise or lower its own for the rest of the turn (effort changes keep the prompt cache), up to xhigh. Only with the
  // coding effort on `auto`, and an orchestrator's effort that follows the turn: a level the person set stands.
  on('tool.call', { tool: 'mcp__gearbox__effort' }, async ($, e) => {
    const say = (text: string) => ({ result: text })
    const input = ((e as any).input ?? e) as { effort?: unknown; why?: unknown }
    if (!enabled) return say('gearbox is off: Claude Code sets your effort.')
    if (e.agentId) return say("gearbox: this sets the main conversation's effort; yours is set by the agent that started you.")
    if (!chooses()) return say(`gearbox: your effort is fixed by the settings (coding effort ${codeEffort}), so it stays${turnGear ? ` at ${turnGear.effort}` : ''}. The person can leave it to you with /gearbox effort auto.`)
    if (orchestrator && orchEffort !== 'auto') return say(`gearbox: your effort is fixed by the settings (orchestrator effort ${orchEffort}). The person can leave it to the turn with /gearbox orchestrator-effort auto.`)
    if (ownEffort) return say(`gearbox: ${ownEffort} sets this turn's effort, so it stays as Claude Code set it.`)
    if (!turnGear) return say('gearbox: no turn of yours is under way to set the effort of.')
    const asked = String(input.effort ?? '').toLowerCase() as ModelEffort
    if (!EFFORTS.includes(asked)) return { result: 'gearbox: effort must be low, medium, high or xhigh.', isError: true as const }
    const effort = capXhigh(asked)
    const from = turnGear.effort
    turnGear = { ...turnGear, effort }
    // What a nod reuses is the work's gear: a turn that hands nothing off is that work.
    if (!turnHandoff) previous = turnGear
    mainSet = true
    logEvent({ ev: 'effort', from, to: effort, why: String(input.why ?? '').slice(0, 200), ...(asked !== effort ? { asked } : {}) })
    await setWhy($, ['your effort', `${effort} · set by main`])
    await showStatus($, turnHandoff, stepLabel())
    return say(`gearbox: your effort is now ${effort} for the rest of this turn${asked !== effort ? ' (xhigh is the top)' : ''}.`)
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
    const code = r.ask.model ? undefined : pinnedModel(codeModel)
    const fan = fanParts(r, orchAgents, standing, code)
    const merged = fanOut(parts, orchAgents).filter(g => g.length > 1).map(g => g.map(pt => pt.what).join(' + '))
    if (!fan.length) {
      const why = whyNoFan(parts, orchAgents)
      logEvent({ ev: 'fan', via: 'tool', parts, cap: orchAgents, kept: 0, merged, why })
      return say(`gearbox: not worth splitting: ${why}. Go on with it as one piece of work${turnHandoff ? ', as the hand-off note says' : ''}.`)
    }
    const handoff = await seatFan($, fan, { asks: (await $.store.get('consent')) !== false, ask: r.ask, previous, standing, lanes, fresh: r.aside, code, chooses: chooses() })
    // The turn's hand-off is now the fan-out, as if the survey had listed these parts.
    turnHandoff = handoff
    turnIsolate = apartEdits(handoff.parts ?? []) && !noWorktree && (await inGitRepo($))
    handedOff = new Set()
    deepReads = 0
    mainMayEdit = false
    turnGear = orchMain()
    lastDeep = handoff.gear
    lastDeepCode = nodPartEdits(handoff)
    logEvent({ ev: 'fan', via: 'tool', parts, cap: orchAgents, kept: fan.length, merged, handoff: handoffLabel(handoff) })
    await setWhy($, ['fan-out', handoffLabel(handoff)])
    await showStatus($, handoff, stepLabel())
    return say(fanReply(handoff.parts ?? [], chooses(), turnIsolate))
  })

  // Claude Code runs the person's UserPromptSubmit and Stop hooks for the main conversation only. An agent gets them
  // here, every way it starts or is sent a task (agent.spawn, session.send) and when it stops (classic.SubagentStop).
  // What the main prompt's hooks ran on is kept to run them on an agent's task, and the context they gave it, as the
  // model read it, for the agents whose hooks cannot be run here.
  on('classic.UserPromptSubmit', ($, e, next) => {
    hookState.base = { session_id: e.session_id, transcript_path: e.transcript_path, cwd: e.cwd, permission_mode: e.permission_mode }
    return next(e)
  })
  on('prompt.attachment', ($, e, next) => {
    if (e.origin.kind === 'hook' && e.origin.event === 'UserPromptSubmit' && !e.agentId) {
      const text = e.text.replace(/^UserPromptSubmit hook [\w ]+?: /, '')
      if (!hookState.context.includes(text)) hookState.context.push(text)
    }
    return next(e)
  })

  // An Agent call that names no model and no agent type runs on the main conversation's model.
  // Every subagent that starts gets a row in the readout, and the person's UserPromptSubmit hooks run on its task.
  // A resumed run keeps the message it is resumed with (session.send has had its hooks).
  on('agent.spawn', async ($, e, next) => {
    const routed =
      enabled && floor && !e.model && !e.fork && !e.parentAgentId && e.subagentType === 'general-purpose' && e.parentModel.includes('haiku')
        ? { ...e, model: floor }
        : e
    const hooked = enabled && agentHooks && !e.resume ? await taskHooks($, hookState, logEvent, e.prompt, e.subagentType) : undefined
    if (hooked?.deny) return { deny: hooked.deny }
    const nests = enabled && !e.parentAgentId && !e.fork && !e.resume
    // An agent outside a hand-off never sees the person's messages, so the language of its notes is spelled out.
    const language = nests ? await typedIn($, typed, turnText) : undefined
    const brief = `${hooked?.brief ?? ''}${nests ? `${NESTING}${notesIn(language)}` : ''}`
    const started = await next(brief ? { ...routed, prompt: `${routed.prompt}${brief}` } : routed)
    if (enabled && !started.deny && started.agentId) {
      if (e.tool_use_id) begun.add(e.tool_use_id)
      if (nests && e.tool_use_id) {
        const id = started.agentId
        await update($, REPORTS, all => Object.fromEntries([...Object.entries(all).filter(([k]) => k !== id), [id, { texts: all[id]?.texts ?? [], useId: e.tool_use_id }]].slice(-KEEP_REPORTS)))
      }
      // Its first steps may land before this, so keep what they recorded.
      const meta = e.tool_use_id ? spawnMeta.get(e.tool_use_id) : undefined
      if (e.tool_use_id) spawnMeta.delete(e.tool_use_id)
      // The agent a lane hand-off or a fan-out's part started runs on the job's effort; a lane's becomes that
      // model's lane, a part's only when the plan gave it the lane. It starts at the top effort, but its requests run
      // at the job's: that is the effort the readouts show, from the moment it starts.
      const job = !e.parentAgentId && !e.resume ? claimSpawn(e.tool_use_id) : undefined
      await patch($, started.agentId, l => ({
        steps: 0,
        asked: started.model,
        since: Date.now(),
        ...(l ? revived(l) : {}),
        ...(job ? { effort: job.gear.effort } : {}),
        state: 'working',
        label: e.description,
        parent: e.parentAgentId ?? 'main',
        ...(meta?.effortBy ? { effortBy: meta.effortBy } : {}),
        ...(meta?.isolated && !l?.worktree ? { worktree: 'worktree' } : {}),
      }))
      await showStatus($, turnHandoff, stepLabel())
      watchAgents($, agentWatch, () => showStatus($, turnHandoff, stepLabel()))
      // The agent a deep or handed-up step started: follow-ups go back to it.
      const deep = !e.parentAgentId && !e.resume && spawningDeep !== undefined && (spawningDeep.useId === undefined || spawningDeep.useId === e.tool_use_id)
      if (deep) {
        deepAgent = { id: started.agentId, gear: spawningDeep!.gear, at: Date.now(), tokens: 0 }
        spawningDeep = undefined
      } else if (e.resume && deepAgent?.id === e.resume.agentId) deepAgent = { ...deepAgent, at: Date.now() }
      if (job) {
        laneEffort.set(started.agentId, job.gear.effort)
        if (job.lane) lanes = { ...lanes, [job.gear.model]: { id: started.agentId, at: Date.now(), tokens: 0 } }
      }
      logEvent({ ev: 'spawn', agent: started.agentId, type: e.subagentType, model: started.model, ...(language ? { notes: language } : {}), ...(deep ? { deep: true } : {}), ...(job?.lane ? { lane: true } : {}), ...(job?.part ? { part: job.part } : {}), ...(e.resume ? { resume: true } : {}) })
    }
    return started
  })

  // A message the main conversation sends an agent is a task as well: the hooks run on it, and what they print goes
  // with it. One between agents is left alone.
  on('session.send', async ($, e, next) => {
    if (!enabled || !agentHooks || e.agentId) return next(e)
    const agent = (await listAgents($))?.find(a => [a.id, a.name, a.teammateId].includes(e.to))
    const hooked = agent && (await taskHooks($, hookState, logEvent, e.text, agent.type))
    if (hooked?.deny) return { isDelivered: false as const, reason: hooked.deny }
    return next(hooked ? { ...e, text: `${e.text}${hooked.brief}` } : e)
  })

  // An agent that stops is put to the person's Stop hooks as the main conversation is: a block, or feedback they
  // print, sends it back to work. Their SubagentStop hooks have run beneath. An agent with no type is one of Claude
  // Code's own (a suggestion, a side question), not a task.
  on('classic.SubagentStop', async ($, e, next) => {
    const own = await next(e)
    if (!enabled || !agentHooks || !e.agent_type) return own
    const said = await stopHooks($, hookState, logEvent, e)
    if (!said.block && !said.context.length) return own
    return {
      ...own,
      ...(said.block ? { block: [own.block, said.block].filter(Boolean).join('\n') } : {}),
      ...(said.context.length ? { additionalContext: [...(own.additionalContext ?? []), ...said.context] } : {}),
    }
  })

  // The worktree a loop works in, for the readouts: one it makes with `git worktree add`, and the one Claude Code says an
  // agent started with isolation ran in (its result carries the path and the branch, once it has ended).
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const sent = await next(e)
    const made = enabled && !failed(sent) ? worktreeAdd(String(e.command ?? '')) : undefined
    if (made) await patch($, e.agentId ?? 'main', l => l && withWorktree(l, made))
    return sent
  })
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const sent = await next(e)
    const r = (sent as { result?: { agentId?: string; worktreePath?: string; worktreeBranch?: string } }).result
    if (enabled && !failed(sent) && typeof r === 'object' && r?.agentId && (r.worktreePath || r.worktreeBranch)) await patch($, r.agentId, l => l && withWorktree(l, { path: r.worktreePath, branch: r.worktreeBranch }))
    return sent
  })

  on('tool.call', async ($, e, next) => {
    if (!enabled) return next(e)
    await patch($, e.agentId ?? 'main', l => l && called(l, String(e.tool), e as unknown as Record<string, unknown>))
    if (e.tool === 'Agent' && e.isolation === 'worktree') expectMeta(e.tool_use_id, { isolated: true })
    // Subagents do the hand-off work; never stand in their way. A reviewing skill one calls is still remembered.
    if (e.agentId && e.tool === 'Agent') {
      // An agent the main conversation started may start agents that read for it, on Sonnet at low effort (Haiku
      // when it asks, for a lookup); not ones that change code, and none deeper. Any other loop (a skill's fork, a
      // workflow's agent) runs its own agents as it always did.
      const started = await read($, REPORTS)
      const parent = (await read($, LOOPS))[e.agentId]?.parent
      const reader = parent !== undefined && started[parent] !== undefined
      if (!started[e.agentId] && !reader) return next(e)
      const why = reader
        ? 'an agent started by another agent cannot start agents of its own. Do this reading yourself.'
        : READERS.test(String(e.subagent_type ?? ''))
          ? undefined
          : 'an agent may start only agents that read (subagent_type "Explore"); make code changes yourself.'
      logEvent({ ev: 'nested', agent: e.agentId, type: e.subagent_type ?? 'general-purpose', ...(why ? { refused: true } : { set: `${e.model === 'haiku' ? 'haiku' : 'sonnet'}·low` }) })
      if (why) {
        // No agent starts, so it gets a row of its own, ended: the person sees what was refused.
        const [label, asked, parent] = [String(e.description ?? 'agent'), String(e.subagent_type ?? 'agent'), e.agentId]
        await patch($, `refused:${e.tool_use_id ?? Date.now()}`, () => ended({ label, parent, asked, state: 'done', steps: 0 }, Date.now(), { failed: 'refused', result: why }))
        return { deny: `gearbox: ${why}` }
      }
      expectMeta(e.tool_use_id, { effortBy: 'rules' })
      return next({ ...e, model: e.model === 'haiku' ? 'haiku' : 'sonnet', effort: 'low' })
    }
    if (e.agentId) return e.tool === 'Skill' ? callSkill(e, () => next(e)) : next(e)
    // A plain Agent call during a hand-off runs on that step's model and effort, whatever the call named; any
    // other plain one keeps its model and gets an effort by its job, not the session's. Work handed up to a
    // stronger model keeps its gear even when the call names a typed agent that works (not a read-only search),
    // and its brief gets the person's own recent words under it. With the coding effort on `auto` the call wins
    // instead, within bounds (decide): the step's gear is gearbox's advice, which fills only what the call leaves out.
    const plain = e.tool === 'Agent' && (!e.subagent_type || e.subagent_type === 'general-purpose')
    const h = e.tool === 'Agent' ? nextHandoff(String(e.description ?? '')) : undefined
    const up = h && upSlot(h.slot)
    const asked = e.tool === 'Agent' ? `${e.model ?? 'default'}·${e.effort ?? 'default'}` : ''
    if (e.tool === 'Agent' && h && (plain || (up && !SEARCHERS.test(String(e.subagent_type))))) {
      // The hand-off counts as started at once, so Agent calls made in one message each take a part of their own; a
      // call that fails before its agent starts undoes all of it below, and leaves the part open for a retry.
      handedOff.add(h.slot)
      const d = chooses() ? await decide($, e, h.gear, { review: reviewSlot(h.slot), asked: turnReading?.ask.model, code: codeModel }) : undefined
      const gear: Gear = d?.gear ?? h.gear
      const deep = up?.keeps ? { useId: e.tool_use_id, gear } : undefined
      if (deep) spawningDeep = deep
      // A lane starts at the top effort and every message lowers it to the job's. So does a fan-out's part, which
      // runs in the foreground beside the others, in a worktree of its own when two or more parts edit (Claude Code's
      // when the session's folder is a git repository, else the part's own), and every agent the main conversation
      // decides (the coding effort `auto`), so a follow-up that asks for more takes hold in full.
      const lane = orchestrator && !turnRoute && turnHandoff?.kind === 'lane'
      const part = orchestrator && !turnRoute && turnHandoff?.kind === 'fan' ? turnHandoff.parts?.[h.slot] : undefined
      const apart = !!part?.edits && apartEdits(turnHandoff?.parts ?? [])
      const isolated = apart && turnIsolate
      const topped = lane || !!part || !!d
      const start = topped ? laneStart(gear.effort) : gear.effort
      // The lane is that of the model the agent runs on: a call that names another model than the plan's takes that
      // model's lane, unless an agent of this turn has it already. Fable's work is never a lane.
      const planned = lane || !!part?.lane || !!part?.resume
      const takesLane = planned && (!d || (gear.model !== 'fable' && (gear.model === h.gear.model || !laneTaken.has(gear.model))))
      const laneWas = laneTaken.has(gear.model)
      if (takesLane) laneTaken.add(gear.model)
      const expected = topped ? expectSpawn(e.tool_use_id, { gear, lane: takesLane, ...(part ? { part: h.slot + 1 } : {}) }) : undefined
      logEvent({ ev: 'agent', type: e.subagent_type ?? 'general-purpose', asked, set: label(gear), ...(d ? d.log : {}), ...(topped ? { lane: start } : {}), ...(part ? { part: h.slot + 1, ...(apart ? { isolation: isolated ? 'worktree' : 'own' } : {}) } : {}), ...(up ? (turnGear && MODELS.indexOf(gear.model) < MODELS.indexOf(turnGear.model) ? { down: true } : { up: true }) : {}) })
      const call = {
        ...e,
        model: gear.model,
        effort: start,
        ...(part ? { run_in_background: false, ...(isolated ? { isolation: 'worktree' as const } : {}) } : {}),
        ...(up || lane || part ? { prompt: `${e.prompt ?? ''}${ownBrief(await personSaid($, turnText), !!part)}` } : {}),
      }
      // A worktree that was seen to fail is not asked for again, by gearbox or by the call itself.
      if (noWorktree && call.isolation === 'worktree') delete (call as { isolation?: unknown }).isolation
      expectMeta(e.tool_use_id, { effortBy: d?.effortBy ?? 'rules', isolated: call.isolation === 'worktree' })
      const sent = await next(call)
      if (!unstarted(sent, e.tool_use_id)) {
        // What a nod goes on with is the agent the work went to, on the model it runs on, not the one advised; its
        // effort stays the work's, which the next go-ahead is advised at no less than.
        if (d && lastDeep && (h.slot === -1 ? turnHandoff?.kind === 'deep' || turnHandoff?.kind === 'lane' : !!part && nodPart(turnHandoff?.parts ?? []) === part)) lastDeep = { ...lastDeep, model: gear.model }
        return sent
      }
      if (e.tool_use_id) spawnMeta.delete(e.tool_use_id)
      handedOff.delete(h.slot)
      if (expected !== undefined) spawningLanes.delete(expected)
      if (takesLane && !laneWas) laneTaken.delete(gear.model)
      if (deep && spawningDeep === deep) spawningDeep = undefined
      const why = String(sent.deny ?? sent.text ?? (typeof sent.result === 'string' ? sent.result : ''))
      logEvent({ ev: 'failed', tool: 'Agent', ...(part ? { part: h.slot + 1 } : {}), why: why.slice(0, 200) })
      // A worktree Claude Code could not make, though gearbox found a repository (an unborn branch, say): stop asking,
      // so a retry is not refused the same way. The agent never started, so this answer stands in for the error.
      if (call.isolation === 'worktree' && /worktree/i.test(why)) {
        noWorktree = true
        turnIsolate = false
        return { deny: `${why}\n${WORKTREE_FAILED}` }
      }
      return sent
    }
    // The orchestrator's turn without a hand-off (work it kept, a nod whose work could not be read, an unreadable
    // prompt): a plain agent is still that model's lane, the first of its model this turn only; another beside it is a
    // fresh agent for the turn. Past a fan-out's parts it is not: it gets an effort by its job, below. With the coding
    // effort on `auto` the call wins, within bounds (decide), and its brief is read for gearbox's pick and to tell a
    // review; Fable it names is a fresh agent, never a lane.
    const named = e.tool === 'Agent' ? family(String(e.model ?? '')) : undefined
    if (orchestrator && e.tool === 'Agent' && plain && !h && turnHandoff?.kind !== 'fan' && (chooses() || named !== 'fable')) {
      let job: Gear = { model: named ?? 'sonnet', effort: everyday(standing) }
      let d: Decided | undefined
      if (chooses()) {
        const read = await jobGear($, String(e.prompt ?? e.description ?? ''), standing, pinnedModel(codeModel))
        d = await decide($, e, { model: read?.model ?? 'sonnet', effort: read?.effort ?? everyday(standing) }, { review: !!read?.reviews, asked: turnReading?.ask.model, code: codeModel })
        job = d.gear
      }
      const model = job.model
      const first = model !== 'fable' && !laneTaken.has(model)
      if (first) laneTaken.add(model)
      const key = expectSpawn(e.tool_use_id, { gear: job, lane: first })
      logEvent({ ev: 'agent', type: 'general-purpose', asked, set: label(job), lane: laneStart(job.effort), why: first ? 'a lane without a hand-off' : model === 'fable' ? 'Fable, never a lane' : `beside the ${model} lane, for this turn only`, ...(d ? d.log : {}) })
      expectMeta(e.tool_use_id, { effortBy: d?.effortBy ?? 'rules' })
      const sent = await next({ ...e, model, effort: laneStart(job.effort) })
      // Failed before its agent started: the model's lane is still free, and a retry is its first.
      if (unstarted(sent, e.tool_use_id)) {
        if (e.tool_use_id) spawnMeta.delete(e.tool_use_id)
        spawningLanes.delete(key)
        if (first) laneTaken.delete(model)
      }
      return sent
    }
    if (e.tool === 'Agent' && plain) {
      const job = await jobGear($, String(e.prompt ?? e.description ?? ''), standing, pinnedModel(codeModel))
      if (chooses()) {
        // With the coding effort on `auto` the call wins here too, within bounds (decide), and the job fills what it
        // leaves out. An agent that names no model runs on the main conversation's, as before, unless gearbox moves it
        // (a review below Opus, code on the coding model). It starts at the top effort and runs each request at its
        // own, so a follow-up's effort line takes hold in full.
        const own = turnGear?.model ?? STARTER.model
        const d = await decide($, e, { model: job?.model ?? own, effort: job?.effort ?? everyday(standing) }, { review: !!job?.reviews, asked: turnReading?.ask.model, code: codeModel })
        const model = e.model || d.gear.model !== own ? d.gear.model : undefined
        const key = expectSpawn(e.tool_use_id, { gear: d.gear, lane: false })
        logEvent({ ev: 'agent', type: e.subagent_type ?? 'general-purpose', asked, set: label(d.gear), lane: laneStart(d.gear.effort), why: 'its job', ...d.log })
        expectMeta(e.tool_use_id, { effortBy: d.effortBy })
        const sent = await next({ ...e, ...(model ? { model } : {}), effort: laneStart(d.gear.effort) })
        if (unstarted(sent, e.tool_use_id)) {
          if (e.tool_use_id) spawnMeta.delete(e.tool_use_id)
          spawningLanes.delete(key)
        }
        return sent
      }
      logEvent({ ev: 'agent', type: e.subagent_type ?? 'general-purpose', asked, set: job ? `${job.model ?? e.model ?? 'default'}·${job.effort}` : 'unchanged', why: job?.model ? 'its job: code, on your coding model' : 'its job' })
      if (job) expectMeta(e.tool_use_id, { effortBy: 'rules' })
      return next(job ? { ...e, ...(job.model ? { model: job.model } : {}), effort: job.effort } : e)
    }
    // Going back to the agent that holds deep work counts as this turn's hand-off.
    const sendTo = e.tool === 'SendMessage' ? String((e as any).to ?? '') : ''
    // With the coding effort on `auto`, a follow-up's first line "effort: <level>" is the main conversation's choice of
    // the job's effort; gearbox takes the line off, whoever the message goes to.
    const line = sendTo && chooses() ? effortLine(String((e as any).message ?? '')) : undefined
    if (line?.effort) e = { ...e, message: line.message } as typeof e
    const picked = line?.effort
    const lane = sendTo ? laneOf(sendTo) : undefined
    if (lane) {
      // A message to a lane is a job: set its effort before the lane's requests go out. In a fan-out the job is the
      // part the lane was given, else a part of its model not started yet. The effort its first line names wins.
      const parts = turnHandoff?.kind === 'fan' ? (turnHandoff.parts ?? []) : []
      const k = [parts.findIndex((p, i) => !handedOff.has(i) && p.resume === lane.id), parts.findIndex((p, i) => !handedOff.has(i) && p.gear.model === lane.model)].find(i => i >= 0)
      const pick = k !== undefined ? parts[k]!.gear.effort : (handoffGear()?.effort ?? everyday(standing))
      const job = picked ?? pick
      const sent = await next(e)
      if (!failed(sent)) {
        handedOff.add(k ?? -1)
        laneTaken.add(lane.model)
        laneEffort.set(lane.id, job)
        lanes = { ...lanes, [lane.model]: { id: lane.id, at: Date.now(), tokens: lane.tokens } }
        // The work went to the lane the main conversation chose: a nod goes on there.
        if (chooses() && lastDeep && k === undefined && (turnHandoff?.kind === 'lane' || turnHandoff?.kind === 'deep')) lastDeep = { ...lastDeep, model: lane.model }
        await patch($, lane.id, l => l && { ...l, effortBy: picked ? 'main' : 'rules' })
        logEvent({ ev: 'resume', agent: lane.id, lane: true, effort: job, ...(chooses() ? { chosen: picked ? 'main' : 'rules', advised: pick, agrees: job === pick } : {}), ...(k !== undefined ? { part: k + 1 } : {}) })
      }
      return sent
    }
    if (e.tool === 'SendMessage' && deepAgent && sendTo === deepAgent.id) {
      // An agent whose effort is the main conversation's (it started at the top) runs a follow-up at the effort its
      // first line names, else, as a lane's job, at gearbox's pick for the work.
      const pick = chooses() && (turnHandoff?.kind === 'deep' || turnHandoff?.kind === 'lane') && laneEffort.has(deepAgent.id) ? handoffGear()?.effort : undefined
      const job = picked ?? pick
      const sent = await next(e)
      if (!failed(sent)) {
        handedOff.add(-1)
        deepAgent = { ...deepAgent, at: Date.now() }
        if (job) laneEffort.set(deepAgent.id, job)
        if (job) await patch($, deepAgent.id, l => l && { ...l, effortBy: picked ? 'main' : 'rules' })
        logEvent({ ev: 'resume', agent: deepAgent.id, ...(job ? { effort: job, chosen: picked ? 'main' : 'rules', ...(pick ? { advised: pick, agrees: job === pick } : {}) } : {}) })
      }
      return sent
    }
    // Any other agent the main conversation started at the top: the effort its first line names is its next job's.
    if (picked && laneEffort.has(sendTo)) {
      const sent = await next(e)
      if (!failed(sent)) {
        laneEffort.set(sendTo, picked)
        await patch($, sendTo, l => l && { ...l, effortBy: 'main' })
        logEvent({ ev: 'resume', agent: sendTo, effort: picked, chosen: 'main' })
      }
      return sent
    }
    const tool = String(e.tool)
    // Not a change to code: a mockup or note it writes for the person (see writesNoCode).
    const notCode = async () => {
      const path = (e as { file_path?: unknown }).file_path
      return /^(Edit|Write|MultiEdit)$/.test(tool) && typeof path === 'string' && writesNoCode(path, await $.session.cwd().catch(() => ''), await repoRoot($))
    }
    // Strict holds the main conversation to a deep, lane or fan hand-off only with a fixed coding effort. With `auto`
    // the hand-off was advice, and the main conversation, which has read the work, may do it itself.
    const holds = strict && !chooses()
    // The orchestrator does not write code: a change goes to a lane, except the one-spot edit its plan kept here.
    if (orchestrator && holds && !mainMayEdit && !deepPending() && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) && !(await notCode())) {
      logEvent({ ev: 'strict', tool, mode: 'orchestrator', refused: true })
      const held = laneResumable(lanes.sonnet, Date.now()) ? lanes.sonnet : undefined
      return {
        deny: `gearbox orchestrator: the main conversation does not write code. Start an Agent with no subagent_type and model "sonnet" with a brief that stands on its own${held ? ` (or SendMessage to "${held.id}", the sonnet lane that already holds this work)` : ''}; it makes the change and you review what it returns. (The person can allow doing it here with /gearbox strict off, or turn the orchestrator off with /gearbox orchestrator off.)`,
      }
    }
    // Strict: deep work is the stronger model's. Until its agent starts, the main model may read a little to write
    // the brief, but not edit, run commands or keep reading: a note alone was ignored (bench/escalation, layer B).
    if (holds && deepPending() && !BRIEFING_TOOLS.test(tool)) {
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
    // means debugging. Either way the rest of the turn runs at least at the coding effort. An effort the main
    // conversation set itself, having read the work, is no guess: it stands.
    const below = () => turnGear !== undefined && !ownEffort && !mainSet && EFFORTS.indexOf(turnGear.effort) < EFFORTS.indexOf(everyday(standing))
    const lift = (why: string) => {
      turnGear = previous = { ...turnGear!, effort: everyday(standing) }
      logEvent({ ev: 'raise', tool, effort: everyday(standing), why })
    }
    if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) && below()) {
      lift('the turn edits files')
      await showStatus($, turnHandoff, stepLabel())
    }
    const result = tool === 'Skill' ? await callSkill(e, () => next(e)) : await next(e)
    if (/^(Bash|PowerShell)$/.test(tool) && isLongCommand(String((e as any).command ?? '')) && 'isError' in result && result.isError && below()) {
      lift('a test or build failed')
      await showStatus($, turnHandoff, stepLabel())
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (enabled) {
      // A subagent's turn can end with the agent still alive, waiting on background work it started: it is done
      // only once the engine says so.
      const waits = e.agentId ? held((await listAgents($))?.find(a => a.id === e.agentId)?.status) : false
      const at = Date.now()
      await patch($, e.agentId ?? 'main', l => {
        if (!l) return l
        // An agent that ended keeps the first line of its report, and how it ended if not well.
        if (e.agentId && !waits) return ended(l, at, { failed: e.reason === 'refusal' ? 'refused' : e.reason === 'error' ? 'failed' : e.isAborted ? 'stopped' : undefined, result: noteOf(e.answer) })
        const { doing: _, said: __, ...rest } = l
        return { ...rest, state: !e.agentId ? 'idle' : 'waiting' }
      })
      // The main conversation's reply is where a person reads "done": before it is drawn, every agent the engine
      // holds alive gets its row, however it started.
      if (waits || !e.agentId) {
        watchAgents($, agentWatch, () => showStatus($, turnHandoff, stepLabel()))
        await syncAgents($, agentWatch, () => showStatus($, turnHandoff, stepLabel()))
      }
      // An agent of the main conversation that ended (not one waiting on its own work) handed back its report.
      const report = e.agentId && !waits && e.answer.trim() ? e.agentId : undefined
      if (report && (await read($, LOOPS))[report]?.parent === 'main')
        await update($, REPORTS, all => ({ ...all, [report]: { ...all[report], texts: [...(all[report]?.texts ?? []), e.answer].slice(-5) } }))
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
    // Who set this loop's effort, where gearbox does: its rules (or the orchestrator's effort per prompt, for main) for
    // main and a skill's fork, or the main conversation itself with the effort tool; an agent started with a call gets
    // it when it starts.
    const effortBy: GearboxLoop['effortBy'] = e.agentId ? (fork ? 'rules' : undefined) : turnGear && !ownEffort ? (mainSet ? 'main' : orchestrator && orchEffort === 'auto' ? 'auto' : 'rules') : undefined
    const sending = async (s: typeof e) => {
      if (!enabled) return
      // An agent that waited on its own background work and is back at a turn changes the status line's count too, and
      // so does one whose request goes at another model or effort than the line shows.
      let woke = false
      let regeared = false
      await patch($, id, l => {
        woke = l?.state === 'waiting'
        // An agent that ends and is sent on starts clean. The main conversation's effort is set afresh each request; an
        // agent keeps the one it started with.
        const row: Partial<GearboxLoop> = (l?.state === 'done' ? revived(l) : l) ?? {}
        const { effortBy: _, ...main } = row
        const sent: GearboxLoop = {
          label: fork ? `/${fork.call.skill}` : e.agentId ? 'agent' : 'main',
          ...(e.agentId ? { parent: 'main' } : {}),
          since: Date.now(),
          steps: 0,
          ...(e.agentId ? row : main),
          asked: s.model,
          ...(s.effort !== undefined ? { effort: String(s.effort) } : {}),
          ...(effortBy ? { effortBy } : {}),
          state: 'working',
        }
        regeared = !l || gearText(l) !== gearText(sent)
        return sent
      })
      if (!e.agentId || woke || regeared) await showStatus($, turnHandoff, stepLabel())
      await countRequest($, family(s.model) ?? String(s.model))
    }
    await sending(step)
    // Its text is watched, not changed: the latest note of this request is what the loop shows as its now.
    const texts = new Map<number, string>()
    let written: string | undefined
    let writtenAt = 0
    const note = async (force: boolean) => {
      const latest = [...texts.entries()].sort(([a], [b]) => a - b).map(([, t]) => noteOf(t)).filter(Boolean).at(-1)
      if (!enabled || !latest || latest === written || (!force && Date.now() - writtenAt < NOTE_EVERY_MS)) return
      // The line a request is still writing grows into its note; any other is a new one.
      const growing = grown(written, latest)
      written = latest
      writtenAt = Date.now()
      // The tool shown beside the note stays the last one called until a new call replaces it.
      await patch($, id, l => l && withNote({ ...l, said: latest }, latest, writtenAt, growing))
    }
    // A note that cannot be written never breaks the stream.
    const quietly = (force: boolean) => note(force).catch(() => undefined)
    // Read by hand to see each chunk, so what `yield*` would do is done here: a consumer that stops early (Esc) or
    // throws into this generator reaches the stream beneath, which is always settled.
    const stream = next(step)
    let finished = false
    let chunk: Awaited<ReturnType<typeof stream.next>>
    try {
      chunk = await stream.next()
      while (!chunk.done) {
        let sent: unknown
        try {
          sent = yield chunk.value
        } catch (err) {
          finished = true
          await stream.throw(err)
          throw err
        }
        void sent
        if (chunk.value.kind === 'text') {
          texts.set(chunk.value.index, (texts.get(chunk.value.index) ?? '') + chunk.value.text)
          await quietly(false)
        }
        chunk = await stream.next()
      }
      finished = true
    } finally {
      if (!finished) await stream.return?.(undefined as never)
    }
    const result = chunk.value
    await quietly(true)
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
    if (u) await tally($, u)
    if (u && enabled) await patch($, id, l => l && withUsage(l, spent(u)))
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

  // The band above the prompt: GearBox and its actions, then main and the tree of its agents, two lines each (a card
  // each in the desktop app, under a row of metrics): ● in a turn, ◐ waiting on its own background work, ◌ a part not
  // started, ✓ finished (until the next prompt), ✗ failed, ⚠ answered by another model. Whatever the mods below draw in
  // this slot stays, under it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!enabled || e.props.hasSurvey) return next(e)
    const below = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const loops = await read($, LOOPS)
    const turn = await read($, TURN)
    const s = settingsFrom(options, await read($, SETTINGS))
    const usd = await sessionCost($)
    const subs = nested(loops)
    const thisTurn = usd !== undefined && turn.costAtStart !== undefined ? usd - turn.costAtStart : undefined
    const turnCosts = thisTurn !== undefined ? [...turn.costs, thisTurn] : turn.costs
    const avg = turnCosts.length ? turnCosts.reduce((a, b) => a + b, 0) / turnCosts.length : undefined
    const choose = async (change: Partial<Settings>) => {
      await saveSetting($, change)
      apply(await loadSettings($, options))
    }
    // shortcut: the run time is as of the band's last redraw (any loop's request or tool call); add a clock tick if a long silent tool makes it look stuck.
    const summary: Summary = {
      loops,
      // Parts the main conversation owes only while something is under way.
      queued: loops.main?.state === 'working' || subs.length ? queuedParts() : [],
      ...(turn.at !== undefined ? { since: turn.at } : {}),
      now: Date.now(),
      subs,
      requests: Object.entries(turn.requests),
      ...(usd !== undefined ? { usd } : {}),
      ...(thisTurn !== undefined ? { thisTurn } : {}),
      ...(avg !== undefined ? { avg } : {}),
      turnCosts,
      // Bars and an average only once there are turns to compare.
      compare: turnCosts.length > 1,
      ...(turn.why ? { why: turn.why } : {}),
      handoff: turnHandoff !== undefined,
      counted: subs.length ? counted(subs) : '',
      gears: subs.length ? gearsText(subs.map(([, l]) => l), ' · ') : '',
    }
    const actions = (
      <Box flexDirection="row" columnGap={e.surface === 'terminal' && e.props.bodyColumns >= NARROW ? 2 : 1}>
        <Button key="band-pane" dimColor label="Panel" onPress={() => void $.ui.open({ id: PANE, title: PANE_TITLE })} />
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
    )
    // The terminal draws text as a tree; the desktop app a card per agent.
    const mine = e.surface === 'terminal' ? terminalBand({ Box, Text }, summary, { columns: e.props.bodyColumns, actions }) : desktopBand({ Box, Text }, summary, { columns: e.props.bodyColumns, actions })
    return below ? (
      <Box flexDirection="column" rowGap={1}>
        {mine}
        {below}
      </Box>
    ) : (
      mine
    )
  })

  // An agent's report, drawn for the person where its end shows: under its notification when it ran in the
  // background, under its call when it ran in the foreground. The main model then adds its review, not a copy
  // (RELAY). The expanded view (ctrl+o) shows the engine's own row, report included.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!enabled || e.props.isExpanded || e.props.origin.kind !== 'task-notification' || !e.props.task?.id) return next(e)
    const texts = (await read($, REPORTS))[e.props.task.id]?.texts
    if (!texts?.length) return next(e)
    return reportBelow($.ui.resolve(e), await next(e), texts)
  })
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!enabled || e.props.tool !== 'Agent' || e.props.isExpanded || e.props.isErrored || (e.props.output as { status?: string } | null)?.status !== 'completed') return next(e)
    const texts = Object.values(await read($, REPORTS)).find(r => r.useId === e.props.tool_use_id)?.texts
    if (!texts?.length) return next(e)
    return reportBelow($.ui.resolve(e), await next(e), texts)
  })

  // /gearbox settings: a block per kind of setting under a small heading, framed so each stands apart, and in it a row
  // of buttons per setting; the value in use is marked, a press saves another.
  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = settingsFrom(options, await read($, SETTINGS))
    // A desktop pane is narrow and its measured row height ignores wrapped buttons: the label sits above its buttons
    // there, so they have the whole width and a row's height is its own.
    const stacked = e.surface !== 'terminal'
    const labelW = stacked ? 0 : Math.max(...settingsSections(s).flatMap(sec => sec.rows.map(([title]) => title.length))) + 2
    return (
      <Box flexDirection="column" rowGap="md">
        {settingsSections(s).map(({ id, title, rows }) => (
          <Box key={`settings-${id}`} flexDirection="column">
            <Text weight="semibold" size="footnote" dimColor>
              {title}
            </Text>
            <Box flexDirection="column" rowGap="sm" borderStyle="round" borderDimColor paddingX="sm" {...(stacked ? { paddingY: 'sm' } : {})}>
              {rows.map(([label, word, values, current]) => (
                <Box flexDirection={stacked ? 'column' : 'row'} columnGap={1} rowGap="xs" alignItems={stacked ? 'flex-start' : 'center'}>
                  <Text mono>{label.padEnd(labelW)}</Text>
                  <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                    {values.map(v => (
                      <Button
                        key={`${word}-${v}`}
                        label={v === current ? `${v} ✓` : v}
                        variant={v === current ? 'primary' : 'secondary'}
                        onPress={() => saveSetting($, settingPatch(word, v)!)}
                      />
                    ))}
                  </Box>
                </Box>
              ))}
            </Box>
          </Box>
        ))}
        <Text dimColor>The marked value is in use. Changes apply from your next prompt. Esc closes.</Text>
      </Box>
    )
  })

  // /gearbox panel: every loop of the session, finished ones included, nested under the loop that started it, a block each.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if (!enabled) return <Text dimColor>gearbox is off. /gearbox on turns it back on.</Text>
    const loops = await read($, LOOPS)
    if (!Object.keys(loops).length) return <Text dimColor>No model calls yet. Rows appear as the session works.</Text>
    const subs = alive(loops)
    return panelBody({ Box, Text }, loops, loops.main?.state === 'working' || subs.length ? queuedParts() : [], { now: Date.now(), cwd: await $.session.cwd().catch(() => undefined), handoff: turnHandoff !== undefined, mono: e.surface !== 'terminal', columns: e.props.bodyColumns })
  })
}
