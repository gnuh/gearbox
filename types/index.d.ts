// One thing a loop said before calling a tool: when, the first line of it, and the tool it then called.
export type GearboxNote = { at: number; text: string; tool?: string }

// A file a loop touched: read, edited, or created (written where it had not read one).
export type GearboxFile = { path: string; kind: 'read' | 'edited' | 'new' }

// A request that started agents: one typed prompt, or one message typed mid-turn, with the short title the survey gave it
// (a few words, in English) and when it was typed (ms). The readouts draw the agents of one demand together, in a box.
export type GearboxDemand = { id: string; title: string; at: number }

// One row per model loop: 'main', or a subagent by its agent id.
export type GearboxLoop = {
  label: string // "main", or the Agent call's description
  parent?: string // the loop that started it
  demand?: GearboxDemand // the request it works for: the one in force when it started (or went on, for a lane given new work); an agent an agent started has its parent's
  asked: string // the model the current or last step requested
  answered?: string // the model that answered the last step
  effort?: string
  effortBy?: 'main' | 'rules' | 'auto' // who set the effort: the main conversation's call, gearbox's rules, or the orchestrator's effort per prompt
  state: 'working' | 'waiting' | 'idle' | 'done' // waiting: between turns, on background work it started
  doing?: string // the last tool it called, kept beside the notes after it until a new call replaces it
  said?: string // the first line of the latest text it wrote, before calling a tool
  notes?: GearboxNote[] // the last few things it said, oldest first
  files?: GearboxFile[] // the files it touched, the latest last
  skills?: string[] // the skills an agent loaded, each once, in the order it first called them (never main's own)
  worktree?: string // the branch (else the folder's name) of the git worktree it works in; "worktree" when only the isolation is known
  worktreePath?: string // where that worktree is
  usage?: { in: number; out: number; usd: number } // tokens and list-price dollars its requests used (main: this turn)
  result?: string // the first line of the report it handed back, or why it was refused
  failed?: 'failed' | 'refused' | 'stopped' // how it ended, when not well
  stopping?: 'task' | 'soft' // the person pressed Stop and it has not ended yet: through the engine's TaskStop, or gearbox's own (it is refused its tool calls, and its next request ends the turn)
  steps: number // requests sent (main: this turn)
  since?: number // when a subagent started (ms), or the turn the main conversation is in, for the band's run time
  endedAt?: number // when it finished (ms)
}

// The reports agents the main conversation started handed back, by agent id: the latest few, and the call that
// started it (for one run in the foreground, whose report shows under that call).
export type GearboxReports = Record<string, { texts: string[]; useId?: string }>

// What the person set through /gearbox; unset keys fall back to the plugin's options, then the defaults. Keys of
// removed settings an older version stored (steer, escalate, band, pane, strict, agent_hooks, orchestrator_model) are ignored, and dropped at session start.
export type GearboxSettings = { code_model?: string; code_effort?: string; navigator?: string; log?: string; pulse?: string; orchestrator?: boolean | string; orchestrator_effort?: string; orchestrator_agents?: number }

// This turn, from the person's last prompt: requests per model, the session cost when it began, the costs of the
// turns before it, why its gear (a headline and a detail) for the band, and when it began (the agents finished
// before that are no longer drawn).
export type GearboxTurn = { requests: Record<string, number>; costAtStart?: number; costs: number[]; why?: [string, string]; at?: number }

declare module 'claude-code' {
  interface PluginState {
    gearbox: { loops: Shaped<Record<string, GearboxLoop>>; settings: Shaped<GearboxSettings>; turn: Shaped<GearboxTurn>; reports: Shaped<GearboxReports> }
  }
}
