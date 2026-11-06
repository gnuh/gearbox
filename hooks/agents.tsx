import type { ElementTable, RenderElement } from 'claude-code'
import type { GearboxDemand, GearboxLoop } from '../types'
import { type Group, type Node, QUEUED, bars, clock, demandOf, family, finished, fit, gearText, groupsOf, hue, isQueued, kilo, labelOf, live, metaOf, money, nowOf, ran, shortPath, swapped, tagsOf, treeOf } from './loops'
import { stoppable } from './stopping'

// How the readouts draw the agents running: the band above the prompt (a tree of text in the terminal, a card each in
// the desktop app) and the panel. Both read the same loops; only the drawing differs. The agents of one demand (the
// request they were started for) are drawn together, in a box with the request's title on its first line.

type Els = Pick<ElementTable, 'Box' | 'Text'>

// What draws and answers the Stop of an agent: the surface's Button, and what a press on agent `id` does. Without it
// (nothing to stop with) no row has one.
export type StopControl = { Button: ElementTable['Button']; press: (id: string) => void }

// The colours of the states: ● and ✓ green, ◐ and ⚠ amber, ✗ red, ◌ dim.
const FINISHED = '#4FBF6A'
const WAITING = '#E9A23B'
const FAILED = '#E5646E'
// The grey of a finished demand's edges, the one colour it keeps. Text there is dimColor with no colour; a border cannot be
// dimmed the same way, since borderDimColor is the theme's own dim border, which some terminals draw in a colour (tan).
// A mid grey reads on a light ground and on a dark one.
const GREY = '#7C8592'

// The pulse of a working agent's ●: neither surface has opacity in a Text, so the green steps through PULSE_STEPS shades
// of itself, from full green down to a dim green and back, once per PULSE_CYCLE_MS. The shade is a function of the clock,
// so every dot in the band is at the same step, and the screen has to be redrawn every PULSE_MS to move it.
export const PULSE_CYCLE_MS = 2000
export const PULSE_STEPS = 8
export const PULSE_MS = PULSE_CYCLE_MS / PULSE_STEPS
// The dim end of a shade is full green blended with this near-black, 28% green at the dimmest.
const PULSE_FLOOR = 0.28
const PULSE_GROUND = [0x0f, 0x12, 0x16] as const
const PULSE_GREEN = [0x4f, 0xbf, 0x6a] as const
export const PULSE: readonly string[] = Array.from({ length: PULSE_STEPS }, (_, i) => {
  const strength = PULSE_FLOOR + (1 - PULSE_FLOOR) * (0.5 + 0.5 * Math.cos((2 * Math.PI * i) / PULSE_STEPS))
  return `#${PULSE_GREEN.map((g, k) => Math.round(PULSE_GROUND[k]! + (g - PULSE_GROUND[k]!) * strength).toString(16).padStart(2, '0').toUpperCase()).join('')}`
})
// The shade of the working ● at `now` (ms): step 0 is the full green.
export const pulseAt = (now: number): string => PULSE[Math.floor((((now % PULSE_CYCLE_MS) + PULSE_CYCLE_MS) % PULSE_CYCLE_MS) / PULSE_MS)]!

// At most this many live agents are drawn; the rest are counted ("+N agents · Panel").
const MAX_LIVE = 4
// The terminal band's lines for what hangs under main, one demand's box not counted: with its header, rule and main's
// two lines, about twelve. A box costs GROUP_ROWS more (its edges and its title), a demand with no border one (its title).
const BAND_ROOM = 8 + 3
const GROUP_ROWS = 3
// How many cards beyond the live ones (finished, queued) the desktop draws.
const EXTRA_CARDS = 4
// A terminal narrower than this draws the narrow band.
export const NARROW = 100
// A terminal narrower than this draws no box around a demand's agents: its title, then the rows.
export const BORDER_MIN = 60
// A box takes 4 columns of its width: the two edges and the padding inside them.
const BOX = 4

// A fan-out part whose agent has not started: drawn as a loop of its own, under main (id `queued:<n>`).
export type Queued = { label: string; model: string; effort: string }
// `demand`: the one they belong to (the turn's).
const withQueued = (loops: Record<string, GearboxLoop>, queued: readonly Queued[], demand?: GearboxDemand): Record<string, GearboxLoop> => ({
  ...loops,
  ...Object.fromEntries(queued.map((q, i) => [`${QUEUED}${i}`, { label: q.label, parent: 'main', ...(demand ? { demand } : {}), asked: q.model, effort: q.effort, state: 'idle', steps: 0 } satisfies GearboxLoop])),
})

// A finished agent the turn's prompt has not passed yet.
const recent = (l: GearboxLoop, since?: number) => l.state === 'done' && l.endedAt !== undefined && (since === undefined || l.endedAt >= since)

type Chosen = { nodes: Node[]; shown: Set<string>; hidden: number }

// The agents to draw: up to MAX_LIVE live ones, then, while `room` lasts (each costing `cost`), the finished ones of this
// turn and the queued parts, nested as they began. `hidden` counts those left out. `group`: what the first agent of a
// demand costs besides (its box's edges and title).
const choose = (all: Record<string, GearboxLoop>, o: { since?: number; room: number; cost: (n: Node) => number; group?: number }): Chosen => {
  const order = treeOf(all, (id, l) => id !== 'main' && (isQueued(id) || live(l) || recent(l, o.since)))
  const key = (n: Node) => demandOf(all, n.id)?.id ?? ''
  const boxed = new Set<string>()
  const extra = (n: Node) => (key(n) && !boxed.has(key(n)) ? (o.group ?? 0) : 0)
  const lives = order.filter(n => live(n.loop)).slice(0, MAX_LIVE)
  const shown = new Set(lives.map(n => n.id))
  let room = o.room
  for (const n of lives) {
    room -= o.cost(n) + extra(n)
    boxed.add(key(n))
  }
  for (const n of order)
    if (!shown.has(n.id) && !live(n.loop) && o.cost(n) + extra(n) <= room) {
      shown.add(n.id)
      room -= o.cost(n) + extra(n)
      boxed.add(key(n))
    }
  return { nodes: treeOf(all, id => shown.has(id)), shown, hidden: order.length - shown.size }
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
  stop?: 'press' | 'wait' // an agent that can be stopped: its button, or "stopping" once pressed
  grey?: true // in a finished demand: nothing keeps its colour, there is nothing to stop
}

// How the rows are drawn: whether the working ● pulses, and whether the demand they belong to is finished (all grey).
type Look = { pulse: boolean; grey: boolean }

const SRC = { main: 'main', rules: 'rules', auto: 'auto' } as const
const SOURCE = { main: 'chosen by main', rules: 'by rules', auto: 'auto' } as const

// How a finished one ended: well ("done"), or not; and the first line of what it handed back. `bare`: just that line
// where it ended well.
const ending = (l: GearboxLoop, bare: boolean) => (bare && !l.failed && l.result ? l.result : [l.failed ?? 'done', l.result].filter(Boolean).join(' · '))

// Its requests and how long it ran (still running: to now).
const statsOf = (l: GearboxLoop, now: number, running: boolean) =>
  [`${l.steps} req`, l.since !== undefined && (running || l.endedAt !== undefined) ? ran((running ? now : l.endedAt!) - l.since) : ''].filter(Boolean).join('  ')

// The glyph of a loop and its colour. Only the ● of a loop at work pulses (with `pulse`); ✓ ✗ ◐ ◌ ⚠ stand still.
const glyphOf = (id: string, l: GearboxLoop, now: number, pulse: boolean): [string, string | undefined] =>
  isQueued(id) ? ['◌', undefined] : l.state === 'done' ? (l.failed ? ['✗', FAILED] : ['✓', FINISHED]) : l.state === 'waiting' ? ['◐', WAITING] : swapped(l) ? ['⚠', WAITING] : ['●', pulse && l.state === 'working' ? pulseAt(now) : FINISHED]

const rowOf = (n: Node, now: number, shape: Shape, look: Look): Row => {
  const l = n.loop
  const [glyph, color] = glyphOf(n.id, l, now, look.pulse)
  // The narrow band names a running agent by its first word or two ("part 1", "Explore"); a finished one in full.
  const label = shape === 'narrow' && l.state !== 'done' ? labelOf(l).split(' · ')[0]! : labelOf(l)
  // In a finished demand every colour goes (the glyph's, the gear's, a note's) and so does the Stop: the rows are dimmed text.
  const common = {
    node: n,
    glyph,
    ...(color && !look.grey ? { color } : {}),
    label,
    gear: gearText(l),
    skills: l.skills ?? [],
    ...(isQueued(n.id) || look.grey ? {} : { tint: hue(l) }),
    ...(stoppable(n.id, l) && !look.grey ? { stop: l.stopping ? ('wait' as const) : ('press' as const) } : {}),
    ...(look.grey ? { grey: true as const } : {}),
  }
  if (isQueued(n.id)) return { ...common, dim: true, extra: 'queued', stats: '', two: false }
  if (l.state === 'done') return { ...common, dim: true, ...(l.effortBy ? { src: SRC[l.effortBy] } : {}), extra: ending(l, shape === 'narrow'), stats: statsOf(l, now, false), two: false }
  const said = nowOf(l)
  const fallback = swapped(l) ? `answered by ${family(l.answered!) ?? l.answered}` : undefined
  const note: NoteLine =
    l.state === 'waiting'
      ? { head: 'waiting on its own background work', dim: true }
      : { head: said.text, ...(said.tool ? { tool: said.tool } : {}), ...(fallback ? { fallback } : {}), ...(said.said && !look.grey ? {} : { dim: true }) }
  return {
    ...common,
    dim: look.grey,
    ...(l.effortBy ? { src: SRC[l.effortBy] } : {}),
    ...(l.worktree ? { extra: `⎇ ${l.worktree}` } : {}),
    stats: statsOf(l, now, true),
    note,
    // A narrow band keeps an agent a subagent started to one line.
    two: shape !== 'narrow' || n.depth < 2,
  }
}

// The main conversation's row: in a turn, its note; between turns, that it waits on its agents or for a prompt.
const mainRowOf = (main: GearboxLoop, agents: number, now: number, pulse: boolean): Row => {
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
    ...(working ? { color: pulse ? pulseAt(now) : FINISHED } : waits ? { color: WAITING } : {}),
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

// ---- Stop: a button on every agent at work, "stopping" once pressed ----

const STOP_MARK = '■'
const STOP_WAIT = 'stopping…'
// The room the terminal keeps at the end of an agent's identity line for it: "stopping…" in the wide band, "[ ■ ]" in the
// narrow one (where "…" stands for "stopping…"). Every line keeps it (empty where there is nothing to stop), so the
// column before it lines up.
const STOP_W = STOP_WAIT.length
const STOP_W_NARROW = '[ ■ ]'.length
// What a narrow identity line needs besides the label: gear, the time ("12m 05s"), the stop slot and the gaps.
const NARROW_FIXED = 14 + 7 + STOP_W_NARROW + 4

// A row's Stop: a button with just the mark, or "stopping…" in its place once pressed ("…" in the narrow band). `kind`:
// the terminal's wide and narrow band and the panel, or a desktop card (a secondary button).
const stopSlot = ({ Text }: Pick<ElementTable, 'Text'>, c: StopControl, r: Row, kind: 'wide' | 'narrow' | 'desktop'): RenderElement | null => {
  if (!r.stop) return null
  const { Button } = c
  const id = r.node.id
  if (r.stop === 'wait') {
    if (kind === 'narrow') return <Text dimColor>{'  …'}</Text>
    return kind === 'desktop' ? (
      <Text dimColor size="caption">
        {STOP_WAIT}
      </Text>
    ) : (
      <Text dimColor>{STOP_WAIT}</Text>
    )
  }
  // The desktop draws a Button's label, not its children, and ButtonProps has no separate name or tooltip: just the mark.
  // There it is a secondary button, as the unselected values of the settings are, not dim text.
  return kind === 'desktop' ? (
    <Button key={`stop-${id}`} variant="secondary" label={STOP_MARK} onPress={() => c.press(id)} />
  ) : (
    <Button key={`stop-${id}`} dimColor label={STOP_MARK} onPress={() => c.press(id)} />
  )
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

// The fixed columns of the identity lines of `rows`, in a terminal `columns` wide: the label's width and the room the Stop
// slot takes. With an agent to stop the lines end in the slot; the narrow band's label gives up what the slot takes.
type Align = { labelW: number; slot: number }
const alignOf = (rows: Row[], shape: Shape, columns: number, stop?: StopControl): Align => {
  const slot = stop && rows.some(r => r.stop) ? (shape === 'narrow' ? STOP_W_NARROW : STOP_W) : 0
  return { slot, labelW: labelWidth(rows, shape === 'narrow' ? Math.max(10, Math.min(26, slot ? columns - NARROW_FIXED : 26)) : 32) }
}

// The identity line, the skills (tags, as many lines as they need) and the note line of each row, in a terminal `columns` wide
// (a demand's box: what is inside it). `wide`: gear, who chose the effort, worktree, requests and time; `narrow`: gear and
// time, a finished agent in one line. `align`: the fixed columns, shared by the rows of several boxes so they line up.
const treeRows = ({ Box, Text }: Els, rows: Row[], shape: Shape, columns: number, stop?: StopControl, align: Align = alignOf(rows, shape, columns, stop)) => {
  const { labelW, slot } = align
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
        {slot ? (
          <Box width={slot} flexShrink={0}>
            {stop ? stopSlot({ Text }, stop, r, shape) : null}
          </Box>
        ) : null}
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

// Whether a demand is drawn grey, as a disabled control: it has a box, and its agents have all finished (and none waits to
// start). An agent with no demand has no box to grey.
const greyed = (g: Group): boolean => g.demand !== undefined && finished(g)

// The first line of a demand: its title (bold, cut where the line ends) and, right of it, how its agents are doing. A
// finished demand's title is dimmed.
const groupHead = ({ Box, Text }: Els, g: Group, short: boolean, key: string, mono: object = {}) => (
  <Box key={`${key}-head`} flexDirection="row" columnGap={2}>
    <Box flexGrow={1} flexShrink={1}>
      <Text weight="bold" wrap="truncate" {...(greyed(g) ? { dimColor: true } : {})} {...mono}>
        {g.demand?.title ?? ''}
      </Text>
    </Box>
    <Box flexShrink={0}>
      <Text dimColor {...mono}>
        {metaOf(g, short)}
      </Text>
    </Box>
  </Box>
)

// A demand in the terminal: a box with a dim round border, its title on the first line and its rows under it (Ink draws the
// edges, and the padding keeps the rows 4 columns inside the width). Once the demand is finished the border is an explicit
// grey instead (see GREY). Where the terminal is too narrow for the edges (`bordered` false) it is the title and the rows.
// Agents with no demand are the rows alone.
const groupBox = (t: Els, g: Group, rows: RenderElement[], o: { bordered: boolean; short: boolean; mono?: object }) => {
  const { Box } = t
  if (!g.demand) return <Box key="demand-none" flexDirection="column">{rows}</Box>
  const key = `demand-${g.demand.id}`
  const head = groupHead(t, g, o.short, key, o.mono)
  return o.bordered ? (
    <Box key={key} flexDirection="column" borderStyle="round" {...(greyed(g) ? { borderColor: GREY } : { borderDimColor: true })} paddingX={1}>
      {head}
      {rows}
    </Box>
  ) : (
    <Box key={key} flexDirection="column">
      {head}
      {rows}
    </Box>
  )
}

const more = ({ Text }: Pick<ElementTable, 'Text'>, n: number) => (n > 0 ? <Text dimColor>{`+${n} agent${n === 1 ? '' : 's'} · Panel`}</Text> : null)

// ---- the band above the prompt ----

// What the band is told, drawn alike by both surfaces.
export type Summary = {
  loops: Record<string, GearboxLoop>
  queued: readonly Queued[]
  since?: number // when this turn began
  demand?: GearboxDemand // the request in force, which the parts not yet started belong to
  now: number
  pulse: boolean // the ● of a loop at work steps through its shades with `now`; off, it stays full green
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
export const terminalBand = ({ Box, Text }: Els, s: Summary, o: { columns: number; actions: RenderElement; stop?: StopControl }) => {
  const narrow = o.columns < NARROW
  const shape: Shape = narrow ? 'narrow' : 'wide'
  const main = s.loops.main
  // Each demand's agents are inside a box, 4 columns narrower than the band (none where the band is too narrow for the edges).
  const bordered = o.columns >= BORDER_MIN
  const inner = bordered ? o.columns - BOX : o.columns
  const all = withQueued(s.loops, s.queued, s.demand)
  const chosen = choose(all, { ...(s.since !== undefined ? { since: s.since } : {}), room: BAND_ROOM, group: bordered ? GROUP_ROWS : 1, cost: n => (live(n.loop) ? (narrow && n.depth >= 2 ? 1 : 2) : 1) + tagsFor(n, n.loop.skills ?? [], inner).length })
  const groups = groupsOf(all, chosen.shown).map(g => ({ g, rows: g.nodes.map(n => rowOf(n, s.now, shape, { pulse: s.pulse, grey: greyed(g) })) }))
  const every = groups.flatMap(x => x.rows)
  // The columns are the same in every box, and main's row, which stands outside them, keeps its gear where theirs is.
  const align = alignOf(every, shape, inner, o.stop)
  const mainRow = main ? mainRowOf(main, s.subs.length, s.now, s.pulse) : undefined
  const body = groups.map(({ g, rows }) => groupBox({ Box, Text }, g, treeRows({ Box, Text }, rows, shape, inner, o.stop, align), { bordered, short: narrow }))
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
      {mainRow ? treeRows({ Box, Text }, [mainRow], shape, o.columns, undefined, { labelW: align.labelW + (bordered && groups.some(x => x.g.demand) ? BOX / 2 : 0), slot: 0 }) : null}
      {body}
      {mainRow || body.length ? null : <Text dimColor>waiting for a prompt</Text>}
      {more({ Text }, chosen.hidden)}
    </Box>
  )
}

// ---- the desktop's band: metrics, then a card per agent ----

// A chip: the desktop has no pill, so it is a small rounded box around a caption. In a finished demand (`grey`) its
// border is the explicit grey, as the demand's.
const pill = ({ Box, Text }: Els, text: string, color?: string, key?: string, grey?: boolean) => (
  <Box key={key} borderStyle="round" paddingX="xs" {...(color ? { borderColor: color } : grey ? { borderColor: GREY } : { borderDimColor: true })}>
    <Text size="caption" {...(color ? { color } : { dimColor: true })}>
      {text}
    </Text>
  </Box>
)

// The strip a demand's title stands on, in the desktop's box: the grey of its text at a fifth of its strength, so it tints
// the surface's own ground in a light or a dark theme. A finished demand's is flatter, at a tenth.
const STRIP = '#7C859233'
const STRIP_DONE = '#7C85921A'

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
const card = (t: Els, r: Row, kids: RenderElement[], o: { role?: string; before?: string; stop?: StopControl }): RenderElement => {
  const { Box, Text } = t
  const l = r.node.loop
  const note = r.note
  return (
    <Box key={`card-${r.node.id}`} flexDirection="row" borderStyle="round" {...(r.grey ? { borderColor: GREY } : { borderDimColor: true })} columnGap="sm" paddingX="sm">
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
          {pill(t, r.gear, r.tint, undefined, r.grey)}
          {l.effortBy ? pill(t, SOURCE[l.effortBy], undefined, undefined, r.grey) : null}
          {l.worktree ? pill(t, `⎇ ${l.worktree}`, undefined, undefined, r.grey) : null}
          <Box flexGrow={1} />
          <Text dimColor tabular size="caption">
            {r.stats.replace('  ', ' · ')}
          </Text>
          {o.stop ? stopSlot(t, o.stop, r, 'desktop') : null}
        </Box>
        {r.skills.length ? (
          <Box flexDirection="row" columnGap="sm" alignItems="center" flexWrap="wrap">
            {r.skills.map(name => pill(t, `✦ ${name}`, undefined, `skill-${name}`, r.grey))}
          </Box>
        ) : null}
        {note ? (
          <Box flexDirection="row" columnGap="sm" alignItems="center">
            <Box flexShrink={1}>
              <Text wrap="truncate" {...(note.dim ? { dimColor: true } : note.color ? { color: note.color } : {})}>
                {note.head}
              </Text>
            </Box>
            {note.tool ? pill(t, note.tool, undefined, undefined, r.grey) : null}
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
export const desktopBand = (t: Els, s: Summary, o: { columns: number; actions: RenderElement; stop?: StopControl }) => {
  const { Box, Text } = t
  const main = s.loops.main
  const all = withQueued(s.loops, s.queued, s.demand)
  const chosen = choose(all, { ...(s.since !== undefined ? { since: s.since } : {}), room: EXTRA_CARDS, cost: n => (live(n.loop) ? 0 : 1) })
  // Each demand is a bordered container: a strip with its title (left) and how its agents are doing (right), then the cards.
  // A finished one is all grey.
  const groups = groupsOf(all, chosen.shown).map(g => ({ g, trees: nest(g.nodes), grey: greyed(g) }))
  const rows = new Map(groups.flatMap(({ g, grey }) => g.nodes.map(n => [n.id, rowOf(n, s.now, 'wide', { pulse: s.pulse, grey })] as const)))
  const cards = (trees: Tree[]): RenderElement[] =>
    trees.map(({ node, kids }) => {
      const l = node.loop
      // Who started it, where that is an agent (a card a demand's box holds may be one an agent of another demand started).
      const owner = l.parent && l.parent !== 'main' && l.parent !== node.id ? all[l.parent] : undefined
      const before = l.state === 'done' ? undefined : l.notes?.at(-2)?.text
      return card(t, rows.get(node.id)!, cards(kids), { ...(owner ? { role: `started by ${labelOf(owner).split(' · ')[0]}` } : {}), ...(before ? { before } : {}), ...(o.stop ? { stop: o.stop } : {}) })
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
      {main ? card(t, mainRowOf(main, s.subs.length, s.now, s.pulse), [], { role: 'main session', ...(works && main.notes?.at(-2) ? { before: main.notes.at(-2)!.text } : {}) }) : null}
      {groups.map(({ g, trees, grey }) =>
        g.demand ? (
          <Box key={`demand-${g.demand.id}`} flexDirection="column" borderStyle="round" {...(grey ? { borderColor: GREY } : { borderDimColor: true })} overflow="hidden">
            <Box flexDirection="row" columnGap="md" alignItems="center" paddingX="sm" paddingY="xs" backgroundColor={grey ? STRIP_DONE : STRIP}>
              <Box flexShrink={1}>
                <Text weight="semibold" {...(grey ? { dimColor: true } : {})}>
                  {g.demand.title}
                </Text>
              </Box>
              <Box flexGrow={1} />
              <Text dimColor size="caption">
                {metaOf(g, false)}
              </Text>
            </Box>
            <Box flexDirection="column" rowGap="sm" padding="sm">
              {cards(trees)}
            </Box>
          </Box>
        ) : (
          <Box key="demand-none" flexDirection="column" paddingLeft="sm">
            {cards(trees)}
          </Box>
        ),
      )}
      {more({ Text }, chosen.hidden)}
    </Box>
  )
}

// ---- the panel: a block per agent ----

// Every loop of the session, finished ones included: main first, then each demand in a box (as the band draws it) holding
// its agents nested under the loop that started them: its identity, what it has cost, its last notes (the latest first,
// the earlier dimmed), the files it touched and its worktree.
export const panelBody = ({ Box, Text }: Els, loops: Record<string, GearboxLoop>, queued: readonly Queued[], o: { now: number; pulse: boolean; cwd?: string; handoff: boolean; mono: boolean; columns?: number; stop?: StopControl; demand?: GearboxDemand }) => {
  const m = o.mono ? { mono: true as const } : {}
  const all = withQueued(loops, queued, o.demand)
  const main = loops.main
  // The boxes take 4 columns of the pane's width (none where it is too narrow for the edges).
  const bordered = o.columns === undefined || o.columns >= BORDER_MIN
  const inner = o.columns === undefined ? undefined : bordered ? o.columns - BOX : o.columns
  const groups = groupsOf(all, new Set(Object.keys(all).filter(id => id !== 'main')))
  const running = Object.entries(all).filter(([id, l]) => id !== 'main' && live(l)).length
  const mainNode: Node[] = main ? [{ id: 'main', loop: main, depth: 0, last: true, trail: [] }] : []
  const nodes: Node[] = [...mainNode, ...groups.flatMap(g => g.nodes)]
  const grey = new Set(groups.filter(greyed).flatMap(g => g.nodes.map(n => n.id)))
  const rows = new Map(nodes.map(n => [n.id, n.id === 'main' ? mainRowOf(main!, running, o.now, o.pulse) : rowOf(n, o.now, 'wide', { pulse: o.pulse, grey: grey.has(n.id) })] as const))
  const labelW = labelWidth([...rows.values()], 34)
  const block = (n: Node): RenderElement[] => {
    const l = n.loop
    const r = rows.get(n.id)!
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
        {o.stop && r.stop ? (
          <Box flexShrink={0}>{stopSlot({ Text }, o.stop, r, 'wide')}</Box>
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
                <Text key={`${n.id}-s${i}`} {...(r.grey ? { dimColor: true } : {})}>
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
            const [head, tool] = noteFit(nt.text, nt.tool ? ` · ${nt.tool}` : '', inner === undefined ? Infinity : Math.max(0, inner - cont.length - 10))
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
  }
  // A blank line sets blocks apart (and boxes), but an agent's own agents go on under it.
  const gap = (n: Node) => <Text key={`gap-${n.id}`}>{' '}</Text>
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate" {...m}>
        {[`${running} running`, `${nodes.filter(n => n.loop.state === 'done').length} done`, queued.length ? `${queued.length} queued` : ''].filter(Boolean).join(' · ')}
      </Text>
      {mainNode.flatMap(block)}
      {groups.flatMap(g => {
        const blocks = g.nodes.flatMap((n, i) => [...(n.depth <= 1 && (!g.demand || i) ? [gap(n)] : []), ...block(n)])
        return g.demand ? [<Text key={`gap-${g.demand.id}`}>{' '}</Text>, groupBox({ Box, Text }, g, blocks, { bordered, short: false, mono: m })] : blocks
      })}
    </Box>
  )
}
