// The lanes bench: before gearbox keeps one long-lived subagent per model, does a resumed agent take a new effort
// per message, and keep its prompt cache when it does? Each run is a headless session on SESSION with gearbox off
// and the lane probe (probe/) loaded, in a fresh copy of the escalation fixture. The main model starts an agent at
// an effort, then sends it two hard jobs, to work out without tools, with SendMessage, each as is or tagged for an
// effort the probe sends every request of that resumed turn at. Arms:
//   low, medium, xhigh  started there, resumed as is: the references, effort as Claude Code sets it
//   up                  started at low, resumed tagged xhigh, then xhigh
//   down                started at xhigh, resumed tagged low, then medium
// The probe's log says what each request sent and its cache; the agent's transcript, what the engine recorded
// sending and how much the model thought. A tagged turn thinking like the reference at its effort confirms the
// API ran at the effort a mod set.
//
//   bun bench/lanes/run.ts [--arms low,medium,xhigh,down] [--repeat 3] [--budget 5] [--per-run 1] [--session sonnet]
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

type Event = { t: number; ev: string; [k: string]: any }
type Spec = { spawn: string; tags: [string | null, string | null] }

const ARM_SPECS: Record<string, Spec> = {
  low: { spawn: 'low', tags: [null, null] },
  medium: { spawn: 'medium', tags: [null, null] },
  xhigh: { spawn: 'xhigh', tags: [null, null] },
  up: { spawn: 'low', tags: ['xhigh', 'xhigh'] },
  down: { spawn: 'xhigh', tags: ['low', 'medium'] },
}

const flag = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}
const ARMS = flag('arms', 'low,medium,xhigh,down').split(',').filter(a => ARM_SPECS[a])
const REPEAT = Number(flag('repeat', '3'))
const BUDGET = Number(flag('budget', '5'))
const PER_RUN = flag('per-run', '1')
const SESSION = flag('session', 'sonnet')

const here = import.meta.dir
const fixture = join(here, '../escalation/fixture')
const projects = join(homedir(), '.claude/projects')

// Counts that take care to get right by hand: more effort, more thinking.
const JOBS = [
  { text: 'Without using any tools, work out how many integers from 0 to 9999 have digits that add up to 23. Reply with just the number.', answer: '480' },
  { text: 'Without using any tools, work out how many integers from 0 to 9999 have digits that add up to 20. Reply with just the number.', answer: '633' },
]

const msg = (tag: string | null, job: string) => `${tag ? `[lane-effort:${tag}] ` : ''}${job}`
const prompt = (s: Spec) =>
  [
    'This is a test harness. Follow these steps exactly and do nothing else.',
    `1. Call the Agent tool with name "lane", model "sonnet", effort "${s.spawn}", run_in_background false, description "lane probe", and this prompt: "Read services/price/price.ts and say in one sentence what priceQuote returns."`,
    `2. When it returns, call SendMessage with to set to the agent's id from the Agent result (or "lane" if there is none) and this message: "${msg(s.tags[0], JOBS[0]!.text)}"`,
    '3. Wait for its reply.',
    `4. Then call SendMessage to the same agent with this message: "${msg(s.tags[1], JOBS[1]!.text)}"`,
    '5. Wait for its reply, then answer with its two numbers, comma-separated, and nothing else.',
  ].join('\n')

const sh = async (cmd: string[], cwd: string, env: Record<string, string>, timeoutMs = 900_000) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => p.kill(), timeoutMs)
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  await p.exited
  clearTimeout(timer)
  return { out, err }
}

const once = async (arm: string) => {
  const spec = ARM_SPECS[arm]!
  const dir = mkdtempSync(join(tmpdir(), 'gearbox-lanes-'))
  cpSync(fixture, dir, { recursive: true })
  const logFile = join(dir, '.lane-probe.jsonl')
  // The prompt goes first: options after it are read as options.
  const r = await sh(
    ['claude', '-p', prompt(spec), '--model', SESSION, '--output-format', 'json', '--max-budget-usd', PER_RUN,
      '--plugin-dir', join(here, 'probe'), '--settings', JSON.stringify({ enabledPlugins: { 'gearbox@gearbox': false } })],
    dir,
    { LANE_PROBE_LOG: logFile },
  )
  let usd = 0
  let session = ''
  let result = ''
  let error: string | undefined
  try {
    const j = JSON.parse(r.out)
    usd = Number(j.total_cost_usd ?? 0)
    session = String(j.session_id ?? '')
    result = String(j.result ?? '')
    if (j.is_error) error = String(j.subtype ?? 'error')
  } catch {
    error = (r.err || r.out).slice(0, 300)
  }
  const evs: Event[] = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  const agent: string | undefined = evs.find(e => e.ev === 'spawn' && !e.resume)?.agent
  const sends = evs.filter(e => e.ev === 'send').map(e => e.t as number)
  const answers = result.split(/[^\d]+/).filter(Boolean)
  // One entry per resumed turn: from its SendMessage to the next one.
  const turns = [0, 1].map(i => {
    const from = sends[i]
    const to = sends[i + 1] ?? Infinity
    const want = spec.tags[i] ?? spec.spawn
    if (from === undefined || !agent) return { want, missing: true as const }
    const steps = evs.filter(e => e.ev === 'step' && e.agent === agent && e.t >= from && e.t < to)
    const head = steps[0]?.usage as { write: number; read: number } | undefined
    const sent = [...new Set(steps.map(e => String(e.sent)))]
    const rec = transcript(session, agent, from, to)
    return {
      want,
      steps: steps.length,
      engine: [...new Set(steps.map(e => String(e.engine)))],
      sent,
      recorded: rec?.efforts ?? [],
      thinking: rec?.thinking ?? 0,
      output: rec?.output ?? 0,
      head: head ?? null,
      right: answers[i] === JOBS[i]!.answer,
      ok: steps.length > 0 && sent.length === 1 && sent[0] === want && (head ? head.write <= Math.max(2000, 0.2 * (head.write + head.read)) : false),
    }
  })
  const strays = [...new Set(evs.filter(e => e.ev === 'step' && e.agent !== 'main' && e.agent !== agent).map(e => e.agent))]
  return { arm, spawn: spec.spawn, dir, session, usd, result, error, agent, strays, turns, events: evs }
}

// What the engine wrote down for the agent's requests between two times: the effort it recorded sending, and the
// thinking and output tokens the API reported, once per response (a response's blocks share one usage).
const transcript = (session: string, agent: string, from: number, to: number) => {
  const dir = session ? readdirSync(projects).find(d => existsSync(join(projects, d, session, 'subagents', `agent-${agent}.jsonl`))) : undefined
  if (!dir) return undefined
  const seen = new Set<string>()
  const efforts = new Set<string>()
  let thinking = 0
  let output = 0
  for (const line of readFileSync(join(projects, dir, session, 'subagents', `agent-${agent}.jsonl`), 'utf8').split('\n')) {
    if (!line) continue
    const r = JSON.parse(line)
    const t = Date.parse(r.timestamp)
    if (r.type !== 'assistant' || t < from || t >= to || seen.has(r.message?.id)) continue
    seen.add(r.message?.id)
    efforts.add(String(r.effort))
    thinking += r.message?.usage?.output_tokens_details?.thinking_tokens ?? 0
    output += r.message?.usage?.output_tokens ?? 0
  }
  return { efforts: [...efforts], thinking, output }
}

type Run = Awaited<ReturnType<typeof once>>
const runs: Run[] = []
let spent = 0
for (let i = 0; i < REPEAT; i++) {
  // Rotate which arm goes first, so none always finds a warm cache.
  for (const arm of [...ARMS.slice(i % ARMS.length), ...ARMS.slice(0, i % ARMS.length)]) {
    if (spent >= BUDGET) {
      console.error(`budget of $${BUDGET} reached, skipping ${arm}`)
      continue
    }
    const r = await once(arm)
    spent += r.usd
    runs.push(r)
    const t = r.turns.map(x => ('missing' in x ? `${x.want}: missing` : `${x.want}: sent ${x.sent.join('/')}, recorded ${x.recorded.join('/')}, thinking ${x.thinking}${x.right ? ' ✓' : ' ✗'}`))
    console.error(`${arm}: ${t.join(' | ')} ($${r.usd.toFixed(2)})${r.error ? ` error: ${r.error}` : ''}`)
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN
}
const rows = runs.flatMap(r => r.turns.map((t, i) => ({ r, t, i })))
// Thinking by the effort a turn ran at, and how it got there: the start effort as is, or a tag.
const groups = new Map<string, number[]>()
for (const { r, t, i } of rows) {
  if ('missing' in t) continue
  const key = `${t.want} · job ${i + 1} · ${ARM_SPECS[r.arm]!.tags[i] ? `tagged, started at ${r.spawn}` : 'started there'}`
  groups.set(key, [...(groups.get(key) ?? []), t.thinking])
}
const md = [
  `# Lanes bench: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
  '',
  `Session ${SESSION}, gearbox off, lane probe on. Arms: ${ARMS.map(a => `${a} (start ${ARM_SPECS[a]!.spawn}, then ${ARM_SPECS[a]!.tags.map(x => x ?? 'as is').join(', ')})`).join('; ')}. Spent $${spent.toFixed(2)}.`,
  '',
  '| effort · job · how | turns | median thinking | each |',
  '|---|---|---|---|',
  ...[...groups.entries()].sort().map(([k, xs]) => `| ${k} | ${xs.length} | ${median(xs)} | ${xs.join(', ')} |`),
  '',
  '| | arm | job | wanted | engine would send | sent | engine recorded | thinking / output | right | 1st write / read | cost |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map(({ r, t, i }) =>
    'missing' in t
      ? `| ❌ | ${r.arm} | ${i + 1} | ${t.want} | - | - | - | - | - | - | ${r.error ?? 'turn missing'} |`
      : `| ${t.ok && !r.strays.length && !r.error ? '✅' : '❌'} | ${r.arm} | ${i + 1} | ${t.want} | ${t.engine.join(', ')} | ${t.sent.join(', ')} | ${t.recorded.join(', ')} | ${t.thinking} / ${t.output} | ${t.right ? '✓' : '✗'} | ${t.head ? `${t.head.write} / ${t.head.read}` : '-'} | ${i === 0 ? `$${r.usd.toFixed(2)}` : ''} |`,
  ),
  '',
  '- **engine would send**: the effort on the resumed requests before the probe touched them; **sent**: after; **engine recorded**: the effort the agent\'s transcript holds for them.',
  '- **thinking / output**: tokens of the resumed turn as the API reported them. A tagged turn thinking like the reference started at that effort is the API running at the effort a mod set.',
  '- **1st write / read**: cache tokens of the turn\'s first request. A kept cache writes little (the new message); a lost one rewrites the agent\'s whole context.',
  '- ✅ when the turn\'s requests all went at the wanted effort, the cache was kept, no other agent ran, and nothing failed.',
].join('\n')

const out = join(here, 'results')
mkdirSync(out, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
writeFileSync(join(out, `lanes-${stamp}.md`), md + '\n')
writeFileSync(join(out, `lanes-${stamp}.json`), JSON.stringify(runs, null, 2))
console.log(md)
