import type { ElementTable, RenderElement } from 'claude-code'
import type { GearboxLoop } from '../types'
import { type Node, bars, clock, family, fit, gearText, hue, kilo, live, money, nowOf, ran, shortPath, swapped, tagsOf, treeOf } from './loops'

// How the readouts draw the agents running: the band above the prompt (a tree of text in the terminal, a card each in
// the desktop app) and the panel. Both read the same loops; only the drawing differs.

type Els = Pick<ElementTable, 'Box' | 'Text'>

// The colours of the states: ● and ✓ green, ◐ and ⚠ amber, ✗ red, ◌ dim.
const FINISHED = '#4FBF6A'
const WAITING = '#E9A23B'
const FAILED = '#E5646E'

// At most this many live agents are drawn; the rest are counted ("+N agents · Panel").
const MAX_LIVE = 4
// The terminal band's lines for what hangs under main: with its header, rule and main's two lines, about twelve.
const BAND_ROOM = 8
// How many cards beyond the live ones (finished, queued) the desktop draws.
const EXTRA_CARDS = 4
// A terminal narrower than this draws the narrow band.
export const NARROW = 100

// A fan-out part whose agent has not started: drawn as a loop of its own, under main (id `queued:<n>`).
export type Queued = { label: string; model: string; effort: string }
const QUEUED = 'queued:'
const isQueued = (id: string) => id.startsWith(QUEUED)
const withQueued = (loops: Record<string, GearboxLoop>, queued: readonly Queued[]): Record<string, GearboxLoop> => ({
  ...loops,
  ...Object.fromEntries(queued.map((q, i) => [`${QUEUED}${i}`, { label: q.label, parent: 'main', asked: q.model, effort: q.effort, state: 'idle', steps: 0 } satisfies GearboxLoop])),
})

// A finished agent the turn's prompt has not passed yet.
const recent = (l: GearboxLoop, since?: number) => l.state === 'done' && l.endedAt !== undefined && (since === undefined || l.endedAt >= since)

type Chosen = { nodes: Node[]; hidden: number }

// The agents to draw: up to MAX_LIVE live ones, then, while `room` lasts (each costing `cost`), the finished ones of this
// turn and the queued parts, nested as they began. `hidden` counts those left out.
const choose = (all: Record<string, GearboxLoop>, o: { since?: number; room: number; cost: (n: Node) => number }): Chosen => {
  const order = treeOf(all, (id, l) => id !== 'main' && (isQueued(id) || live(l) || recent(l, o.since)))
  const shown = new Set(order.filter(n => live(n.loop)).slice(0, MAX_LIVE).map(n => n.id))
  let room = o.room - order.filter(n => shown.has(n.id)).reduce((sum, n) => sum + o.cost(n), 0)
  for (const n of order)
    if (!shown.has(n.id) && !live(n.loop) && o.cost(n) <= room) {
      shown.add(n.id)
      room -= o.cost(n)
    }
  return { nodes: treeOf(all, id => shown.has(id)), hidden: order.length - shown.size }
}

// The band at 100 columns and up, and under 100.
type Shape = 'wide' | 'narrow'

// ---- one agent as a row of data, which each surface draws its own way ----

type NoteLine = { head: string; tool?: string; fallback?: string; dim?: boolean; color?: string }
type Row = {
  node: Node
  glyph: string
  color?: string
  label: string
  dim: boolean
  gear: string
  tint?: string
  src?: string // who set the effort
  extra?: string // the worktree; how a finished one ended; "queued"
  stats: string // "4 req  38s"
  note?: NoteLine
  two: boolean // a second line for the note
  skills: string[] // the skills it loaded, in load order (an agent's; main's are not shown)
}

const SRC = { main: 'main', rules: 'rules', auto: 'auto' } as const
const SOURCE = { main: 'chosen by main', rules: 'by rules', auto: 'auto' } as const
// "part 1: customers" reads "part 1 · customers".
const labelOf = (l: GearboxLoop) => l.label.replace(/^(part \d+):\s*/i, '$1 · ')

// How a finished one ended: well ("done"), or not; and the first line of what it handed back. `bare`: just that line
// where it ended well.
const ending = (l: GearboxLoop, bare: boolean) => (bare && !l.failed && l.result ? l.result : [l.failed ?? 'done', l.result].filter(Boolean).join(' · '))

// Its requests and how long it ran (still running: to now).
const statsOf = (l: GearboxLoop, now: number, running: boolean) =>
  [`${l.steps} req`, l.since !== undefined && (running || l.endedAt !== undefined) ? ran((running ? now : l.endedAt!) - l.since) : ''].filter(Boolean).join('  ')

const glyphOf = (id: string, l: GearboxLoop): [string, string | undefined] =>
  isQueued(id) ? ['◌', undefined] : l.state === 'done' ? (l.failed ? ['✗', FAILED] : ['✓', FINISHED]) : l.state === 'waiting' ? ['◐', WAITING] : swapped(l) ? ['⚠', WAITING] : ['●', FINISHED]

const rowOf = (n: Node, now: number, shape: Shape): Row => {
  const l = n.loop
  const [glyph, color] = glyphOf(n.id, l)
  // The narrow band names a running agent by its first word or two ("part 1", "Explore"); a finished one in full.
  const label = shape === 'narrow' && l.state !== 'done' ? labelOf(l).split(' · ')[0]! : labelOf(l)
  const common = { node: n, glyph, ...(color ? { color } : {}), label, gear: gearText(l), skills: l.skills ?? [], ...(isQueued(n.id) ? {} : { tint: hue(l) }) }
  if (isQueued(n.id)) return { ...common, dim: true, extra: 'queued', stats: '', two: false }
  if (l.state === 'done') return { ...common, dim: true, ...(l.effortBy ? { src: SRC[l.effortBy] } : {}), extra: ending(l, shape === 'narrow'), stats: statsOf(l, now, false), two: false }
  const said = nowOf(l)
  const fallback = swapped(l) ? `answered by ${family(l.answered!) ?? l.answered}` : undefined
  const note: NoteLine =
    l.state === 'waiting'
      ? { head: 'waiting on its own background work', dim: true }
      : { head: said.text, ...(said.tool ? { tool: said.tool } : {}), ...(fallback ? { fallback } : {}), ...(said.said ? {} : { dim: true }) }
  return {
    ...common,
    dim: false,
    ...(l.effortBy ? { src: SRC[l.effortBy] } : {}),
    ...(l.worktree ? { extra: `⎇ ${l.worktree}` } : {}),
    stats: statsOf(l, now, true),
    note,
    // A narrow band keeps an agent a subagent started to one line.
    two: shape !== 'narrow' || n.depth < 2,
  }
}

// The main conversation's row: in a turn, its note; between turns, that it waits on its agents or for a prompt.
const mainRowOf = (main: GearboxLoop, agents: number, now: number): Row => {
  const said = nowOf(main)
  const working = main.state === 'working'
  const waits = !working && agents > 0
  const note: NoteLine = working
    ? { head: said.text, ...(said.tool ? { tool: said.tool } : {}), ...(said.said ? {} : { dim: true }) }
    : waits
      ? { head: 'agents at work · main waits · not done yet', color: WAITING }
      : { head: 'waiting for a prompt', dim: true }
  return {
    node: { id: 'main', loop: main, depth: 0, last: true, trail: [] },
    glyph: waits ? '◐' : '●',
    ...(working ? { color: FINISHED } : waits ? { color: WAITING } : {}),
    label: 'main',
    dim: false,
    gear: gearText(main),
    tint: hue(main),
    stats: working ? statsOf(main, now, true) : '',
    note,
    two: true,
    skills: [],
  }
}

// ---- the text tree: terminal band, panel ----

const guideOf = (n: Node) => (n.depth === 0 ? '' : `${n.trail.map(c => (c ? '│ ' : '  ')).join('')}${n.last ? '└─' : '├─'}`)
// What stands left of the lines under an identity line: the guides that run on, then the label's indent.
const contOf = (n: Node) => (n.depth === 0 ? '  ' : `${n.trail.map(c => (c ? '│ ' : '  ')).join('')}${n.last ? '  ' : '│ '}  `)
// A note's tail: the tool it was followed by, dimmed, and a fallback's flag. The narrow band drops both.
const tailOf = (n: NoteLine, shape: Shape) => (shape === 'narrow' ? '' : [n.tool, n.fallback].filter(Boolean).map(s => ` · ${s}`).join(''))

const GEAR_W = 14
const SRC_W = 6
const labelWidth = (rows: Row[], max: number) => Math.min(max, Math.max(14, ...rows.map(r => guideOf(r.node).length + 2 + r.label.length + 2)))

// A note's head and tail on a line `room` characters wide: the head cut at a word (fit) so the tail stays after it where
// the two do not fit, and the head alone, cut, where even a short stretch of it would not.
const MIN_HEAD = 24
const noteFit = (head: string, tail: string, room: number): [string, string] =>
  head.length + tail.length <= room ? [head, tail] : room - tail.length >= MIN_HEAD ? [fit(head, room - tail.length), tail] : [fit(head, room), '']

// An agent's skills as tags, in the lines under its identity: the names to draw on each line, as many lines as they need.
// They stand where the note does (`cont`), so the room is what the note has.
const tagsFor = (n: Node, skills: readonly string[], columns: number) => tagsOf(skills, Math.max(0, columns - contOf(n).length))

// The identity line, the skills (tags, as many lines as they need) and the note line of each row, in a terminal `columns` wide.
// `wide`: gear, who chose the effort, worktree, requests and time; `narrow`: gear and time, a finished agent in one line.
const treeRows = ({ Box, Text }: Els, rows: Row[], shape: Shape, columns: number) => {
  const labelW = labelWidth(rows, shape === 'narrow' ? 26 : 32)
  return rows.map(r => {
    const folded = shape === 'narrow' && r.node.loop.state === 'done'
    const mark = (
      <Text wrap="truncate" dimColor={r.dim}>
        <Text dimColor>{guideOf(r.node)}</Text>
        <Text {...(r.color ? { color: r.color } : { dimColor: true })}>{r.glyph}</Text>
        {` ${r.label}${folded && r.extra ? ` · ${r.extra}` : ''}`}
      </Text>
    )
    const identity = folded ? (
      <Box flexDirection="row">{mark}</Box>
    ) : (
      <Box flexDirection="row" columnGap={shape === 'wide' ? 2 : 1}>
        <Box width={labelW} flexShrink={0}>
          {mark}
        </Box>
        <Box width={GEAR_W} flexShrink={0}>
          <Text weight="semibold" wrap="truncate" {...(r.tint && !r.dim ? { color: r.tint } : { dimColor: true })}>
            {r.gear}
          </Text>
        </Box>
        {shape === 'wide' ? (
          <Box width={SRC_W} flexShrink={0}>
            <Text dimColor wrap="truncate">
              {r.src ?? ''}
            </Text>
          </Box>
        ) : null}
        <Box flexGrow={1} flexShrink={1}>
          {shape !== 'narrow' && r.extra ? (
            <Text dimColor wrap="truncate">
              {r.extra}
            </Text>
          ) : null}
        </Box>
        <Text dimColor tabular>
          {shape === 'narrow' ? (isQueued(r.node.id) ? 'queued' : (r.stats.split('  ')[1] ?? '')) : r.stats}
        </Text>
      </Box>
    )
    const cont = contOf(r.node)
    const [head, tail] = r.note ? noteFit(r.note.head, tailOf(r.note, shape), Math.max(0, columns - cont.length)) : ['', '']
    const tags = tagsFor(r.node, r.skills, columns)
    return (
      <Box key={`agent-${r.node.id}`} flexDirection="column">
        {identity}
        {tags.map((names, i) => (
          <Box key={`skills-${r.node.id}-${i}`} flexDirection="row">
            <Box width={cont.length} flexShrink={0}>
              <Text dimColor>{cont}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate">
                {names.flatMap((name, j) => [...(j ? [' '] : []), <Text key={`skill-${name}`} inverse dimColor>{` ✦ ${name} `}</Text>])}
              </Text>
            </Box>
          </Box>
        ))}
        {r.two && r.note ? (
          <Box flexDirection="row">
            <Box width={cont.length} flexShrink={0}>
              <Text dimColor>{cont}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate" {...(r.note.dim ? { dimColor: true } : r.note.color ? { color: r.note.color } : {})}>
                {head}
                {tail ? <Text dimColor>{tail}</Text> : null}
              </Text>
            </Box>
          </Box>
        ) : null}
      </Box>
    )
  })
}

const more = ({ Text }: Pick<ElementTable, 'Text'>, n: number) => (n > 0 ? <Text dimColor>{`+${n} agent${n === 1 ? '' : 's'} · Panel`}</Text> : null)

// ---- the band above the prompt ----

// What the band is told, drawn alike by both surfaces.
export type Summary = {
  loops: Record<string, GearboxLoop>
  queued: readonly Queued[]
  since?: number // when this turn began
  now: number
  subs: [string, GearboxLoop][] // the live subagents
  requests: [string, number][] // this turn's, per model
  usd?: number
  thisTurn?: number
  avg?: number
  turnCosts: number[]
  compare: boolean // two turns or more: bars and an average
  why?: [string, string]
  handoff: boolean // the main conversation hands its work off this turn
  counted: string // "2 running · 1 waiting"
  gears: string // "sonnet·low ×2 · haiku·low"
}

const total = (rs: [string, number][]) => rs.reduce((n, [, c]) => n + c, 0)

// The terminal's band: one header line, a rule, then main and the tree of its agents, two lines each.
export const terminalBand = ({ Box, Text }: Els, s: Summary, o: { columns: number; actions: RenderElement }) => {
  const narrow = o.columns < NARROW
  const shape: Shape = narrow ? 'narrow' : 'wide'
  const main = s.loops.main
  const chosen = choose(withQueued(s.loops, s.queued), { ...(s.since !== undefined ? { since: s.since } : {}), room: BAND_ROOM, cost: n => (live(n.loop) ? (narrow && n.depth >= 2 ? 1 : 2) : 1) + tagsFor(n, n.loop.skills ?? [], o.columns).length })
  const rows = [...(main ? [mainRowOf(main, s.subs.length, s.now)] : []), ...chosen.nodes.map(n => rowOf(n, s.now, shape))]
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={narrow ? 1 : 2} alignItems="center">
        <Text weight="bold">GearBox</Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate">
            {main ? <Text color={hue(main)}>{gearText(main)}</Text> : null}
            {main?.effortBy === 'auto' ? <Text dimColor>{' (auto)'}</Text> : null}
            <Text dimColor>{main ? ' · ' : ''}</Text>
            <Text>{s.subs.length ? `${s.subs.length} agent${s.subs.length === 1 ? '' : 's'}` : 'no agents'}</Text>
            {narrow ? null : <Text dimColor>{' · this turn '}</Text>}
            {narrow ? null : <Text>{`${total(s.requests)} req`}</Text>}
            {s.usd !== undefined ? <Text dimColor>{' · '}</Text> : null}
            {s.usd !== undefined ? <Text>{money(s.usd)}</Text> : null}
            {s.compare && !narrow ? <Text dimColor>{` ${bars(s.turnCosts)}`}</Text> : null}
            {narrow || !s.why ? null : <Text dimColor>{' · why '}</Text>}
            {narrow || !s.why ? null : <Text color={WAITING}>{s.why[0]}</Text>}
          </Text>
        </Box>
        {o.actions}
      </Box>
      <Text dimColor wrap="truncate">
        {'─'.repeat(Math.max(1, o.columns))}
      </Text>
      {rows.length ? treeRows({ Box, Text }, rows, shape, o.columns) : <Text dimColor>waiting for a prompt</Text>}
      {more({ Text }, chosen.hidden)}
    </Box>
  )
}

// ---- the desktop's band: metrics, then a card per agent ----

// A chip: the desktop has no pill, so it is a small rounded box around a caption.
const pill = ({ Box, Text }: Els, text: string, color?: string, key?: string) => (
  <Box key={key} borderStyle="round" paddingX="xs" {...(color ? { borderColor: color } : { borderDimColor: true })}>
    <Text size="caption" {...(color ? { color } : { dimColor: true })}>
      {text}
    </Text>
  </Box>
)

type Tree = { node: Node; kids: Tree[] }
// The nodes in order, as a tree.
const nest = (nodes: Node[]): Tree[] => {
  const from = (i: number, depth: number): [Tree[], number] => {
    const out: Tree[] = []
    while (i < nodes.length && nodes[i]!.depth >= depth) {
      const node = nodes[i]!
      const [kids, next] = from(i + 1, depth + 1)
      out.push({ node, kids })
      i = next
    }
    return [out, i]
  }
  return from(0, 1)[0]
}

// One agent's card: a rail in its model's colour, its identity as a row of chips, a row of chips for the skills it
// loaded, its note with a tool chip, the note before it, and inside it the cards of the agents it started.
const card = (t: Els, r: Row, kids: RenderElement[], o: { role?: string; before?: string }): RenderElement => {
  const { Box, Text } = t
  const l = r.node.loop
  const note = r.note
  return (
    <Box key={`card-${r.node.id}`} flexDirection="row" borderStyle="round" borderDimColor columnGap="sm" paddingX="sm">
      <Box width={1} flexShrink={0} backgroundColor={r.tint ?? '#777777'} />
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        <Box flexDirection="row" columnGap="sm" alignItems="center" flexWrap="wrap">
          <Text {...(r.color ? { color: r.color } : { dimColor: true })}>{r.glyph}</Text>
          <Text weight="semibold" dimColor={r.dim}>
            {r.label}
          </Text>
          {o.role ? (
            <Text dimColor size="caption">
              {o.role}
            </Text>
          ) : null}
          {pill(t, r.gear, r.tint)}
          {l.effortBy ? pill(t, SOURCE[l.effortBy]) : null}
          {l.worktree ? pill(t, `⎇ ${l.worktree}`) : null}
          <Box flexGrow={1} />
          <Text dimColor tabular size="caption">
            {r.stats.replace('  ', ' · ')}
          </Text>
        </Box>
        {r.skills.length ? (
          <Box flexDirection="row" columnGap="sm" alignItems="center" flexWrap="wrap">
            {r.skills.map(name => pill(t, `✦ ${name}`, undefined, `skill-${name}`))}
          </Box>
        ) : null}
        {note ? (
          <Box flexDirection="row" columnGap="sm" alignItems="center">
            <Box flexShrink={1}>
              <Text wrap="truncate" {...(note.dim ? { dimColor: true } : note.color ? { color: note.color } : {})}>
                {note.head}
              </Text>
            </Box>
            {note.tool ? pill(t, note.tool) : null}
            {note.fallback ? (
              <Text size="caption" color={WAITING}>
                {`⚠ ${note.fallback}`}
              </Text>
            ) : null}
          </Box>
        ) : null}
        {r.dim && r.extra ? (
          <Text dimColor size="caption">
            {r.extra.replace(' · ', ' — ')}
          </Text>
        ) : null}
        {o.before ? (
          <Text dimColor size="caption">
            {`before: ${o.before}`}
          </Text>
        ) : null}
        {kids.length ? (
          <Box flexDirection="column" paddingLeft="sm">
            {kids}
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}

// The desktop's band: GearBox and its actions, a row of metrics (now, agents, this turn, cost, why), then main's card
// and under it a card for each agent, an agent's own agents inside its card.
export const desktopBand = (t: Els, s: Summary, o: { columns: number; actions: RenderElement }) => {
  const { Box, Text } = t
  const main = s.loops.main
  const all = withQueued(s.loops, s.queued)
  const chosen = choose(all, { ...(s.since !== undefined ? { since: s.since } : {}), room: EXTRA_CARDS, cost: n => (live(n.loop) ? 0 : 1) })
  const rows = new Map(chosen.nodes.map(n => [n.id, rowOf(n, s.now, 'wide')]))
  const cards = (trees: Tree[], parent: string): RenderElement[] =>
    trees.map(({ node, kids }) => {
      const l = node.loop
      const owner = parent === 'main' ? undefined : all[parent]
      const before = l.state === 'done' ? undefined : l.notes?.at(-2)?.text
      return card(t, rows.get(node.id)!, cards(kids, node.id), { ...(owner ? { role: `started by ${labelOf(owner).split(' · ')[0]}` } : {}), ...(before ? { before } : {}) })
    })
  const done = Object.values(s.loops).filter(l => recent(l, s.since)).length
  const works = main?.state === 'working'
  const metric = (k: string, v: string, sub: string, color?: string, extra?: string) => (
    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
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
    </Box>
  )
  const n = total(s.requests)
  const columns = [
    metric('now', main ? gearText(main) : 'idle', main?.effortBy === 'auto' ? `auto${s.handoff ? ' · hand-off' : ''}` : works ? 'working' : s.subs.length ? 'main waits on its agents' : 'idle', main ? hue(main) : undefined),
    metric('agents', s.subs.length ? s.counted : 'none', [s.subs.length ? s.gears : '', done ? `${done} done` : ''].filter(Boolean).join(' · ') || 'no hand-off running'),
    metric('this turn', `${n} request${n === 1 ? '' : 's'}`, s.requests.map(([m, c]) => `${m} ${c}`).join(' · ') || 'none sent yet'),
    metric('cost', s.usd !== undefined ? money(s.usd) : 'not known', [s.thisTurn !== undefined ? `this turn ${money(s.thisTurn)}` : '', s.compare && s.avg !== undefined ? `avg ${money(s.avg)}` : ''].filter(Boolean).join(' · '), undefined, s.compare ? bars(s.turnCosts) : undefined),
    metric('why', s.why?.[0] ?? 'waiting for a prompt', s.why?.[1] ?? '', WAITING),
  ]
  // A narrow window keeps now, agents and cost.
  const shown = o.columns < 60 ? [columns[0]!, columns[1]!, columns[3]!] : columns
  const trees = nest(chosen.nodes)
  return (
    <Box flexDirection="column" rowGap="sm">
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Text weight="bold">GearBox</Text>
        <Box flexGrow={1} />
        {o.actions}
      </Box>
      <Box flexDirection="row" columnGap={2}>
        {shown}
      </Box>
      {main ? card(t, mainRowOf(main, s.subs.length, s.now), [], { role: 'main session', ...(works && main.notes?.at(-2) ? { before: main.notes.at(-2)!.text } : {}) }) : null}
      {trees.length ? (
        <Box flexDirection="column" paddingLeft="sm">
          {cards(trees, 'main')}
        </Box>
      ) : null}
      {more({ Text }, chosen.hidden)}
    </Box>
  )
}

// ---- the panel: a block per agent ----

// Every loop of the session, finished ones included, nested under the loop that started it: its identity, what it has
// cost, its last notes (the latest first, the earlier dimmed), the files it touched and its worktree.
export const panelBody = ({ Box, Text }: Els, loops: Record<string, GearboxLoop>, queued: readonly Queued[], o: { now: number; cwd?: string; handoff: boolean; mono: boolean; columns?: number }) => {
  const m = o.mono ? { mono: true as const } : {}
  const all = withQueued(loops, queued)
  const main = loops.main
  const agents = treeOf(all, id => id !== 'main')
  const running = agents.filter(n => live(n.loop)).length
  const nodes: Node[] = [...(main ? [{ id: 'main', loop: main, depth: 0, last: true, trail: [] } satisfies Node] : []), ...agents]
  const rows = nodes.map(n => (n.id === 'main' ? mainRowOf(main!, running, o.now) : rowOf(n, o.now, 'wide')))
  const labelW = labelWidth(rows, 34)
  const blocks = nodes.map((n, k) => {
    const l = n.loop
    const r = rows[k]!
    const cont = contOf(n)
    const line = (key: string, child: RenderElement) => (
      <Box key={`${n.id}-${key}`} flexDirection="row">
        <Box width={cont.length} flexShrink={0}>
          <Text dimColor {...m}>
            {cont}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          {child}
        </Box>
      </Box>
    )
    const u = l.usage
    const time = l.since !== undefined && (l.state === 'done' ? l.endedAt !== undefined : n.id !== 'main' || l.state === 'working') ? ran((l.state === 'done' ? l.endedAt! : o.now) - l.since) : ''
    const spend = [`${l.steps} req`, time, u ? `${kilo(u.in)} in / ${kilo(u.out)} out` : '', u ? money(u.usd) : ''].filter(Boolean)
    const source = n.id === 'main' ? (l.effortBy === 'auto' ? `(auto${o.handoff ? ': hand-off' : ''})` : '') : l.effortBy ? SOURCE[l.effortBy] : ''
    const where = l.state === 'done' ? '' : [l.worktree ? `⎇ ${l.worktree}` : '', l.worktreePath ?? '', swapped(l) ? `⚠ answered by ${family(l.answered!) ?? l.answered}` : ''].filter(Boolean).join('  ')
    // Main's cost sits on its line; an agent's under its name. A finished agent's closes its line.
    const own = n.id === 'main' || l.state === 'done'
    const identity = (
      <Box key={`${n.id}-id`} flexDirection="row" columnGap={2}>
        <Box width={labelW} flexShrink={0}>
          <Text wrap="truncate" dimColor={r.dim} {...m}>
            <Text dimColor>{guideOf(n)}</Text>
            <Text {...(r.color ? { color: r.color } : { dimColor: true })}>{r.glyph}</Text>
            {` ${r.label}`}
          </Text>
        </Box>
        <Text weight="semibold" {...(r.tint && !r.dim ? { color: r.tint } : { dimColor: true })} {...m}>
          {r.gear}
        </Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="truncate" {...m}>
            {[source, isQueued(n.id) ? 'queued' : where].filter(Boolean).join('  ')}
          </Text>
        </Box>
        {own && !isQueued(n.id) ? (
          <Text dimColor tabular {...m}>
            {(n.id === 'main' ? spend.filter(x => !x.includes(' in / ')) : spend).join(' · ')}
          </Text>
        ) : null}
      </Box>
    )
    if (isQueued(n.id)) return [identity]
    // Every skill it loaded, as the band shows them; the line wraps where the pane is narrow.
    const skills = l.skills?.length
      ? [
          line(
            'skills',
            <Text {...m}>
              <Text dimColor>{'skills: '}</Text>
              {l.skills.map((name, i) => (
                <Text key={`${n.id}-s${i}`}>
                  {i ? <Text dimColor>{' · '}</Text> : null}
                  {name}
                </Text>
              ))}
            </Text>,
          ),
        ]
      : []
    if (l.state === 'done') return [identity, line('end', <Text dimColor wrap="truncate" {...m}>{`${l.failed ?? 'done'}${l.endedAt ? ` ${clock(l.endedAt)}` : ''}${l.result ? ` — ${l.result}` : ''}`}</Text>), ...skills]
    const notes = [...(l.notes ?? [])].reverse()
    const files = [...(l.files ?? [])].reverse()
    return [
      identity,
      ...(own ? [] : [line('spend', <Text dimColor wrap="truncate" {...m}>{spend.join(' · ')}</Text>)]),
      ...(notes.length
        ? notes.map((nt, i) => {
            // Cut at a word where the pane's width is known: the clock takes ten characters of the line.
            const [head, tool] = noteFit(nt.text, nt.tool ? ` · ${nt.tool}` : '', o.columns === undefined ? Infinity : Math.max(0, o.columns - cont.length - 10))
            return line(
              `note-${i}`,
              <Text wrap="truncate" {...m}>
                <Text dimColor>{`${clock(nt.at)}  `}</Text>
                {i === 0 ? head : <Text dimColor>{head}</Text>}
                {tool ? <Text dimColor>{tool}</Text> : null}
              </Text>,
            )
          })
        : l.state === 'working' && l.doing
          ? [line('doing', <Text dimColor wrap="truncate" {...m}>{l.doing}</Text>)]
          : []),
      ...(files.length
        ? [
            line(
              'files',
              <Text wrap="truncate" {...m}>
                <Text dimColor>{'files: '}</Text>
                {files.map((f, i) => (
                  <Text key={`${n.id}-f${i}`}>
                    {i ? <Text dimColor>{' · '}</Text> : null}
                    <Text {...(f.kind === 'read' ? { dimColor: true } : {})}>{shortPath(f.path, l.worktreePath, o.cwd)}</Text>
                    <Text dimColor>{` (${f.kind})`}</Text>
                  </Text>
                ))}
              </Text>,
            ),
          ]
        : []),
      ...skills,
    ]
  })
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate" {...m}>
        {[`${running} running`, `${nodes.filter(n => n.loop.state === 'done').length} done`, queued.length ? `${queued.length} queued` : ''].filter(Boolean).join(' · ')}
      </Text>
      {/* a blank line sets blocks apart, but an agent's own agents go on under it */}
      {blocks.flatMap((b, k) => [...(nodes[k]!.depth <= 1 ? [<Text key={`gap-${k}`}>{' '}</Text>] : []), ...b])}
    </Box>
  )
}
