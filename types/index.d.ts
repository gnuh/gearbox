// One row per model loop: 'main', or a subagent by its agent id.
export type GearboxLoop = {
  label: string // "main", or the Agent call's description
  parent?: string // the loop that started it
  asked: string // the model the current or last step requested
  answered?: string // the model that answered the last step
  effort?: string
  state: 'working' | 'idle' | 'done'
  doing?: string // the tool it is running
  steps: number
  since?: number // when a subagent started (ms), for the band's run time
}

// What the person set through /gearbox; unset keys fall back to the plugin's options, then the defaults.
export type GearboxSettings = { code_effort?: string; navigator?: string; steer?: boolean; strict?: boolean; log?: string; pane?: string; band?: boolean; orchestrator?: boolean; orchestrator_model?: string; orchestrator_effort?: string; orchestrator_agents?: number }

// This turn, from the person's last prompt: requests per model, the session cost when it began, the costs of the
// turns before it, and why its gear (a headline and a detail) for the band.
export type GearboxTurn = { requests: Record<string, number>; costAtStart?: number; costs: number[]; why?: [string, string] }

declare module 'claude-code' {
  interface PluginState {
    gearbox: { loops: Shaped<Record<string, GearboxLoop>>; settings: Shaped<GearboxSettings>; turn: Shaped<GearboxTurn> }
  }
}
