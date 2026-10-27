import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelEffort, PromptOrigin, Register, TurnUsage } from 'claude-code'
import type { GearboxLoop } from '../types'
import {
  type Gear,
  type Handoff,
  type Model,
  type Plan,
  type Step,
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
    maxTokens: 400,
    timeoutMs: 12_000,
  })
  $.ui.log(`gearbox survey: ${r.isAnswered ? r.text.trim() : `no reply (${r.reason})`}`, { to: 'debug' })
  return r.isAnswered ? readReading(r.text) : undefined
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

export const register: Register = (on, options) => {
  // The person's settings (userConfig): effort for ordinary coding turns, and whether non-Haiku sessions are steered.
  const standing: ModelEffort = CODE_EFFORTS.includes(options.code_effort as ModelEffort) ? (options.code_effort as ModelEffort) : 'medium'
  const steers = options.steer !== false
  // shortcut: routing state lives in module variables, so a hot reload forgets the floor; the next prompt picks afresh.
  // The readout's loops live in $.state and survive it.
  let enabled = true
  let floor: Model | undefined // the main conversation's model so far: it only rises, and never to fable
  let previous: Gear | undefined // the last main gear, for carry-on replies
  let turnGear: Gear | undefined // the gear of the turn under way
  let turnHandoff: Handoff | undefined
  let turnRoute: Step[] | undefined // the steps of a multi-step request, in order
  let turnStep: number | undefined // the route step under way
  const stepLabel = () => (turnRoute && turnStep ? `step ${turnStep}/${turnRoute.length} ${turnRoute[turnStep - 1]!.what}` : undefined)
  const forget = () => {
    floor = previous = turnGear = turnHandoff = turnRoute = turnStep = undefined
  }

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'phase',
      description: 'gearbox: call with a step number from the gearbox route as you start that step; gearbox sets your effort for it.',
      inputSchema: { type: 'object', properties: { step: { type: 'integer', minimum: 1 } }, required: ['step'] },
      isDeferred: false,
    })
    await $.command.register({ name: 'gearbox', description: 'Model routing and readout: /gearbox [pane | on | off | ask on | ask off | usage | usage reset]' })
    enabled = (await $.store.get('enabled')) !== false
    return next(e)
  })

  // /clear starts a fresh context, so the next prompt may pick any gear.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      forget()
      await update($, LOOPS, () => ({}))
    }
    return next(e)
  })

  on('command.run', { command: 'gearbox' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'pane') {
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
      return { text: `gearbox: unknown "${arg}". Try pane, on, off, ask on, ask off, usage or usage reset.` }
    }
    const asks = (await $.store.get('consent')) !== false
    const session = await $.session.model()
    const mode = session.includes('haiku') ? 'shifting models' : steers ? `steering effort on ${family(session) ?? session}` : 'readout only'
    return {
      text: `gearbox ${enabled ? `on, ${mode}` : 'off'} · coding effort ${standing} · asks before costly gears: ${asks ? 'yes' : 'no'}${floor ? ` · main model ${floor}` : ''}${previous ? ` · last gear ${label(previous)}` : ''}`,
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.turnId) return next(e) // typed into a running turn, which keeps its gear
    turnGear = turnHandoff = turnRoute = turnStep = undefined
    if (!enabled || e.command || e.isMeta || !typedByPerson(e.origin)) return next(e)
    // A Haiku session shifts models; any other keeps its model and is only steered (effort and handoffs).
    const session = await $.session.model()
    const shifting = session.includes('haiku')
    const fixed = shifting ? undefined : family(session)
    if (!shifting && (!steers || !fixed)) return next(e)
    const base = fixed ?? floor

    let p: Plan
    let ask: Partial<Gear> = {}
    if (previous && NOD.test(e.text.trim())) {
      p = { main: previous }
    } else {
      const earlier = await recentAsks($)
      const r = await survey($, e.text, earlier, previous)
      if (!r || !r.sure) {
        p = { main: previous ?? STARTER }
      } else if (r.cont && previous) {
        p = { main: previous }
      } else {
        ask = verifyAsk(r.ask, e.text)
        const checked = { ...r, ask }
        const asks = (await $.store.get('consent')) !== false
        let want = gearFor(checked, standing)
        if (r.phases.length >= 2) {
          // Several steps: one route, each step on its own executor and effort. Fable only as a subagent.
          const lead = fixed ?? mainModel({ main: { model: want.model === 'fable' ? 'opus' : want.model, effort: want.effort } }, ask, base)
          turnRoute = route(r.phases, lead, standing, r.care === 'costly')
          for (const s of turnRoute) {
            if (s.by === 'main' && asks && needsConsent(s.gear, ask, previous, standing)) {
              s.gear = await consent($, s.gear)
              s.mainEffort = s.gear.effort
            }
          }
          p = { main: { model: lead, effort: turnRoute[0]!.mainEffort } }
        } else {
          if (asks && needsConsent(want, ask, previous, standing)) want = await consent($, want)
          p = plan(checked, want, base, earlier.length > 0, fixed)
        }
      }
    }
    turnGear = previous = { model: mainModel(p, ask, base), effort: p.main.effort }
    turnHandoff = p.handoff
    const note = turnRoute ? routeNote(turnRoute) : p.handoff ? handoffNote(p.handoff) : undefined
    return next(note ? { ...e, context: [...(e.context ?? []), note] } : e)
  })

  // The route's phase tool: the main model calls it as each step starts, and later steps run at that step's effort.
  on('tool.call', { tool: 'mcp__gearbox__phase' }, async ($, e) => {
    const n = Number((e as any).input?.step ?? (e as any).step)
    const s = turnRoute?.[n - 1]
    if (!s || !turnGear) return { result: { ok: false }, text: 'gearbox: no route step with that number in this turn' }
    turnGear = { ...turnGear, effort: s.mainEffort }
    turnStep = n
    await showStatus($, undefined, stepLabel())
    return {
      result: { ok: true },
      text: s.by === 'agent' ? `step ${n}: hand it to a ${s.gear.model} subagent at ${s.gear.effort}` : `step ${n}: you now run at effort ${s.mainEffort}`,
    }
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
    }
    return started
  })

  on('tool.call', async ($, e, next) => {
    if (enabled) await patch($, e.agentId ?? 'main', l => l && { ...l, doing: String(e.tool) })
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
      if (turnGear) step = { ...step, effort: turnGear.effort }
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
    }
    const result = yield* next(step)
    if (enabled) await patch($, id, l => l && { ...l, ...(result.usage ? { answered: result.usage.model } : {}), steps: l.steps + 1 })
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

  // /gearbox pane: every loop of the session, nested under the loop that started it.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if (!enabled) return <Text dimColor>gearbox is off. /gearbox on turns it back on.</Text>
    const loops = await read($, LOOPS)
    const rows = Object.entries(loops).sort(([a], [b]) => (a === 'main' ? -1 : b === 'main' ? 1 : 0))
    if (!rows.length) return <Text dimColor>No model calls yet. Rows appear as the session works.</Text>
    const width = Math.max(40, e.props.bodyColumns)
    const [gearW, stepsW] = [15, 6]
    const nameW = Math.min(30, Math.max(12, Math.floor((width - gearW - stepsW) * 0.45)))
    const nowW = Math.max(8, width - nameW - gearW - stepsW)
    return (
      <Box flexDirection="column">
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
