import type { EngineInterface } from 'claude-code'

// Claude Code fires the person's UserPromptSubmit and Stop hooks for the main conversation only. These run them for
// a subagent as the main conversation gets them: the same stdin, exit codes, output and timeouts, from every settings
// source (user, project, local, --settings, managed) and the enabled plugins, never this plugin's own. Neither event
// takes a matcher, so none is read; a hook with an `if` never runs on them either. Hooks of another type than
// `command` (prompt, agent, http, mcp_tool) are not run here.

export type HookEvent = 'UserPromptSubmit' | 'Stop'
type Handler = { type?: string; command?: string; args?: string[]; timeout?: number; async?: boolean; shell?: string; if?: string }
type Install = { projectPath?: string; installPath?: string }
// A `hooks` table with where it came from: a plugin's folder and data folder, for the variables its commands read.
type Layer = { hooks: unknown; root?: string; data?: string }
type Hook = { command: string; args?: string[]; timeoutMs: number; async: boolean; root?: string; data?: string }
type Ran = { exitCode: number; stdout: string; stderr: string }
// What the hooks of an event said, folded: text for the model, a block with its reason, a stop with its reason.
export type Said = { context: string[]; block?: string; stop?: string }

const SOURCES = ['user', 'project', 'local', 'flag', 'policy'] as const
// Seconds, as Claude Code defaults them for a command hook; a hook's own `timeout` replaces them, to ten minutes.
const TIMEOUT: Record<HookEvent, number> = { UserPromptSubmit: 30, Stop: 600 }

async function readJson($: EngineInterface, path: string): Promise<any> {
  try {
    return JSON.parse(String(await $.fs.read(path)))
  } catch {}
}

// The hooks of the enabled plugins (their hooks/hooks.json), each with its folder; this plugin's own is left out.
async function pluginLayers($: EngineInterface, enabled: unknown): Promise<Layer[]> {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? '.'}/.claude`
  const installed: Record<string, Install[]> = (await readJson($, `${config}/plugins/installed_plugins.json`))?.plugins ?? {}
  const project = await $.session.root()
  const layers: Layer[] = []
  for (const [id, on] of Object.entries(enabled && typeof enabled === 'object' ? enabled : {})) {
    // A project or local install counts in its own project only.
    const at = (installed[id] ?? []).filter(i => !i.projectPath || project.startsWith(i.projectPath)).at(-1)?.installPath
    if (on !== true || !at || at === $.plugin.root || id.split('@')[0] === $.plugin.name) continue
    layers.push({ hooks: (await readJson($, `${at}/hooks/hooks.json`))?.hooks, root: at, data: `${config}/plugins/data/${id.replace('@', '-')}` })
  }
  return layers
}

// Every `hooks` table in force, as Claude Code merges them: the settings sources add to one another and the
// managed ones can bar the rest; `disableAllHooks` turns them all off.
async function layersOf($: EngineInterface): Promise<Layer[]> {
  const merged = await $.settings.read()
  if (merged.disableAllHooks === true) return []
  const sources = await Promise.all(SOURCES.map(source => $.settings.read({ source })))
  const policy = sources[SOURCES.indexOf('policy')]!
  if (policy.allowManagedHooksOnly === true) return [{ hooks: policy.hooks }]
  return [...sources.map(s => ({ hooks: s.hooks })), ...(await pluginLayers($, merged.enabledPlugins))]
}

// The command hooks of an event. One handler in several settings files runs once; a plugin's copy stays its own.
export async function findHooks($: EngineInterface, event: HookEvent): Promise<Hook[]> {
  const found = new Map<string, Hook>()
  for (const layer of await layersOf($)) {
    const groups = (layer.hooks as Record<string, unknown> | undefined)?.[event]
    for (const h of (Array.isArray(groups) ? groups.flatMap(g => (Array.isArray(g?.hooks) ? g.hooks : [])) : []) as Handler[]) {
      if ((h.type && h.type !== 'command') || typeof h.command !== 'string' || h.shell === 'powershell' || h.if !== undefined) continue
      const args = Array.isArray(h.args) ? h.args.map(String) : undefined
      found.set(`${layer.root}\0${h.command}\0${args}`, { command: h.command, args, timeoutMs: Math.min(600, h.timeout ?? TIMEOUT[event]) * 1000, async: h.async === true, root: layer.root, data: layer.data })
    }
  }
  return [...found.values()]
}

// What one hook's exit code and output say: exit 2 blocks with its stderr; any other failure is only an error;
// a JSON object carries `decision: "block"` with a `reason`, `continue: false` with a `stopReason` and
// `hookSpecificOutput.additionalContext`; anything else printed counts as text only on UserPromptSubmit.
export const readOutput = (event: HookEvent, r: Ran): Said => {
  if (r.exitCode === 2) return { context: [], block: r.stderr.trim() || 'a hook blocked it' }
  const text = r.stdout.trim()
  if (r.exitCode !== 0) return { context: [] }
  if (!text.startsWith('{')) return { context: event === 'UserPromptSubmit' && text ? [text] : [] }
  let o: any
  try {
    o = JSON.parse(text)
  } catch {
    return { context: [] }
  }
  const extra = o?.hookSpecificOutput?.additionalContext
  return {
    context: typeof extra === 'string' && extra ? [extra] : [],
    ...(o?.decision === 'block' ? { block: String(o.reason || 'a hook blocked it') } : {}),
    ...(o?.continue === false ? { stop: String(o.stopReason || 'a hook stopped it') } : {}),
  }
}

// Runs one hook as Claude Code does: its command in a shell, or the command and `args` as they are, with the input
// as JSON on stdin and the variables hooks read. A hook that cannot start or outruns its timeout says nothing.
async function exec($: EngineInterface, h: Hook, event: HookEvent, input: object): Promise<Said> {
  const env: Record<string, string> = { CLAUDE_PROJECT_DIR: await $.session.root(), ...(h.root ? { CLAUDE_PLUGIN_ROOT: h.root, CLAUDE_PLUGIN_DATA: h.data ?? '' } : {}) }
  const fill = (s: string) => s.replace(/\$\{(CLAUDE_\w+)\}/g, (m, k: string) => env[k] ?? m)
  const run = $.process.run(h.args ? [fill(h.command), ...h.args.map(fill)] : ['bash', '-c', h.command], { env, stdin: JSON.stringify(input), timeoutMs: h.timeoutMs })
  if (h.async) {
    run.catch(() => {})
    return { context: [] }
  }
  try {
    return readOutput(event, await run)
  } catch {
    return { context: [] }
  }
}

// Runs the person's hooks of an event, all at once as Claude Code does, and folds what they said. `fallback`: the
// context the main conversation's hooks gave its prompt, which stands in when none of them could be run here.
export async function runHooks($: EngineInterface, event: HookEvent, input: object, fallback: readonly string[] = []): Promise<Said> {
  const hooks = await findHooks($, event)
  const all = await Promise.all(hooks.map(h => exec($, h, event, { ...input, hook_event_name: event })))
  const blocks = all.flatMap(s => (s.block ? [s.block] : []))
  const stop = all.find(s => s.stop)?.stop
  return { context: hooks.length ? all.flatMap(s => s.context) : [...fallback], ...(blocks.length ? { block: blocks.join('\n') } : {}), ...(stop ? { stop } : {}) }
}
