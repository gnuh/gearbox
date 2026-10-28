// The lane probe: can a mod set a resumed subagent's effort per message, and does that keep its prompt cache?
// A SendMessage from the main conversation whose message starts with `[lane-effort:<level>]` asks for that effort:
// the tag is taken out, and every request of the addressed agent's next turn goes at that level. Every request is
// logged with the effort the engine meant to send, the one sent, and its usage. Inert unless LANE_PROBE_LOG is set.
import type { EngineInterface, Register } from 'claude-code'

const TAG = /^\s*\[lane-effort:(low|medium|high|xhigh|max)\]\s*/

type LogState = { path?: string | null; body: string; pending: string[] }

const flushLog = async ($: EngineInterface, s: LogState) => {
  if (s.path === undefined) s.path = (await $.env.get('LANE_PROBE_LOG')) || null
  if (!s.path || !s.pending.length) return
  s.body += s.pending.splice(0).map(l => `${l}\n`).join('')
  await $.fs.write(s.path, s.body)
}

export const register: Register = on => {
  const state: LogState = { body: '', pending: [] }
  const log = (rec: Record<string, unknown>) => state.pending.push(JSON.stringify({ t: Date.now(), ...rec }))

  const ids = new Map<string, string>() // an agent's name, and its id, to its id
  const want = new Map<string, string>() // agent id to the effort its next turn runs at

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (!started.deny && started.agentId) {
      ids.set(started.agentId, started.agentId)
      if (e.name) ids.set(e.name, started.agentId)
      const a = e as unknown as Record<string, any>
      log({ ev: 'spawn', agent: started.agentId, name: e.name ?? null, model: started.model, effort: a.effort ?? null, resume: a.resume?.agentId ?? null })
      await flushLog($, state)
    }
    return started
  })

  on('tool.call', async ($, e, next) => {
    const a = e as unknown as Record<string, any>
    if (!e.agentId && e.tool === 'SendMessage' && typeof a.message === 'string') {
      const m = TAG.exec(a.message)
      const to = String(a.to ?? '')
      const agent = ids.get(to)
      if (m && agent) want.set(agent, m[1]!)
      log({ ev: 'send', to, agent: agent ?? null, effort: m?.[1] ?? null })
      await flushLog($, state)
      return next(m ? { ...e, message: a.message.replace(TAG, '') } : e)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const effort = e.agentId ? want.get(e.agentId) : undefined
    const sent = effort ? { ...e, effort: effort as typeof e.effort } : e
    const r = yield* next(sent)
    const u = r.usage
    log({
      ev: 'step',
      agent: e.agentId ?? 'main',
      turn: e.turnId,
      index: e.index,
      model: e.model,
      engine: e.effort ?? null,
      sent: sent.effort ?? null,
      usage: u ? { in: u.input_tokens, write: u.cache_creation_input_tokens, read: u.cache_read_input_tokens, out: u.output_tokens } : null,
    })
    await flushLog($, state)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) want.delete(e.agentId)
    log({ ev: 'done', agent: e.agentId ?? 'main' })
    await flushLog($, state)
    return next(e)
  })
}
