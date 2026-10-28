// Layer B of the escalation bench: does the main model really hand the work up? Each case is a real headless
// session on SESSION, with gearbox and your usual setup loaded, in a fresh copy of fixture/. The verdict comes
// from gearbox's own log for that session: a deep hand-off followed by a subagent spawned on Opus passes; a deep
// hand-off with no such spawn is the main model doing the work itself. Cases with `fix` also run the hidden check.
//
//   bun bench/escalation/obey.ts [--only id,id] [--budget 15] [--per-run 2.5] [--session sonnet]
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

type Case = { id: string; prompt: string; expect: 'opus' | 'sonnet'; fix?: boolean; then?: string }
type Event = { t: number; ev: string; [k: string]: any }
type Verdict = { got: 'opus' | 'sonnet' | 'skipped'; handoff?: string; spawned: string[]; why?: string }

const flag = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}
const BUDGET = Number(flag('budget', '15'))
const PER_RUN = flag('per-run', '2.5')
const SESSION = flag('session', 'sonnet')
const only = flag('only', '')
const REPEAT = Number(flag('repeat', '1'))

const all: Case[] = [
  { id: 'trace-mismatch', expect: 'opus', prompt: 'Why do quotes differ between the gateway and the price service for the same package? Trace both flows and find the root cause. Do not change code.' },
  { id: 'fix-mismatch', expect: 'opus', fix: true, prompt: 'Quotes differ by a few cents between the gateway and the price service when there is a discount and insurance. Find the root cause, fix it so every service agrees with the price service, and add a test.' },
  { id: 'trace-then-fix', expect: 'opus', fix: true, then: 'go ahead and fix it', prompt: 'Why do quotes differ between the gateway and the price service for the same package? Trace both flows and find the root cause, then tell me how you would fix it.' },
  { id: 'admin-only', expect: 'opus', prompt: 'Only admins may change price tables: add role checks and enforce them in both the gateway and the price service, with tests.' },
  { id: 'currency-field', expect: 'sonnet', prompt: 'Add a currency field, always "BRL", to the response of handleQuote in services/gateway/routes.ts.' },
  { id: 'what-format', expect: 'sonnet', prompt: 'What does formatMoney in services/shared/money.ts return for 1234.5?' },
]
// Each case runs --repeat times, one after another: a single run says little about how often the main model obeys.
const cases = all.filter(c => !only || only.split(',').includes(c.id)).flatMap(c => Array.from({ length: REPEAT }, () => c))

const here = import.meta.dir
const logs = join(homedir(), '.claude/gearbox/logs')

const sh = async (cmd: string[], cwd: string, timeoutMs = 900_000) => {
  const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => p.kill(), timeoutMs)
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  const code = await p.exited
  clearTimeout(timer)
  return { out, err, code }
}

const fresh = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gearbox-fixture-'))
  cpSync(join(here, 'fixture'), dir, { recursive: true })
  await sh(['git', 'init', '-q'], dir)
  await sh(['git', 'add', '-A'], dir)
  await sh(['git', '-c', 'user.name=bench', '-c', 'user.email=bench@local', 'commit', '-qm', 'fixture'], dir)
  return dir
}

const claude = async (dir: string, prompt: string, resume?: string) => {
  // The prompt goes first: --allowedTools takes every word after it.
  const args = ['claude', '-p', prompt, ...(resume ? ['--resume', resume] : []), '--model', SESSION, '--output-format', 'json', '--max-budget-usd', PER_RUN, '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(bun test*)', 'Bash(git diff*)', 'Bash(git status*)']
  const r = await sh(args, dir)
  try {
    const j = JSON.parse(r.out)
    return { session: String(j.session_id), usd: Number(j.total_cost_usd ?? 0), result: String(j.result ?? ''), error: j.is_error ? String(j.subtype ?? 'error') : undefined }
  } catch {
    return { session: '', usd: 0, result: '', error: (r.err || r.out).slice(0, 300) }
  }
}

const events = (session: string, since: number): Event[] => {
  const f = join(logs, `${session}.jsonl`)
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Event).filter(e => e.t >= since)
}

const verdict = (evs: Event[]): Verdict => {
  const gear = evs.find(e => e.ev === 'gear')
  const spawned = evs.filter(e => e.ev === 'spawn').map(e => `${e.model}${e.deep ? ' (deep)' : ''}`)
  const resumed = evs.some(e => e.ev === 'resume')
  const handoff: string | undefined = gear?.handoff
  const up = spawned.some(s => s.includes('opus')) || resumed
  if (!gear) return { got: 'sonnet', spawned, why: 'no gear event: gearbox did not run' }
  if (handoff?.startsWith('deep')) return { got: up ? 'opus' : 'skipped', handoff, spawned: resumed ? [...spawned, 'resumed the same agent'] : spawned, why: gear.why }
  return { got: up ? 'opus' : 'sonnet', handoff, spawned, why: gear.why }
}

type Row = { c: Case; turns: { prompt: string; v: Verdict; usd: number; error?: string }[]; fixed?: boolean; dir: string }
const rows: Row[] = []
let spent = 0
for (const c of cases) {
  if (spent >= BUDGET) {
    console.error(`budget of $${BUDGET} reached, skipping ${c.id}`)
    continue
  }
  const dir = await fresh()
  const row: Row = { c, turns: [], dir }
  const started = Date.now()
  const first = await claude(dir, c.prompt)
  spent += first.usd
  row.turns.push({ prompt: c.prompt, v: verdict(events(first.session, started)), usd: first.usd, error: first.error })
  if (c.then && first.session && spent < BUDGET) {
    const at = Date.now()
    const second = await claude(dir, c.then, first.session)
    spent += second.usd
    row.turns.push({ prompt: c.then, v: verdict(events(second.session || first.session, at)), usd: second.usd, error: second.error })
  }
  if (c.fix) {
    const r = await Bun.spawn(['bun', join(here, 'check.ts')], { cwd: here, env: { ...process.env, FIXTURE: dir }, stdout: 'ignore', stderr: 'ignore' }).exited
    row.fixed = r === 0
  }
  rows.push(row)
  console.error(`${c.id}: ${row.turns.map(t => t.v.got).join(' → ')}${row.fixed === undefined ? '' : row.fixed ? ', fixed' : ', not fixed'} ($${row.turns.reduce((n, t) => n + t.usd, 0).toFixed(2)})`)
}

const mark = (r: Row) => {
  const first = r.turns[0]!.v.got
  const ok = first === r.c.expect && r.turns.every(t => t.v.got !== 'skipped' && !t.error) && r.fixed !== false
  return ok ? '✅' : '❌'
}
const md = [
  `# Escalation bench, layer B: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
  '',
  `Session ${SESSION}, headless \`claude -p\` with gearbox and the usual setup, capped at $${PER_RUN} per run. Spent $${spent.toFixed(2)}.`,
  '',
  '| case | expected | turn | gearbox decided | spawned | result | fix check | cost |',
  '|---|---|---|---|---|---|---|---|',
  ...rows.flatMap(r =>
    r.turns.map((t, i) =>
      `| ${i === 0 ? `${mark(r)} ${r.c.id}` : ''} | ${i === 0 ? r.c.expect : ''} | ${i === 0 ? 'prompt' : `"${t.prompt}"`} | ${t.v.handoff ?? 'no hand-off'} | ${t.v.spawned.join(', ') || 'none'} | ${t.v.got}${t.error ? ` (${t.error})` : ''} | ${i === r.turns.length - 1 && r.fixed !== undefined ? (r.fixed ? 'passes' : 'fails') : ''} | $${t.usd.toFixed(2)} |`,
    ),
  ),
  '',
  '`skipped`: gearbox decided on a deep hand-off, but the main model never started the agent and did the work itself.',
].join('\n')

const out = join(here, 'results')
mkdirSync(out, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
writeFileSync(join(out, `layer-b-${stamp}.md`), md + '\n')
writeFileSync(join(out, `layer-b-${stamp}.json`), JSON.stringify(rows, null, 2))
console.log(md)
