import type { GearboxFile, GearboxLoop } from '../types'
import { MODELS, type Model } from './policy'

// What the readouts know of a loop (see GearboxLoop), kept apart from the hooks that fill it and the components that
// draw it: the names a loop shows, the notes, files, worktree and tokens it collects, and the tree of loops.

const HUE: Record<Model, string> = { haiku: '#2BB3A0', sonnet: '#5B8DEF', opus: '#D99A2B', fable: '#D062B5' }

// A model id or alias as its family: claude-sonnet-5-5 → sonnet.
export const family = (id: string): Model | undefined => MODELS.find(m => id.includes(m))
export const gearText = (l: GearboxLoop) => `${family(l.asked) ?? l.asked}${l.effort ? `·${l.effort}` : ''}`
export const hue = (l: GearboxLoop) => HUE[family(l.asked) ?? 'opus']
// A fallback answered on another family than the step asked for.
export const swapped = (l: GearboxLoop) => l.answered !== undefined && family(l.answered) !== family(l.asked)

export const kilo = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))
export const money = (n: number) => `$${n.toFixed(2)}`
export const bars = (vals: number[]) => {
  const top = Math.max(...vals, 0)
  return top > 0 ? vals.map(v => '▁▂▃▄▅▆▇█'[Math.min(7, Math.round((v / top) * 7))]).join('') : ''
}
// How long a subagent has run: "42s", "3m 05s".
export const ran = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}
// A moment as the panel dates a note: "14:02:31", the person's own clock.
export const clock = (at: number) => {
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

// A text cut to `width` characters (the "…" counts) at a word: where the cut falls inside one, back to the space before
// it, if one lies within the last `back` characters; else the cut stays. Whole when it fits.
export const fit = (text: string, width: number, back = 15): string => {
  if (text.length <= width) return text
  const room = Math.max(0, width - 1)
  const head = text.slice(0, room)
  const space = head.lastIndexOf(' ')
  const inWord = text[room] !== ' ' && !head.endsWith(' ')
  return `${(inWord && space > 0 && room - space <= back ? head.slice(0, space) : head).trimEnd()}…`
}

// The first line of a text that says something, as a note: markdown markers off, whitespace folded, cut at a word
// within 120 characters. Lines with no letter or digit (a rule, a code fence) say nothing. Undefined when no line does.
export const noteOf = (text: string): string | undefined => {
  for (const raw of text.split('\n')) {
    if (raw.trim().startsWith('```')) continue
    const line = raw
      .replace(/^[\s>]*(?:(?:#{1,6}|[-*+•]|\d+[.)])\s+)*/, '')
      .replace(/[*`]/g, '')
      .replace(/(^|\s)_+|_+(?=\s|$)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
    if (/[\p{L}\p{N}]/u.test(line)) return fit(line, NOTE_MAX, NOTE_MAX)
  }
  return undefined
}
const NOTE_MAX = 120
// Whether `latest` is the line `written` still being written, grown: a line that has crossed the limit is cut, so the
// longer one can read shorter than the whole line before it.
export const grown = (written: string | undefined, latest: string): boolean => {
  if (written === undefined) return false
  const was = written.endsWith('…') ? written.slice(0, -1) : written
  return latest.startsWith(was) || (latest.endsWith('…') && was.startsWith(latest.slice(0, -1)))
}
// A note streaming in is written at most this often; the request's end writes whatever is last.
export const NOTE_EVERY_MS = 400

// A tool call's short name, as the tool chip shows it: "Bash: ls" → "Bash", "Read orders.ts" → "Read".
export const toolName = (doing: string) => doing.split(/[: ]/)[0]!

// What a loop shows as its now: its latest note and, dimmed, the tool it calls; the raw call when it has said nothing
// (the tool is then in the text), and 'thinking' when it has done neither.
export const nowOf = (l: GearboxLoop): { text: string; tool?: string; said: boolean } =>
  l.said ? { text: l.said, said: true, ...(l.doing ? { tool: toolName(l.doing) } : {}) } : { text: l.doing ?? 'thinking', said: false }

// ---- what a loop collects ----

export const NOTES_KEPT = 3
export const FILES_KEPT = 6
export const SKILLS_KEPT = 24

// A note joins the loop's history. `growing`: it is the line a request is still writing (the last note, longer), which
// takes its place; a line like the last one adds nothing.
export const withNote = (l: GearboxLoop, text: string, at: number, growing: boolean): GearboxLoop => {
  const notes = l.notes ?? []
  const last = notes.at(-1)
  if (last?.text === text) return l
  return { ...l, notes: (growing && last ? [...notes.slice(0, -1), { ...last, text }] : [...notes, { at, text }]).slice(-NOTES_KEPT) }
}

// The tool a note was followed by is the latest call made since it.
export const withTool = (l: GearboxLoop, tool: string): GearboxLoop => {
  const last = l.notes?.at(-1)
  return last ? { ...l, notes: [...l.notes!.slice(0, -1), { ...last, tool }] } : l
}

// The tools whose file_path a loop is credited with, and how they touch it. A Write over a file the loop had not
// touched is a new one (Claude Code makes an agent read a file before it may overwrite it).
const TOUCHES: Record<string, 'read' | 'edited' | 'write'> = { Read: 'read', Edit: 'edited', MultiEdit: 'edited', Write: 'write' }
const KIND_RANK: Record<GearboxFile['kind'], number> = { read: 0, edited: 1, new: 2 }

// A file joins the loop's list as `kind`, never as less than the loop had it, and goes last.
const touched = (l: GearboxLoop, path: string, kind: GearboxFile['kind']): GearboxLoop => {
  const files = l.files ?? []
  const was = files.find(f => f.path === path)?.kind
  return { ...l, files: [...files.filter(f => f.path !== path), { path, kind: was && KIND_RANK[was] > KIND_RANK[kind] ? was : kind }].slice(-FILES_KEPT) }
}

export const withFile = (l: GearboxLoop, tool: string, path: unknown): GearboxLoop => {
  const how = TOUCHES[tool]
  if (!how || typeof path !== 'string' || !path) return l
  const kind: GearboxFile['kind'] = how === 'write' ? (l.files?.some(f => f.path === path) ? 'edited' : 'new') : how
  return touched(l, path, kind)
}

// A file an agent of the loop changed (edited, or created), which the loop lists as that agent had it: the review of
// what the agent wrote starts from its parent's list.
export const withChange = (l: GearboxLoop, path: string, kind: 'edited' | 'new'): GearboxLoop => touched(l, path, kind)

// A skill the loop loads joins its list, once, in the order it was first called (a skill called again keeps its place).
// The Skill tool's name may carry a leading slash. A loop that loads more than SKILLS_KEPT keeps the latest.
export const withSkill = (l: GearboxLoop, tool: string, skill: unknown): GearboxLoop => {
  const name = tool === 'Skill' && typeof skill === 'string' ? skill.trim().replace(/^\/+/, '') : ''
  const skills = l.skills ?? []
  return !name || skills.includes(name) ? l : { ...l, skills: [...skills, name].slice(-SKILLS_KEPT) }
}

// A skill the band draws as a tag, ` ✦ name `, one space between tags. They fill lines `room` characters wide, as many
// lines as the list needs, breaking between tags and never inside one (a name wider than a line is cut with …).
export const tagsOf = (skills: readonly string[], room: number): string[][] => {
  const lines: string[][] = []
  let used = 0
  for (const skill of skills) {
    const name = fit(skill, Math.max(1, room - 4))
    const width = name.length + 4
    if (!lines.length || used + 1 + width > room) {
      lines.push([])
      used = width
    } else used += 1 + width
    lines.at(-1)!.push(name)
  }
  return lines
}

// A file as the panel names it: under the worktree or the session's folder, relative to it; else its last two parts.
export const shortPath = (path: string, ...bases: (string | undefined)[]) => {
  for (const b of bases) {
    const base = b?.replace(/\/+$/, '')
    if (base && path.startsWith(`${base}/`)) return path.slice(base.length + 1)
  }
  return path.split('/').slice(-2).join('/')
}

// The git worktree a command makes: `git [-C dir] worktree add [flags] <path> [<commit-ish>]`, its branch from -b / -B,
// else the commit-ish. Undefined when the command makes none.
export const worktreeAdd = (command: string): { path: string; branch?: string } | undefined => {
  const m = /\bgit\b(?:\s+(?:-C|-c)\s+(?:"[^"]*"|'[^']*'|\S+))*\s+worktree\s+add\b([^;&|\n]*)/.exec(command)
  if (!m) return undefined
  const args = [...m[1]!.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(a => a[1] ?? a[2] ?? a[3]!)
  const places: string[] = []
  let branch: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '-b' || a === '-B') branch = args[++i]
    else if (a === '--reason') i++
    else if (!a.startsWith('-')) places.push(a)
  }
  return places[0] ? { path: places[0], ...((branch ?? places[1]) ? { branch: branch ?? places[1]! } : {}) } : undefined
}

// A loop in a worktree: by its branch (else its folder's name), and where it is.
export const withWorktree = (l: GearboxLoop, w: { path?: string; branch?: string }): GearboxLoop => {
  const name = w.branch ?? w.path?.replace(/\/+$/, '').split('/').pop()
  return name ? { ...l, worktree: name, ...(w.path ? { worktreePath: w.path } : {}) } : l
}

export const withUsage = (l: GearboxLoop, u: { in: number; out: number; usd: number }): GearboxLoop => ({
  ...l,
  usage: { in: (l.usage?.in ?? 0) + u.in, out: (l.usage?.out ?? 0) + u.out, usd: (l.usage?.usd ?? 0) + u.usd },
})

// A loop that ends: the moment, how, and the first line of what it handed back.
export const ended = (l: GearboxLoop, at: number, o: { failed?: GearboxLoop['failed']; result?: string } = {}): GearboxLoop => {
  const { doing: _, said: __, ...rest } = l
  return { ...rest, state: 'done', endedAt: at, ...(o.failed ? { failed: o.failed } : {}), ...(o.result ? { result: o.result } : {}) }
}

// A loop that runs again (a lane given a new job): what marked its last end goes.
export const revived = (l: GearboxLoop): GearboxLoop => {
  const { endedAt: _, failed: __, result: ___, ...rest } = l
  return rest
}

// ---- the tree ----

// A loop in the order it nests: `depth` under main (1: started by main), `last` among the siblings drawn, and `trail`
// for each level above it, whether that ancestor has siblings after it (its guide runs on).
export type Node = { id: string; loop: GearboxLoop; depth: number; last: boolean; trail: boolean[] }

// The loops `keep` says to draw, each under the loop that started it (one that is not kept gives its place to its own
// children), in the order they began. A loop whose parent is unknown hangs from main.
export const treeOf = (loops: Record<string, GearboxLoop>, keep: (id: string, l: GearboxLoop) => boolean): Node[] => {
  const kids = new Map<string, string[]>()
  for (const [id, l] of Object.entries(loops)) {
    if (id === 'main') continue
    const p = l.parent && l.parent !== id && loops[l.parent] ? l.parent : 'main'
    kids.set(p, [...(kids.get(p) ?? []), id])
  }
  const out: Node[] = []
  const seen = new Set<string>()
  const shown = (p: string): string[] =>
    (kids.get(p) ?? []).flatMap(id => (seen.has(id) ? [] : keep(id, loops[id]!) ? [id] : (seen.add(id), shown(id))))
  const walk = (p: string, depth: number, trail: boolean[]) => {
    const ids = shown(p)
    ids.forEach((id, i) => {
      if (seen.has(id) || depth > 8) return
      seen.add(id)
      const last = i === ids.length - 1
      out.push({ id, loop: loops[id]!, depth, last, trail })
      walk(id, depth + 1, [...trail, !last])
    })
  }
  walk('main', 1, [])
  return out
}

// A loop still at work: in a turn, or between turns waiting on background work of its own.
export const live = (l?: GearboxLoop) => l?.state === 'working' || l?.state === 'waiting'
