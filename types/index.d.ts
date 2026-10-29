// One row per model loop: 'main', or a subagent by its agent id.
export type GearboxLoop = {
  label: string // "main", or the Agent call's description
  parent?: string // the loop that started it
  asked: string // the model the current or last step requested
  answered?: string // the model that answered the last step
  effort?: string
  state: 'working' | 'waiting' | 'idle' | 'done' // waiting: between turns, on background work it started
  doing?: string // the tool it is running
  steps: number
  since?: number // when a subagent started (ms), for the band's run time
}

// The main conversation's last reply, which the agents still at work are drawn under: its text's end, and the
// agents alive when it ended.
export type GearboxReply = { tail?: string; ids?: string[] }

// The reports agents the main conversation started handed back, by agent id: the latest few, and the call that
// started it (for one run in the foreground, whose report shows under that call).
export type GearboxReports = Record<string, { texts: string[]; useId?: string }>

// What the person set through /gearbox; unset keys fall back to the plugin's options, then the defaults. Keys of
// removed settings an older version stored (steer, escalate, band, pane) are ignored, and dropped at session start.
export type GearboxSettings = { code_model?: string; code_effort?: string; navigator?: string; strict?: boolean; log?: string; agent_hooks?: boolean; orchestrator?: boolean; orchestrator_model?: string; orchestrator_effort?: string; orchestrator_agents?: number }

// This turn, from the person's last prompt: requests per model, the session cost when it began, the costs of the
// turns before it, and why its gear (a headline and a detail) for the band.
export type GearboxTurn = { requests: Record<string, number>; costAtStart?: number; costs: number[]; why?: [string, string] }

declare module 'claude-code' {
  interface PluginState {
    gearbox: { loops: Shaped<Record<string, GearboxLoop>>; settings: Shaped<GearboxSettings>; turn: Shaped<GearboxTurn>; reply: Shaped<GearboxReply>; reports: Shaped<GearboxReports> }
  }
}
