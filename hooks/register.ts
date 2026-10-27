import type { EngineInterface, PromptOrigin, Register, TurnUsage } from 'claude-code'
import {
  type Gear,
  type Handoff,
  type Model,
  type Plan,
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

const kilo = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))

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
  const p = PRICES[MODELS.find(m => model.includes(m)) ?? 'opus']
  return (r.fresh * p.fresh + r.written * p.written + r.cached * p.cached + r.out * p.out) / 1e6
}

export const usageReport = (ledger: Ledger) => {
  const rows = Object.entries(ledger)
  if (!rows.length) return 'gearbox: nothing used yet'
  const lines = rows.map(([m, r]) => `${m}  ${r.calls} calls  ${kilo(r.fresh + r.written + r.cached)} in  ${kilo(r.out)} out  ≈ $${dollars(m, r).toFixed(2)}`)
  const total = rows.reduce((sum, [m, r]) => sum + dollars(m, r), 0)
  return [...lines, `total ≈ $${total.toFixed(2)} at API list prices, subagents included`].join('\n')
}

export const register: Register = on => {
  // shortcut: this state lives in module variables, so a hot reload forgets the floor; the next prompt picks afresh.
  let enabled = true
  let floor: Model | undefined // the main conversation's model so far: it only rises, and never to fable
  let previous: Gear | undefined // the last main gear, for carry-on replies
  let turnGear: Gear | undefined // the gear of the turn under way
  let turnHandoff: Handoff | undefined
  const forget = () => {
    floor = previous = turnGear = turnHandoff = undefined
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'gearbox', description: 'Per-prompt model routing for Haiku sessions: /gearbox [on | off | ask on | ask off | usage | usage reset]' })
    enabled = (await $.store.get('enabled')) !== false
    return next(e)
  })

  // /clear starts a fresh context, so the next prompt may pick any gear.
  on('session.end', ($, e, next) => {
    if (e.reason === 'clear') forget()
    return next(e)
  })

  on('command.run', { command: 'gearbox' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      enabled = arg === 'on'
      await $.store.set('enabled', enabled)
      // Off means plain Haiku again; on picks afresh at the next prompt.
      if (!enabled) {
        forget()
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
      return { text: `gearbox: unknown "${arg}". Try on, off, ask on, ask off, usage or usage reset.` }
    }
    const asks = (await $.store.get('consent')) !== false
    return {
      text: `gearbox ${enabled ? 'on' : 'off'} · asks before costly gears: ${asks ? 'yes' : 'no'}${floor ? ` · main model ${floor}` : ''}${previous ? ` · last gear ${label(previous)}` : ''}`,
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.turnId) return next(e) // typed into a running turn, which keeps its gear
    turnGear = turnHandoff = undefined
    if (!enabled || e.command || e.isMeta || !typedByPerson(e.origin)) return next(e)
    if (!(await $.session.model()).includes('haiku')) return next(e)

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
        let want = gearFor(checked)
        if ((await $.store.get('consent')) !== false && needsConsent(want, ask, previous)) want = await consent($, want)
        p = plan(checked, want, floor, earlier.length > 0)
      }
    }
    turnGear = previous = { model: mainModel(p, ask, floor), effort: p.main.effort }
    turnHandoff = p.handoff
    return next(p.handoff ? { ...e, context: [...(e.context ?? []), handoffNote(p.handoff)] } : e)
  })

  // An Agent call that names no model and no agent type runs on the main conversation's model.
  on('agent.spawn', ($, e, next) =>
    enabled && floor && !e.model && !e.fork && !e.parentAgentId && e.subagentType === 'general-purpose' && e.parentModel.includes('haiku')
      ? next({ ...e, model: floor })
      : next(e),
  )

  // Only the main conversation is shifted, and only while the session itself is on Haiku: pick another model
  // in the app and gearbox steps aside. Prompts nobody typed run on the floor. Every step's usage is tallied.
  on('turn.step', async function* ($, e, next) {
    let step = e
    if (!e.agentId) {
      const model = enabled && e.model.includes('haiku') ? turnGear?.model ?? floor : undefined
      if (model) {
        if (floor && model !== floor && e.index === 0) {
          const tokens = (await $.session.usage()).context.tokens ?? 0
          $.ui.toast(`gearbox: shifting to ${model}, re-caching ${kilo(tokens)} tokens ≈ $${((tokens * PRICES[model].written) / 1e6).toFixed(2)}`)
        }
        floor = nextFloor(model, floor)
        step = { ...e, model, effort: turnGear?.effort ?? e.effort }
        $.ui.status(`gearbox ▸ ${model}·${step.effort ?? 'default'}${turnHandoff ? ` ⇢ ${turnHandoff.gear.model} ${KIND[turnHandoff.kind]}` : ''}`)
      } else {
        $.ui.status(undefined)
      }
    }
    const result = yield* next(step)
    if (result.usage) await tally($, result.usage)
    return result
  })
}
