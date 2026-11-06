import { expect, test } from 'claude-code/testing'
import type { GearboxDemand, GearboxLoop } from '../types'
import { FILES_KEPT, NOTES_KEPT, SKILLS_KEPT, demandOf, ended, finished, groupsOf, hasAgents, latestDemand, metaOf, fit, grown, noteOf, revived, shortPath, tagsOf, treeOf, withChange, withFile, withNote, withSkill, withTool, withUsage, withWorktree, working, worktreeAdd } from './loops'

const loop = (extra: Partial<GearboxLoop> = {}): GearboxLoop => ({ label: 'agent', asked: 'sonnet', state: 'working', steps: 0, ...extra })

test('a note is the first line that says something, with the markdown off', () => {
  expect(noteOf('> - ## **Reading** the `orders` _file_ now\n\nA second paragraph.')).toBe('Reading the orders file now')
  expect(noteOf('```ts\nconst a = 1\n```\n---\nThen the totals.')).toBe('const a = 1')
  expect(noteOf('---\n\n```\n')).toBeUndefined()
})

test('a text is cut to its width at a word, with an ellipsis that counts in the width', () => {
  expect(fit('short', 10)).toBe('short')
  expect(fit('one two three four', 18)).toBe('one two three four')
  expect(fit('one two three four', 12)).toBe('one two…') // inside "three": back to the space before it
  expect(fit('one two three four', 14)).toBe('one two three…') // the cut falls between words: nothing to back off
  expect(fit('one two three four', 13)).toBe('one two…') // "three" is not whole in 12 characters
  // Back off only to a space in the last 15 characters; a longer word is cut where the width falls.
  expect(fit(`ab ${'x'.repeat(40)}`, 30)).toBe(`ab ${'x'.repeat(26)}…`)
  expect(fit(`${'a'.repeat(20)} ${'b'.repeat(30)}`, 30)).toBe(`${'a'.repeat(20)}…`)
  // A note, though, is cut at the last word within its limit, however far back.
  expect(fit(`ab ${'x'.repeat(40)}`, 30, 30)).toBe('ab…')
  for (const w of [1, 2, 5, 40]) expect(fit('Checking the totals for every customer in the report', w).length).toBeLessThanOrEqual(w)
})

test('a long note is stored cut at a word within 120 characters, with an ellipsis', () => {
  const said = 'Checking that the new endpoint refuses a request that carries no attribution token before I write the migration that adds the column'
  expect(said.length).toBeGreaterThan(120)
  const note = noteOf(`${said}\n\nMore below.`)!
  expect(note.length).toBeLessThanOrEqual(120)
  expect(note).toEndWith('…')
  const kept = note.slice(0, -1)
  expect(said.startsWith(kept)).toBe(true)
  expect(said[kept.length]).toBe(' ') // a whole word is the last
  expect(noteOf('A short one')).toBe('A short one')
  // No space to cut at: cut where the limit falls.
  expect(noteOf('x'.repeat(300))).toBe(`${'x'.repeat(119)}…`)
  // The result of an agent's report is cut the same way.
  expect(noteOf(`${said}.`)).toBe(note)
})

test('a line that crosses the limit while it is written is still the same note', () => {
  const said = 'Checking that the new endpoint refuses a request that carries no attribution token before I write the migration that adds the column'
  const whole = said.slice(0, 118) // 118 characters: kept whole
  expect(noteOf(whole)).toBe(whole)
  expect(grown(undefined, 'Reading')).toBe(false)
  expect(grown('Reading', 'Reading the config')).toBe(true)
  expect(grown('Reading the config', 'Editing it')).toBe(false)
  // Whole at the limit, then longer: the longer one is cut, so it reads shorter, but it is the same line.
  const cut = noteOf(said)!
  expect(grown(said.slice(0, 120), cut)).toBe(true)
  // Cut, then longer still: the cut line grows.
  expect(grown('Checking that the new…', 'Checking that the new endpoint…')).toBe(true)
  expect(grown('Checking that the new…', 'Reading the config')).toBe(false)
})

test('a line a request is still writing grows into one note; another line adds one; the last three stay', () => {
  let l = loop()
  l = withNote(l, 'Read', 1, false)
  l = withNote(l, 'Reading the config', 2, true) // the same line, longer: replaces it, keeping when it began
  expect(l.notes).toEqual([{ at: 1, text: 'Reading the config' }])
  l = withNote(l, 'Reading the config', 3, false) // the same line again, in the next request: nothing new
  expect(l.notes).toHaveLength(1)
  for (const [at, text] of [[4, 'Editing it'], [5, 'Running the tests'], [6, 'Reporting']] as const) l = withNote(l, text, at, false)
  expect(NOTES_KEPT).toBe(3)
  expect(l.notes?.map(n => n.text)).toEqual(['Editing it', 'Running the tests', 'Reporting'])
})

test('a note is followed by the latest tool called since it', () => {
  let l = withNote(loop(), 'Looking', 1, false)
  expect(l.notes?.[0]?.tool).toBeUndefined()
  l = withTool(l, 'Grep')
  l = withTool(l, 'Read')
  expect(l.notes?.[0]?.tool).toBe('Read')
  expect(withTool(loop(), 'Read').notes).toBeUndefined() // no note to follow
})

test('files: read, edited, or new; a file Write makes where the loop had not touched one is new, and stays new', () => {
  let l = loop()
  l = withFile(l, 'Read', '/w/a.ts')
  l = withFile(l, 'Write', '/w/b.ts') // not touched before: created
  l = withFile(l, 'Write', '/w/a.ts') // read first: overwritten, so edited
  l = withFile(l, 'Edit', '/w/b.ts') // a new file stays new
  l = withFile(l, 'Read', '/w/a.ts') // reading an edited file does not undo it
  l = withFile(l, 'Grep', '/w/c.ts') // not a file tool
  l = withFile(l, 'Read', undefined)
  expect(l.files).toEqual([{ path: '/w/b.ts', kind: 'new' }, { path: '/w/a.ts', kind: 'edited' }]) // the latest touched last
  expect(withFile(loop(), 'MultiEdit', '/w/m.ts').files).toEqual([{ path: '/w/m.ts', kind: 'edited' }])
  for (let i = 0; i < 10; i++) l = withFile(l, 'Read', `/w/f${i}.ts`)
  expect(l.files).toHaveLength(FILES_KEPT)
  expect(l.files?.at(-1)?.path).toBe('/w/f9.ts')
})

test('files an agent of the loop changed join its list as the agent had them, and are never a read', () => {
  let l = withFile(loop(), 'Read', '/w/a.ts')
  l = withChange(l, '/w/a.ts', 'edited')
  l = withChange(l, '/w/n.ts', 'new')
  l = withChange(l, '/w/n.ts', 'edited') // a new file stays new
  expect(l.files).toEqual([{ path: '/w/a.ts', kind: 'edited' }, { path: '/w/n.ts', kind: 'new' }])
})

test('skills: a loop keeps the name of each Skill it calls, once, in the order it first called it', () => {
  let l = loop()
  l = withSkill(l, 'Skill', 'tdd')
  l = withSkill(l, 'Skill', 'swanson-e2e')
  l = withSkill(l, 'Skill', 'tdd') // called again: it keeps its place
  l = withSkill(l, 'Skill', '/diagnosing-bugs') // a leading slash is not part of the name
  l = withSkill(l, 'Skill', 'diagnosing-bugs')
  l = withSkill(l, 'Skill', 'plugin:review') // a plugin's skill keeps its prefix
  expect(l.skills).toEqual(['tdd', 'swanson-e2e', 'diagnosing-bugs', 'plugin:review'])
  // Anything that is not a named Skill call changes nothing, and gives back the same loop.
  for (const [tool, skill] of [['Skill', undefined], ['Skill', '  '], ['Skill', 7], ['Read', 'orders'], ['Agent', 'tdd']] as const) expect(withSkill(l, tool, skill)).toBe(l)
  expect(withSkill(l, 'Skill', 'tdd')).toBe(l)
  expect(withSkill(loop(), 'Bash', 'ls').skills).toBeUndefined()
  // A loop that loads more than it keeps loses the earliest.
  for (let i = 0; i < SKILLS_KEPT + 6; i++) l = withSkill(l, 'Skill', `s${i}`)
  expect(l.skills).toHaveLength(SKILLS_KEPT)
  expect(l.skills?.at(-1)).toBe(`s${SKILLS_KEPT + 5}`)
})

// A tag line as the band draws it: ` ✦ name ` cells with one space between.
const drawn = (lines: string[][]) => lines.map(names => names.map(n => ` ✦ ${n} `).join(' '))

test('tags: a list that fits is one line; it breaks between tags, never inside one, onto as many lines as it needs', () => {
  expect(tagsOf([], 40)).toEqual([])
  expect(drawn(tagsOf(['tdd', 'swanson-e2e'], 40))).toEqual([' ✦ tdd   ✦ swanson-e2e '])
  expect(tagsOf(['aa', 'bb', 'cc'], 13)).toEqual([['aa', 'bb'], ['cc']]) // a tag is 4 wider than its name
  expect(tagsOf(['aa', 'bb', 'cc'], 12)).toEqual([['aa'], ['bb'], ['cc']]) // 13 would not fit in 12
  // Five tags, three lines: no cap, no …, every skill drawn.
  expect(drawn(tagsOf(['aa', 'bb', 'cc', 'dd', 'ee'], 15))).toEqual([' ✦ aa   ✦ bb ', ' ✦ cc   ✦ dd ', ' ✦ ee '])
  expect(drawn(tagsOf(['aa', 'bb', 'cc', 'dd', 'ee'], 13))).toEqual([' ✦ aa   ✦ bb ', ' ✦ cc   ✦ dd ', ' ✦ ee '])
  // A name wider than a line is cut with …, to a tag as wide as the line, and stands on a line of its own.
  expect(tagsOf(['x'.repeat(50)], 20)).toEqual([[`${'x'.repeat(15)}…`]])
  expect(drawn(tagsOf(['x'.repeat(50)], 20))).toEqual([` ✦ ${'x'.repeat(15)}… `])
  expect(tagsOf(['abcdefgh', 'ijklmnop', 'qrstuvwx'], 12)).toEqual([['abcdefgh'], ['ijklmnop'], ['qrstuvwx']])
  expect(tagsOf(['ab', 'x'.repeat(50), 'cd'], 20)).toEqual([['ab'], [`${'x'.repeat(15)}…`], ['cd']])
})

test('tags: every skill is drawn and no line is wider than the room, at the widths a terminal has', () => {
  const skills = ['swanson-db-rls-migrations', 'tdd', 'durable-progress', 'diagnosing-bugs', 'swanson-e2e', 'swanson-frontend', 'swanson-core-architecture', 'swanson-verify', 'swanson-recreation-intelligence', 'swanson-shared-packages', 'swanson-checkout-holds', 'swanson-deploy']
  for (let room = 12; room <= 140; room++) {
    const lines = tagsOf(skills, room)
    // All of them, in load order, each whole (a name is cut only where it is wider than the line).
    expect(lines.flat().length).toBe(skills.length)
    skills.forEach((s, i) => expect(lines.flat()[i]).toBe(s.length + 4 > room ? fit(s, room - 4) : s))
    for (const line of drawn(lines)) expect(line.length).toBeLessThanOrEqual(room)
    // It breaks only where the next tag would not fit: each line's first tag did not fit on the line before it.
    lines.slice(1).forEach((line, i) => expect(drawn([lines[i]!])[0]!.length + 1 + (line[0]!.length + 4)).toBeGreaterThan(room))
  }
})

test('a git worktree add names its path and its branch, however the command is written', () => {
  expect(worktreeAdd('git worktree add /tmp/wt-a -b part/a')).toEqual({ path: '/tmp/wt-a', branch: 'part/a' })
  expect(worktreeAdd('git -C /w/app worktree add -b part/b /tmp/wt-b origin/main')).toEqual({ path: '/tmp/wt-b', branch: 'part/b' })
  expect(worktreeAdd('cd /w/app && git worktree add "../my wt" feature/x && echo ok')).toEqual({ path: '../my wt', branch: 'feature/x' })
  expect(worktreeAdd('git worktree add --detach /tmp/wt-c')).toEqual({ path: '/tmp/wt-c' })
  expect(worktreeAdd('git worktree add --lock --reason "wip now" -B redo /tmp/wt-d')).toEqual({ path: '/tmp/wt-d', branch: 'redo' })
  expect(worktreeAdd('git worktree list')).toBeUndefined()
  expect(worktreeAdd('echo git worktree add')).toBeUndefined()
  expect(worktreeAdd('ls')).toBeUndefined()
})

test('a loop in a worktree is named by its branch, else its folder', () => {
  expect(withWorktree(loop(), { path: '/tmp/wt-a', branch: 'part/a' })).toMatchObject({ worktree: 'part/a', worktreePath: '/tmp/wt-a' })
  expect(withWorktree(loop(), { path: '/tmp/wt-b/' })).toMatchObject({ worktree: 'wt-b', worktreePath: '/tmp/wt-b/' })
  expect(withWorktree(loop({ worktree: 'worktree' }), {})).toMatchObject({ worktree: 'worktree' }) // nothing known: unchanged
})

test('usage adds up request by request; a loop that ends keeps the first line of its report and how it ended, and runs again clean', () => {
  const l = withUsage(withUsage(loop(), { in: 10, out: 2, usd: 0.5 }), { in: 5, out: 1, usd: 0.25 })
  expect(l.usage).toEqual({ in: 15, out: 3, usd: 0.75 })
  const done = ended({ ...l, doing: 'Bash: ls', said: 'Looking' }, 99, { failed: 'failed', result: 'No database.' })
  expect(done).toMatchObject({ state: 'done', endedAt: 99, failed: 'failed', result: 'No database.' })
  expect(done.doing).toBeUndefined()
  expect(done.said).toBeUndefined()
  expect(revived(done).endedAt).toBeUndefined()
  expect(revived(done).failed).toBeUndefined()
  expect(revived(done).result).toBeUndefined()
  expect(revived(done).usage).toEqual(l.usage)
})

test('a file is named relative to the worktree or the session’s folder, else by its last two parts', () => {
  expect(shortPath('/tmp/wt/src/a.ts', '/tmp/wt', '/w/app')).toBe('src/a.ts')
  expect(shortPath('/w/app/src/b.ts', undefined, '/w/app/')).toBe('src/b.ts')
  expect(shortPath('/elsewhere/deep/c.ts', '/tmp/wt', '/w/app')).toBe('deep/c.ts')
})

test('the tree nests each loop under the one that started it, with the guides each line needs', () => {
  const loops: Record<string, GearboxLoop> = {
    main: loop({ label: 'main' }),
    a: loop({ label: 'a', parent: 'main' }),
    b: loop({ label: 'b', parent: 'main' }),
    a1: loop({ label: 'a1', parent: 'a' }),
    a1x: loop({ label: 'a1x', parent: 'a1' }),
    c: loop({ label: 'c', parent: 'gone' }), // an unknown parent hangs from main
    d: loop({ label: 'd', parent: 'd' }), // its own parent: from main as well
  }
  const all = treeOf(loops, () => true)
  expect(all.map(n => [n.id, n.depth, n.last, n.trail.join()])).toEqual([
    ['a', 1, false, ''],
    ['a1', 2, true, 'true'],
    ['a1x', 3, true, 'true,false'],
    ['b', 1, false, ''],
    ['c', 1, false, ''],
    ['d', 1, true, ''],
  ])
  // One that is not kept gives its place to its own children, a level up; the last kept is last.
  const some = treeOf(loops, id => id === 'a1' || id === 'b' || id === 'a1x')
  expect(some.map(n => [n.id, n.depth, n.last, n.trail.join()])).toEqual([
    ['a1', 1, false, ''],
    ['a1x', 2, true, 'true'],
    ['b', 1, true, ''],
  ])
  expect(treeOf(loops, () => false)).toEqual([])
})

// ---- demands ----

const D1: GearboxDemand = { id: 'd1', title: 'Orders by customer', at: Date.UTC(2026, 0, 1, 14, 2) }
const D2: GearboxDemand = { id: 'd2', title: 'Issue for the backup', at: Date.UTC(2026, 0, 1, 14, 6) }

// The crew: three parts and an Explore under the second for the first demand, one agent for the second.
const crew = (): Record<string, GearboxLoop> => ({
  main: loop({ label: 'main' }),
  p1: loop({ label: 'part 1', parent: 'main', demand: D1 }),
  p2: loop({ label: 'part 2', parent: 'main', demand: D1 }),
  e1: loop({ label: 'Explore', parent: 'p2' }), // no demand of its own: its parent's
  p3: loop({ label: 'part 3', parent: 'main', demand: D1, state: 'done', endedAt: 5 }),
  i1: loop({ label: 'issue', parent: 'main', demand: D2 }),
})

test('a loop works for its own demand, else the one of the loop that started it, else none', () => {
  const loops = crew()
  expect(demandOf(loops, 'p1')).toEqual(D1)
  expect(demandOf(loops, 'e1')).toEqual(D1)
  expect(demandOf({ ...loops, x: loop({ parent: 'e1' }) }, 'x')).toEqual(D1) // two levels down
  expect(demandOf(loops, 'main')).toBeUndefined()
  expect(demandOf({ a: loop({ parent: 'main' }) }, 'a')).toBeUndefined() // one an older version recorded
  expect(demandOf({ a: loop({ parent: 'b' }), b: loop({ parent: 'a' }) }, 'a')).toBeUndefined() // a loop of parents ends
  expect(demandOf(loops, 'nobody')).toBeUndefined()
})

test('the latest demand an agent works for is the one with the latest start; a demand with no agent is no group', () => {
  expect(latestDemand(crew())).toEqual(D2)
  expect(latestDemand({ main: loop({ label: 'main' }) })).toBeUndefined()
  expect(hasAgents(crew(), D1)).toBe(true)
  expect(hasAgents(crew(), { id: 'd9', title: 'x', at: 1 })).toBe(false)
  // A part not yet started and a refused call are no agent of the demand.
  const loops = { ...crew(), 'queued:0': loop({ parent: 'main', demand: { id: 'd3', title: 'x', at: 9 }, state: 'idle' }), 'refused:1': loop({ parent: 'p1', demand: { id: 'd4', title: 'y', at: 9 }, failed: 'refused', state: 'done' }) }
  expect(hasAgents(loops, { id: 'd3', title: 'x', at: 9 })).toBe(false)
  expect(hasAgents(loops, { id: 'd4', title: 'y', at: 9 })).toBe(false)
})

test('the agents shown are grouped by demand, the earliest first, each group a tree of its own with fresh guides, and counted for the group', () => {
  const loops = crew()
  const groups = groupsOf(loops, new Set(['p1', 'p2', 'e1', 'p3', 'i1']))
  expect(groups.map(g => g.demand?.id)).toEqual(['d1', 'd2'])
  // The guides start fresh in each box: the issue is the only one of its box, so it closes it.
  expect(groups[0]!.nodes.map(n => `${n.id}:${n.depth}:${n.last}`)).toEqual(['p1:1:false', 'p2:1:false', 'e1:2:true', 'p3:1:true'])
  expect(groups[1]!.nodes.map(n => `${n.id}:${n.depth}:${n.last}`)).toEqual(['i1:1:true'])
  // How many of the demand's agents are at work, and how many it has: the finished one and the nested one count in the second.
  expect(groups.map(g => [g.live, g.total])).toEqual([[3, 4], [1, 1]])
  // Only the agents shown are drawn, but the counts are the demand's own.
  const some = groupsOf(loops, new Set(['p1', 'i1']))
  expect(some[0]!.nodes.map(n => n.id)).toEqual(['p1'])
  expect(some.map(g => [g.live, g.total])).toEqual([[3, 4], [1, 1]])
  // A demand none of whose agents is shown is no group; agents with no demand come first, with no demand.
  expect(groupsOf(loops, new Set(['i1'])).map(g => g.demand?.id)).toEqual(['d2'])
  const mixed = groupsOf({ ...loops, old: loop({ parent: 'main' }) }, new Set(['old', 'i1', 'p1']))
  expect(mixed.map(g => g.demand?.id)).toEqual([undefined, 'd1', 'd2'])
  // An agent whose parent works for another demand stands at the top of its own box.
  const moved = groupsOf({ ...crew(), p2: loop({ label: 'part 2', parent: 'main', demand: D2 }) }, new Set(['p1', 'p2', 'e1']))
  expect(moved.find(g => g.demand?.id === 'd2')!.nodes.map(n => `${n.id}:${n.depth}`)).toEqual(['p2:1', 'e1:2'])
})

test('a demand’s state is the agents at work of its agents and since when; short, how many are at work or that it is done', () => {
  const [one, two] = groupsOf(crew(), new Set(['p1', 'p2', 'e1', 'p3', 'i1']))
  expect(metaOf(one!, false)).toMatch(/^3 of 4 at work · since \d\d:\d\d$/)
  expect(metaOf(one!, true)).toBe('3 at work')
  expect(metaOf(two!, false)).toMatch(/^1 of 1 at work · since \d\d:\d\d$/)
  const over = groupsOf({ ...crew(), i1: loop({ parent: 'main', demand: D2, state: 'done', endedAt: 9 }) }, new Set(['i1']))[0]!
  expect(metaOf(over, false)).toMatch(/^done · since \d\d:\d\d$/)
  expect(metaOf(over, true)).toBe('done')
  // A group with no demand has no time to say.
  expect(metaOf({ nodes: [], live: 2, total: 2, queued: 0 }, false)).toBe('2 of 2 at work')
})

// The agents of D2 all ended, as the second demand of crew() when its issue agent is done.
const ended2 = (): Record<string, GearboxLoop> => ({ ...crew(), i1: loop({ parent: 'main', demand: D2, state: 'done', endedAt: 9 }) })
const group2 = (loops: Record<string, GearboxLoop>, shown: string[] = ['i1']) => groupsOf(loops, new Set(shown)).find(g => g.demand?.id === 'd2')!

test('a demand is finished when none of its agents is at work and none of its parts is queued', () => {
  expect(finished(group2(crew()))).toBe(false) // its agent is at work
  expect(finished(group2(ended2()))).toBe(true)
  // Waiting on background work of its own is still at work.
  expect(finished(group2({ ...crew(), i1: loop({ parent: 'main', demand: D2, state: 'waiting' }) }))).toBe(false)
  // A failed, refused or stopped agent has ended too.
  expect(finished(group2({ ...crew(), i1: loop({ parent: 'main', demand: D2, state: 'done', failed: 'failed', endedAt: 9 }) }))).toBe(true)
  // A demand whose agents all ended but whose part has not started is not finished: the part is an idle loop, no agent yet.
  const queued = { ...ended2(), 'queued:0': loop({ label: 'part 4', parent: 'main', demand: D2, state: 'idle' }) }
  const g = group2(queued)
  expect([g.live, g.total, g.queued]).toEqual([0, 1, 1])
  expect(finished(g)).toBe(false)
  // The queued part counts whether or not it is drawn (the band may have no room for it), and only for its own demand.
  expect(group2(queued, ['i1']).nodes.map(n => n.id)).toEqual(['i1'])
  expect(group2(queued, ['i1']).queued).toBe(1)
  expect(finished(group2({ ...ended2(), 'queued:0': loop({ parent: 'main', demand: D1, state: 'idle' }) }))).toBe(true)
  // Only parts: no agent yet, and not finished.
  const only = groupsOf({ main: loop({ label: 'main' }), 'queued:0': loop({ parent: 'main', demand: D2, state: 'idle' }), 'queued:1': loop({ parent: 'main', demand: D2, state: 'idle' }) }, new Set(['queued:0', 'queued:1']))[0]!
  expect([only.live, only.total, only.queued, finished(only)]).toEqual([0, 0, 2, false])
})

test('"done" is printed for a finished demand only; one with nothing at work but parts queued says how many are queued', () => {
  const queued = { ...ended2(), 'queued:0': loop({ label: 'part 4', parent: 'main', demand: D2, state: 'idle' }), 'queued:1': loop({ label: 'part 5', parent: 'main', demand: D2, state: 'idle' }) }
  const g = group2(queued)
  expect(metaOf(g, false)).toMatch(/^2 queued · since \d\d:\d\d$/)
  expect(metaOf(g, true)).toBe('2 queued')
  // Once one is at work it is "N of M at work" again; the queued parts are not among M.
  const going = group2({ ...queued, i1: loop({ parent: 'main', demand: D2 }) })
  expect(metaOf(going, false)).toMatch(/^1 of 1 at work · since \d\d:\d\d$/)
  expect(metaOf(group2(ended2()), false)).toMatch(/^done · since/)
})

test('the readouts redraw on a tick while some loop is in a turn: main or an agent, not one waiting', () => {
  expect(working({ main: loop({ label: 'main' }) })).toBe(true)
  expect(working({ main: loop({ label: 'main', state: 'idle' }), a: loop({ parent: 'main' }) })).toBe(true)
  expect(working({ main: loop({ label: 'main', state: 'idle' }), a: loop({ parent: 'main', state: 'waiting' }), b: loop({ parent: 'main', state: 'done' }), 'queued:0': loop({ state: 'idle' }) })).toBe(false)
  expect(working({})).toBe(false)
})
