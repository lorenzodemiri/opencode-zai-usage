import { Plugin } from "@opencode/plugin"

// Server-side no-op for the zai-allowance plugin.
// All functionality is terminal-side (tui.ts sidebar + /zai-usage command);
// this entrypoint exists so the package layout matches the documented
// server+TUI entrypoint convention under ~/.config/opencode/plugins/.

export default Plugin.define({
  id: "zai-allowance",
  async setup() {
    // intentionally empty — see tui.ts
  },
})
