import { expect, test } from 'claude-code/testing'
import { NESTING, hookBrief } from './policy'
import { readOutput } from './classic'

type Out = { exitCode?: number; stdout?: string; stderr?: string }
type Source = 'user' | 'project' | 'local' | 'flag' | 'policy'
type World = {
  sources?: Partial<Record<Source, Record<string, unknown>>>
  merged?: Record<string, unknown> // what the merged read adds: enabledPlugins, disableAllHooks
  files?: Record<string, string>
  agents?: { id: string; name?: string; type?: string }[]
  // What a command prints, by the hook's command (or its first argument in exec form), given its stdin; anything else prints nothing.
  says?: Record<string, Out | ((stdin: any) => Out)>
  own?: object // what the person's own SubagentStop hooks say beneath the plugin
  breaks?: 'process' | 'settings'
}
type Call = { argv: readonly string[]; stdin: any; env: Record<string, string>; timeoutMs?: number }

const ONE = (command: string, extra: object = {}) => ({ UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command, ...extra }] }] })
const STOP = (command: string, extra: object = {}) => ({ Stop: [{ hooks: [{ type: 'command', command, ...extra }] }] })

// The engine beneath the mod, faked: the settings sources, the plugin files, the commands the hooks run (each
// recorded with its stdin and environment) and the agent that would start.
const world = (on: any, w: World = {}) => {
  const calls: Call[] = []
  const prompts: string[] = []
  const sent: string[] = []
  on('settings.read', (_: unknown, e: any) => (w.breaks === 'settings' ? { deny: 'unreadable' } : { value: e.source ? (w.sources?.[e.source as Source] ?? {}) : { ...Object.assign({}, ...Object.values(w.sources ?? {})), ...w.merged } }))
  on('process.run', (_: unknown, e: any) => {
    if (w.breaks === 'process') return { deny: 'spawn ENOENT' }
    calls.push({ argv: e.argv, stdin: JSON.parse(e.init?.stdin ?? '{}'), env: e.init?.env ?? {}, timeoutMs: e.init?.timeoutMs })
    const said = w.says?.[e.argv[0] === 'bash' ? e.argv[2] : e.argv[0]] ?? {}
    const out = typeof said === 'function' ? said(JSON.parse(e.init?.stdin ?? '{}')) : said
    return { value: { exitCode: 0, stdout: '', stderr: '', ...out } }
  })
  const kv = new Map<string, unknown>()
  on('store.get', (_: unknown, e: any) => ({ value: kv.get(e.key) }))
  on('store.set', (_: unknown, e: any) => (kv.set(e.key, e.value), { value: undefined }))
  on('classic.UserPromptSubmit', () => ({}))
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }))
  on('prompt.attachment', (_: unknown, e: any) => ({ text: e.text }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 1, context: { tokens: 1000, window: 1_000_000 }, rateLimits: [] } }))
  on('classic.SubagentStop', () => w.own ?? {})
  on('fs.read', (_: unknown, e: any) => (e.path in (w.files ?? {}) ? { value: w.files![e.path] } : { deny: 'ENOENT' }))
  on('env.get', (_: unknown, e: any) => ({ value: e.name === 'HOME' ? '/home/tester' : undefined }))
  on('session.id', () => ({ value: 's-1' }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.root', () => ({ value: '/work/app' }))
  on('agent.list', () => ({ value: (w.agents ?? []).map(a => ({ description: 'd', type: 'general-purpose', status: 'running', ...a })) }))
  // The line every agent of the main conversation gets on reading agents has a test of its own (readout.test.tsx).
  on('agent.spawn', (_: unknown, e: any) => (prompts.push(e.prompt.replace(NESTING, '')), { model: 'inherit', agentId: 'a1' }))
  on('session.send', (_: unknown, e: any) => (sent.push(e.text), { isDelivered: true as const }))
  for (const quiet of ['ui.status', 'ui.log']) on(quiet, () => ({ value: undefined }))
  return { calls, prompts, sent }
}

const spawn = ($: any, extra: object = {}) =>
  $.agent.spawn({ tool_use_id: 't1', prompt: 'fix the billing bug', description: 'd', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false, ...extra })
const stop = ($: any, extra: object = {}) => $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'general-purpose', agent_transcript_path: '/t/a1.jsonl', stop_hook_active: false, last_assistant_message: 'done', ...extra })

test('hookBrief gives the hook text under the gearbox heading, each entry cut at 10,000 characters; nothing for no text', () => {
  expect(hookBrief([])).toBe('')
  expect(hookBrief(['  ', ''])).toBe('')
  const added = hookBrief(['read the vault first', 'then the runbook'])
  expect(added).toContain('Added by gearbox')
  expect(added).toContain('UserPromptSubmit hooks')
  expect(added).toContain('read the vault first\n\nthen the runbook')
  expect(hookBrief(['x'.repeat(10_050)])).toContain(`${'x'.repeat(10_000)}…`)
})

test('a hook\'s exit code and output are read as Claude Code reads them', () => {
  const ok = { exitCode: 0, stderr: '' }
  expect(readOutput('UserPromptSubmit', { ...ok, stdout: 'plain text\n' })).toEqual({ context: ['plain text'] })
  expect(readOutput('Stop', { ...ok, stdout: 'plain text' })).toEqual({ context: [] }) // on Stop, plain output is only a log line
  expect(readOutput('Stop', { ...ok, stdout: '{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"update the notes"}}' })).toEqual({ context: ['update the notes'] })
  expect(readOutput('Stop', { ...ok, stdout: '{"decision":"block","reason":"run the tests"}' })).toEqual({ context: [], block: 'run the tests' })
  expect(readOutput('Stop', { ...ok, stdout: '{"continue":false,"stopReason":"enough"}' })).toEqual({ context: [], stop: 'enough' })
  expect(readOutput('UserPromptSubmit', { exitCode: 2, stdout: 'ignored', stderr: 'no secrets\n' })).toEqual({ context: [], block: 'no secrets' })
  expect(readOutput('UserPromptSubmit', { exitCode: 1, stdout: 'text', stderr: 'oops' })).toEqual({ context: [] }) // any other failure is only an error
  expect(readOutput('UserPromptSubmit', { ...ok, stdout: '{"decision": broken' })).toEqual({ context: [] })
})

test('an agent\'s task goes through the person\'s UserPromptSubmit hooks, on its own prompt, as the main conversation\'s prompt does', async ($: any, on) => {
  const w = world(on, { sources: { user: { hooks: ONE('/h/pre.sh') } }, says: { '/h/pre.sh': { stdout: 'KB pre-flight: read the vault first' } } })
  await $.classic.UserPromptSubmit({ prompt: 'ship the billing fix', permission_mode: 'default', transcript_path: '/t/main.jsonl' })
  await spawn($)
  expect(w.calls).toHaveLength(1)
  expect(w.calls[0]!.argv).toEqual(['bash', '-c', '/h/pre.sh'])
  expect(w.calls[0]!.timeoutMs).toBe(30_000) // Claude Code's default for this event
  expect(w.calls[0]!.env.CLAUDE_PROJECT_DIR).toBe('/work/app')
  expect(w.calls[0]!.stdin).toMatchObject({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the billing bug', transcript_path: '/t/main.jsonl', permission_mode: 'default', agent_type: 'general-purpose' })
  expect(w.prompts[0]).toContain('fix the billing bug')
  expect(w.prompts[0]).toContain('Added by gearbox')
  expect(w.prompts[0]).toContain('KB pre-flight: read the vault first')
})

test('every spawn path gets them: a typed agent, a fork of a skill with a task, a workflow agent; a resumed run keeps its message', async ($: any, on) => {
  const w = world(on, { sources: { user: { hooks: ONE('/h/pre.sh') } }, says: { '/h/pre.sh': { stdout: 'ctx' } } })
  await spawn($, { subagentType: 'Explore' })
  await spawn($, { fork: true })
  await spawn($, { workflow: { runId: 'wf_1', agentIndex: 1 } })
  expect(w.prompts.map(p => p.includes('ctx'))).toEqual([true, true, true])
  await spawn($, { resume: { agentId: 'a1' }, prompt: 'carry on' })
  expect(w.calls).toHaveLength(3)
  expect(w.prompts[3]).toBe('carry on')
})

test('a hook that stops the prompt (exit 2, or a block) stops the task: the spawn is refused with its reason', async ($: any, on) => {
  const w = world(on, { sources: { user: { hooks: ONE('/h/guard.sh') } }, says: { '/h/guard.sh': { exitCode: 2, stderr: 'no customer data in prompts' } } })
  const r = await spawn($)
  expect(r.deny).toContain('no customer data in prompts')
  expect(w.prompts).toHaveLength(0)
})

test('hooks of every settings source add up, one handler in two files runs once, the exec form and timeouts are kept, other hook types are left out', async ($: any, on) => {
  const w = world(on, {
    sources: {
      user: { hooks: ONE('/h/a.sh') },
      project: { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/h/a.sh' }, { type: 'command', command: '${CLAUDE_PROJECT_DIR}/tools/b', args: ['--quick', '${CLAUDE_PROJECT_DIR}'], timeout: 5 }, { type: 'prompt', prompt: 'judge $ARGUMENTS' }, { type: 'http', url: 'http://x' }] }] } },
      local: { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/h/c.sh', async: true }, { type: 'command', command: '/h/never.sh', if: 'Bash(git *)' }] }] } },
    },
    says: { '/h/a.sh': { stdout: 'from a' }, '/work/app/tools/b': { stdout: 'from b' } },
  })
  await spawn($)
  expect(w.calls.map(c => c.argv)).toEqual([['bash', '-c', '/h/a.sh'], ['/work/app/tools/b', '--quick', '/work/app'], ['bash', '-c', '/h/c.sh']])
  expect(w.calls[1]!.timeoutMs).toBe(5_000)
  expect(w.prompts[0]).toContain('from a\n\nfrom b')
})

test('the enabled plugins\' hooks run from their folder with their variables; this plugin, a disabled one and another project\'s are skipped', async ($: any, on) => {
  const inPlugin = (dir: string) => `${dir}/hooks/hooks.json`
  const hooks = (command: string) => JSON.stringify({ hooks: ONE(command) })
  const w = world(on, {
    merged: { enabledPlugins: { 'wherewasi@dir': true, 'off@dir': false, 'gearbox@gearbox': true, 'elsewhere@dir': true } },
    files: {
      '/home/tester/.claude/plugins/installed_plugins.json': JSON.stringify({
        version: 2,
        plugins: {
          'wherewasi@dir': [{ scope: 'user', installPath: '/p/wherewasi' }],
          'off@dir': [{ scope: 'user', installPath: '/p/off' }],
          'gearbox@gearbox': [{ scope: 'user', installPath: '/p/gearbox' }],
          'elsewhere@dir': [{ scope: 'local', projectPath: '/other/project', installPath: '/p/elsewhere' }],
        },
      }),
      [inPlugin('/p/wherewasi')]: hooks('python3 ${CLAUDE_PLUGIN_ROOT}/on-prompt.py'),
      [inPlugin('/p/off')]: hooks('/p/off/run'),
      [inPlugin('/p/gearbox')]: hooks('/p/gearbox/run'),
      [inPlugin('/p/elsewhere')]: hooks('/p/elsewhere/run'),
    },
  })
  await spawn($)
  expect(w.calls).toHaveLength(1)
  expect(w.calls[0]!.argv).toEqual(['bash', '-c', 'python3 ${CLAUDE_PLUGIN_ROOT}/on-prompt.py'])
  expect(w.calls[0]!.env).toMatchObject({ CLAUDE_PLUGIN_ROOT: '/p/wherewasi', CLAUDE_PLUGIN_DATA: '/home/tester/.claude/plugins/data/wherewasi-dir' })
})

test('hooks of the managed settings run with the rest, and alone where they bar the rest', async ($: any, on) => {
  const w = world(on, { sources: { user: { hooks: ONE('/h/user.sh') }, policy: { hooks: ONE('/h/managed.sh') } } })
  await spawn($)
  expect(w.calls.map(c => c.argv[2])).toEqual(['/h/user.sh', '/h/managed.sh'])
})

test('allowManagedHooksOnly leaves the managed settings\' hooks alone', async ($: any, on) => {
  const w = world(on, { sources: { user: { hooks: ONE('/h/user.sh') }, policy: { hooks: ONE('/h/managed.sh'), allowManagedHooksOnly: true } } })
  await spawn($)
  expect(w.calls.map(c => c.argv[2])).toEqual(['/h/managed.sh'])
})

test('with disableAllHooks set, nothing runs and the task goes as it was', async ($: any, on) => {
  const w = world(on, { sources: { user: { hooks: ONE('/h/user.sh') } }, merged: { disableAllHooks: true } })
  await spawn($)
  expect(w.calls).toHaveLength(0)
  expect(w.prompts).toEqual(['fix the billing bug'])
})

test('/gearbox hooks off keeps the person\'s hooks from agents; on brings them back', async ($: any, on) => {
  const w = world(on, { sources: { user: { hooks: { ...ONE('/h/pre.sh'), ...STOP('/h/post.sh') } } }, says: { '/h/pre.sh': { stdout: 'ctx' }, '/h/post.sh': { stdout: '{"decision":"block","reason":"again"}' } } })
  expect((await $.command.run({ command: 'gearbox', args: 'hooks off' })).text).toContain('hooks for agents off')
  await spawn($)
  expect((await stop($)).block).toBeUndefined()
  expect(w.calls).toHaveLength(0)
  expect((await $.command.run({ command: 'gearbox', args: 'hooks on' })).text).toContain('hooks for agents on')
  await spawn($)
  expect(w.calls).toHaveLength(1)
  expect((await $.command.run({ command: 'gearbox', args: 'hooks maybe' })).text).toBe('hooks takes on or off')
})

test('an agent that stops goes through the person\'s Stop hooks: a block or feedback sends it back to work', async ($: any, on) => {
  const w = world(on, { sources: { user: { hooks: STOP('/h/post.sh') } }, says: { '/h/post.sh': { stdout: '{"decision":"block","reason":"update the vault notes first"}' } } })
  const r = await stop($, { transcript_path: '/t/main.jsonl' })
  expect(r.block).toBe('update the vault notes first')
  expect(w.calls[0]!.timeoutMs).toBe(600_000)
  expect(w.calls[0]!.stdin).toMatchObject({ hook_event_name: 'Stop', agent_id: 'a1', agent_type: 'general-purpose', stop_hook_active: false, last_assistant_message: 'done', agent_transcript_path: '/t/a1.jsonl' })
})

test('Stop feedback continues the agent: the next stop tells the hook it is continuing, as for the main conversation, and the hook lets it end', async ($: any, on) => {
  const feedback = '{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"KB post-flight: update the notes"}}'
  const w = world(on, { sources: { user: { hooks: STOP('/h/post.sh') } }, says: { '/h/post.sh': stdin => (stdin.stop_hook_active ? {} : { stdout: feedback }) } })
  expect((await stop($)).additionalContext).toEqual(['KB post-flight: update the notes'])
  expect((await stop($)).additionalContext).toBeUndefined()
  expect(w.calls.map(c => c.stdin.stop_hook_active)).toEqual([false, true])
  // Ended, the agent's next stop (say, after a later message) is a fresh one.
  await stop($)
  expect(w.calls.map(c => c.stdin.stop_hook_active)).toEqual([false, true, false])
})

test('a Stop hook that only prints a line lets the agent stop; the person\'s own SubagentStop result stands beneath it', async ($: any, on) => {
  const w = world(on, { sources: { user: { hooks: STOP('/h/quiet.sh') } }, says: { '/h/quiet.sh': { stdout: 'just a log line' } }, own: { block: 'own hook says continue' } })
  expect((await stop($)).block).toBe('own hook says continue')
  expect(w.calls.map(c => c.argv[2])).toEqual(['/h/quiet.sh']) // the engine runs SubagentStop hooks itself; only Stop is run here
})

test('a Stop hook with continue: false lets the agent end whatever else it said; an agent without a type is not one of the person\'s tasks', async ($: any, on) => {
  const w = world(on, { sources: { user: { hooks: STOP('/h/post.sh') } }, says: { '/h/post.sh': { stdout: '{"continue":false,"stopReason":"done","decision":"block","reason":"x"}' } } })
  expect((await stop($)).block).toBeUndefined()
  await stop($, { agent_type: '' })
  expect(w.calls).toHaveLength(1)
})

test('a message the main conversation sends an agent goes through the UserPromptSubmit hooks; one between agents, or to another session, does not', async ($: any, on) => {
  const w = world(on, { sources: { user: { hooks: ONE('/h/pre.sh') } }, says: { '/h/pre.sh': { stdout: 'KB: runbook for deploys' } }, agents: [{ id: 'agent-1', name: 'lane-sonnet' }] })
  await $.session.send({ to: 'lane-sonnet', text: 'now deploy it' })
  await $.session.send({ to: 'agent-1', text: 'and verify' })
  await $.session.send({ to: 'someone-else', text: 'hello' })
  expect(w.sent[0]).toContain('now deploy it')
  expect(w.sent[0]).toContain('KB: runbook for deploys')
  expect(w.sent[1]).toContain('KB: runbook for deploys')
  expect(w.sent[2]).toBe('hello')
  expect(w.calls.map(c => c.stdin.prompt)).toEqual(['now deploy it', 'and verify'])
})

test('a hook that stops the prompt refuses the message to an agent too', async ($: any, on) => {
  const w = world(on, { sources: { user: { hooks: ONE('/h/guard.sh') } }, says: { '/h/guard.sh': { exitCode: 2, stderr: 'not now' } }, agents: [{ id: 'agent-1' }] })
  const r = await $.session.send({ to: 'agent-1', text: 'deploy' })
  expect(r.isDelivered).toBe(false)
  expect(r.reason).toContain('not now')
  expect(w.sent).toHaveLength(0)
})

// What the engine hands the model of a hook's output on the main prompt: a plain line, or a JSON answer's context.
const mainSaid = ($: any, text: string, type = 'hook_success') =>
  $.prompt.attachment({ type, text: `UserPromptSubmit hook ${type === 'hook_success' ? 'success' : 'additional context'}: ${text}`, origin: { kind: 'hook', event: 'UserPromptSubmit' } })

test('where no hook can be run here, what the main conversation\'s hooks gave its prompt goes to the agent instead, as the model read it', async ($: any, on) => {
  const w = world(on, { sources: { user: { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'prompt', prompt: 'judge $ARGUMENTS' }] }] } } } })
  await $.prompt.submit({ text: 'ship it', asUser: true })
  await mainSaid($, 'project note from a hook gearbox cannot run')
  await mainSaid($, 'a JSON answer\'s context', 'hook_additional_context')
  await mainSaid($, 'project note from a hook gearbox cannot run') // the same text on the next request counts once
  await $.prompt.attachment({ type: 'hook_success', text: 'UserPromptSubmit hook success: from an agent\'s own loop', origin: { kind: 'hook', event: 'UserPromptSubmit' }, agentId: 'a9' })
  await $.prompt.attachment({ type: 'hook_success', text: 'PostToolUse hook success: not for a task', origin: { kind: 'hook', event: 'PostToolUse' } })
  await spawn($)
  expect(w.calls).toHaveLength(0)
  expect(w.prompts[0]).toContain('project note from a hook gearbox cannot run\n\na JSON answer\'s context')
  expect(w.prompts[0]).not.toContain('UserPromptSubmit hook success')
  expect(w.prompts[0]).not.toContain('own loop')
  expect(w.prompts[0]).not.toContain('not for a task')
  // The next prompt the person types starts afresh.
  await $.prompt.submit({ text: 'and now this', asUser: true })
  await spawn($)
  expect(w.prompts[1]).toBe('fix the billing bug')
})

test('with a command hook to run, its answer on the agent\'s prompt is what counts, not the main prompt\'s', async ($: any, on) => {
  const w = world(on, { sources: { user: { hooks: ONE('/h/pre.sh') } }, says: { '/h/pre.sh': { stdout: 'fresh answer' } } })
  await $.prompt.submit({ text: 'ship it', asUser: true })
  await mainSaid($, 'main answer')
  await spawn($)
  expect(w.prompts[0]).toContain('fresh answer')
  expect(w.prompts[0]).not.toContain('main answer')
})

test('a hook that cannot start leaves the task as it was', async ($: any, on) => {
  const w = world(on, { sources: { user: { hooks: ONE('/h/missing.sh') } }, breaks: 'process' })
  expect((await spawn($)).agentId).toBe('a1')
  expect(w.prompts).toEqual(['fix the billing bug'])
})

test('a settings read that fails leaves the task as it was, and an agent free to stop', async ($: any, on) => {
  const w = world(on, { breaks: 'settings' })
  expect((await spawn($)).agentId).toBe('a1')
  expect(w.prompts).toEqual(['fix the billing bug'])
  expect((await stop($)).block).toBeUndefined()
})

test('with the log on, the hooks run for an agent are recorded without their text', async ($: any, on) => {
  world(on, { sources: { user: { hooks: { ...ONE('/h/pre.sh'), ...STOP('/h/post.sh') } } }, says: { '/h/pre.sh': { stdout: 'secret project note' }, '/h/post.sh': { stdout: '{"decision":"block","reason":"again"}' } } })
  on('turn.complete', (_: unknown, e: any) => ({ text: e.answer }))
  const files = new Map<string, string>()
  on('fs.write', (_: unknown, e: any) => (files.set(e.path, e.text), { value: undefined }))
  on('fs.exists', (_: unknown, e: any) => ({ value: files.has(e.path) }))
  on('session.version', () => ({ value: { version: '2.1.312', base: '2.1.312' } }))
  await $.command.run({ command: 'gearbox', args: 'log on' })
  await spawn($)
  await stop($)
  await $.turn.complete({ turnId: 'x', answer: '', durationMs: 1, isAborted: false })
  const log = (files.get('/home/tester/.claude/gearbox/logs/s-1.jsonl') ?? '').trim().split('\n').map(l => JSON.parse(l))
  expect(log.filter(l => l.ev === 'hooks').map(l => `${l.event} ${l.agent}${l.again ? ' again' : ''}`)).toEqual(['UserPromptSubmit general-purpose', 'Stop a1 again'])
  expect(JSON.stringify(log)).not.toContain('secret project note')
})

test('with the plugin option agent_hooks off, the person\'s hooks stay with the main conversation', { options: { agent_hooks: false } }, async ($: any, on) => {
  const w = world(on, { sources: { user: { hooks: { ...ONE('/h/pre.sh'), ...STOP('/h/post.sh') } } }, says: { '/h/pre.sh': { stdout: 'ctx' }, '/h/post.sh': { stdout: '{"decision":"block","reason":"again"}' } } })
  await spawn($)
  expect((await stop($)).block).toBeUndefined()
  expect(w.calls).toHaveLength(0)
  expect(w.prompts).toEqual(['fix the billing bug'])
})
