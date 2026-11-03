import { expect, test } from 'claude-code/testing'
import type { GearboxLoop } from '../types'
import { FILES_KEPT, NOTES_KEPT, ended, fit, grown, noteOf, revived, shortPath, treeOf, withFile, withNote, withTool, withUsage, withWorktree, worktreeAdd } from './loops'

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
