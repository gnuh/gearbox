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
}

declare module 'claude-code' {
  interface PluginState {
    gearbox: { loops: Shaped<Record<string, GearboxLoop>> }
  }
}
