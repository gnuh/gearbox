// Layer A of the escalation bench: does each fixed prompt go to the model it should? Runs the survey exactly as
// gearbox does (SURVEY as the system prompt, the same JSON input, Sonnet at low effort) through `claude -p` in safe
// mode, so neither gearbox nor your hooks touch the call, then decides with gearbox's own rules from policy.ts, as
// a steered session would. Consent questions are taken as accepted. Work a session is below is always handed up (the
// escalate setting is gone); `--code-model` fixes the model code runs on, as /gearbox model does.
//
//   bun bench/escalation/decide.ts [--runs 3] [--only id,id] [--parallel 6] [--session sonnet] [--effort xhigh] [--code-model auto]
import { tmpdir } from 'node:os'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CodeModel, type Gear, type Model, type Reading, SURVEY, escalated, gearFor, label, mainModel, pinnedModel, pins, plan, readReading, route, trimRequest, upFor, verifyAsk } from '../../hooks/policy'

type Case = { id: string; prompt: string; earlier?: string[]; long?: boolean; expect: string | string[]; note?: string }
type Outcome = { worker: Model; gear: string; how: string }
type Run = { reading?: Reading; reply: string; usd: number; outcome?: Outcome }

const flag = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}
const RUNS = Number(flag('runs', '3'))
const PARALLEL = Number(flag('parallel', '6'))
const SESSION = flag('session', 'sonnet') as Model
const STANDING = flag('effort', 'xhigh') as Gear['effort']
const CODE_MODEL = flag('code-model', 'auto') as CodeModel
const CODE = pinnedModel(CODE_MODEL)
const only = flag('only', '')

const here = import.meta.dir
const cases: Case[] = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8')).filter((c: Case) => !only || only.split(',').includes(c.id))

const survey = async (c: Case): Promise<Run> => {
  const input = JSON.stringify({ request: trimRequest(c.prompt), earlier: c.earlier ?? [], previous: null })
  const p = Bun.spawn(['claude', '-p', '--safe-mode', '--model', 'sonnet', '--effort', 'low', '--tools', '', '--system-prompt', SURVEY, '--output-format', 'json', input], {
    cwd: tmpdir(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => p.kill(), 90_000)
  const out = await new Response(p.stdout).text()
  await p.exited
  clearTimeout(timer)
  try {
    const j = JSON.parse(out)
    const reply = String(j.result ?? '')
    return { reading: readReading(reply), reply, usd: Number(j.total_cost_usd ?? 0) }
  } catch {
    return { reply: `no reply: ${out.slice(0, 200)}`, usd: 0 }
  }
}

// Who does the work of the turn on a session fixed on SESSION, by the same calls register.tsx makes.
const decide = (r: Reading | undefined, c: Case): Outcome => {
  const base = SESSION
  if (!r) return { worker: base, gear: '-', how: 'survey unreadable' }
  const ask = verifyAsk(r.ask, c.prompt)
  const checked = { ...r, ask }
  const want = gearFor(checked, STANDING, CODE)
  const earlier = c.earlier ?? []
  if (r.sure && r.phases.length >= 2) {
    const phases = r.phases.map(ph => ({ ...ph, ask: ph.ask && verifyAsk({ model: ph.ask }, c.prompt).model === ph.ask ? ph.ask : undefined }))
    const steps = route(phases, base, STANDING, r.care === 'costly', 'sonnet', c.long ?? false, upFor(gearFor(checked, STANDING)), ask.model ? undefined : CODE)
    const up = steps.find(escalated)
    return { worker: up ? up.gear.model : base, gear: up ? label(up.gear) : '-', how: `route: ${steps.map(s => `${s.what} → ${s.by === 'agent' ? label(s.gear) : `main ${s.mainEffort}`}`).join('; ')}` }
  }
  const p = r.sure ? plan(checked, want, base, earlier.length > 0, base, 'sonnet', c.long ?? false, pins(checked, CODE)) : { main: { model: base, effort: want.effort } }
  const h = p.handoff
  if (h?.kind === 'deep' || h?.kind === 'aside') return { worker: h.gear.model, gear: label(h.gear), how: `${h.kind} hand-off` }
  if (h?.kind === 'drive' && h.judge) return { worker: h.judge.model, gear: label(h.judge), how: `browser check, judged by ${label(h.judge)}` }
  const main = mainModel(p, ask, base)
  return { worker: main, gear: `${main}·${p.main.effort}`, how: h ? `${h.kind} hand-off to ${label(h.gear)}, main does the rest` : r.sure ? 'main conversation' : 'main conversation (survey unsure)' }
}

const accepts = (c: Case, m: Model) => c.expect === 'any' || (Array.isArray(c.expect) ? c.expect.includes(m) : c.expect === m)
const shortReading = (r?: Reading) => (r ? `${r.mode}·${r.reach}·d${r.depth}${r.care === 'costly' ? '·costly' : ''}${r.sure ? '' : '·unsure'}${r.phases.length >= 2 ? `·${r.phases.length} steps` : ''}` : 'unreadable')

const jobs = cases.flatMap(c => Array.from({ length: RUNS }, (_, k) => ({ c, k })))
const runs = new Map<string, Run[]>(cases.map(c => [c.id, []]))
let next = 0
const worker = async () => {
  while (next < jobs.length) {
    const { c } = jobs[next++]!
    const run = await survey(c)
    run.outcome = decide(run.reading, c)
    runs.get(c.id)!.push(run)
    process.stderr.write('.')
  }
}
await Promise.all(Array.from({ length: PARALLEL }, worker))
process.stderr.write('\n')

const rows = cases.map(c => {
  const rs = runs.get(c.id)!
  const passes = rs.filter(r => accepts(c, r.outcome!.worker)).length
  const workers = [...new Set(rs.map(r => r.outcome!.worker))]
  return { c, rs, passes, flips: workers.length > 1 }
})
const scored = rows.filter(r => r.c.expect !== 'any')
const up = scored.filter(r => r.c.expect !== 'sonnet')
const stay = scored.filter(r => r.c.expect === 'sonnet')
const rate = (list: typeof rows) => list.reduce((n, r) => n + r.passes, 0) / Math.max(1, list.length * RUNS)
const usd = rows.reduce((n, r) => n + r.rs.reduce((m, x) => m + x.usd, 0), 0)

const md = [
  `# Escalation bench, layer A: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
  '',
  `Session ${SESSION}, coding model ${CODE_MODEL}, coding effort ${STANDING}, ${RUNS} survey runs per case, ${cases.length} cases. Survey cost $${usd.toFixed(2)}.`,
  '',
  `- **Goes up when it should:** ${(rate(up) * 100).toFixed(0)}% of runs (${up.length} cases)`,
  `- **Stays on ${SESSION} when it should:** ${(rate(stay) * 100).toFixed(0)}% of runs (${stay.length} cases)`,
  `- **Flips between runs:** ${rows.filter(r => r.flips).map(r => r.c.id).join(', ') || 'none'}`,
  '',
  '| case | expected | result | runs passed | survey readings | how |',
  '|---|---|---|---|---|---|',
  ...rows.map(({ c, rs, passes }) => {
    const ok = c.expect === 'any' ? '·' : passes === RUNS ? '✅' : passes === 0 ? '❌' : '⚠️'
    const expect = Array.isArray(c.expect) ? c.expect.join('/') : c.expect
    const got = [...new Set(rs.map(r => r.outcome!.gear))].join(', ')
    const readings = rs.map(r => shortReading(r.reading)).join(' / ')
    const how = [...new Set(rs.map(r => r.outcome!.how))].join(' / ')
    return `| ${ok} ${c.id} | ${expect} | ${got} | ${passes}/${RUNS} | ${readings} | ${how.replace(/\|/g, '/')} |`
  }),
].join('\n')

const dir = join(here, 'results')
mkdirSync(dir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
writeFileSync(join(dir, `layer-a-${stamp}.md`), md + '\n')
writeFileSync(join(dir, `layer-a-${stamp}.json`), JSON.stringify(rows.map(({ c, rs }) => ({ id: c.id, expect: c.expect, runs: rs })), null, 2))
console.log(md)
