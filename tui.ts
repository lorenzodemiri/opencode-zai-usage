import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createSignal } from "solid-js"

// z.ai coding plan allowance — TUI sidebar section + /zai-usage command.
//
// Architecture (matches the SlotClaim contract in @opencode/plugin/dist/tui):
// - ONE ctx.ui.slot claim, registered once after the first fetch. Claims at
//   the same anchor coexist, so re-registering stacks sections — never do it.
// - `render` runs reactively in the host's Solid context: it reads the
//   snapshot signal directly, so setSnapshot() re-renders the section in
//   place. No dispose/re-register cycle, no stacking, live updates.
// - The legacy tui(api) path is kept for hosts that still call it (guarded
//   so only one section exists per process via globalThis).
//
// Data: GET https://api.z.ai/api/monitor/usage/quota/limit (Bearer key from
// auth.json). Native fetch in the TUI process has a history of "Unable to
// connect" on this machine, so fetchQuota falls back to curl (key passed via
// stdin config, never on argv).

const run = promisify(execFile)

type Limit = {
  type?: string
  unit?: number
  number?: number
  percentage?: number
  nextResetTime?: number
}

type Snapshot = {
  plan: string
  fiveHour?: Limit
  weekly?: Limit
  fetchedAt: number
}

const POLL_MS = Number(process.env.ZAI_ALLOWANCE_POLL_MS ?? 300_000)
const TICK_MS = 60_000
const FETCH_TIMEOUT_MS = 10_000
const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit"
const DEBUG_LOG = path.join(os.homedir(), ".local", "share", "opencode", "zai-allowance.log")

const FALLBACK_THEME = {
  primary: "magenta",
  text: "white",
  textMuted: "brightBlack",
  error: "red",
  warning: "yellow",
  success: "green",
}

function debug(line: string) {
  fs.appendFile(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`).catch(() => {})
}

// ---- shared reactive state ----

const [getSnapshot, setSnapshot] = createSignal<Snapshot | undefined>(undefined)

let cycleStarted = false

export function classifyLimits(limits: Limit[]): Pick<Snapshot, "fiveHour" | "weekly"> {
  const tokens = limits.filter((l) => l?.type === "TOKENS_LIMIT")
  let fiveHour = tokens.find((l) => l.unit === 3 && l.number === 5)
  let weekly = tokens.find((l) => l.unit === 6 && l.number === 1)
  if (!fiveHour || !weekly) {
    const sorted = [...tokens]
      .filter((l) => typeof l.nextResetTime === "number")
      .sort((a, b) => (a.nextResetTime ?? 0) - (b.nextResetTime ?? 0))
    fiveHour = fiveHour ?? sorted[0]
    weekly = weekly ?? sorted[sorted.length - 1]
  }
  return { fiveHour, weekly }
}

export function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000))
  if (totalMin < 60) return `${totalMin}m`
  const h = Math.floor(totalMin / 60)
  const min = totalMin % 60
  if (h < 24) return `${h}h${min}m`
  const d = Math.floor(h / 24)
  return `${d}d${h % 24}h`
}

export function bar(pct: number, width = 6): string {
  const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)))
  return "▓".repeat(filled) + "░".repeat(width - filled)
}

function authPaths(api: { state?: { path?: { state?: string } } }): string[] {
  const stateDir = api?.state?.path?.state
  const home = path.join(os.homedir(), ".local", "share", "opencode", "auth.json")
  return stateDir ? [path.join(stateDir, "auth.json"), home] : [home]
}

async function readKey(api: Record<string, unknown>): Promise<string | undefined> {
  for (const p of authPaths(api as never)) {
    try {
      const auth = JSON.parse(await fs.readFile(p, "utf8"))
      for (const id of ["zai-coding-plan", "zai"]) {
        const key = auth?.[id]?.key
        if (typeof key === "string" && key) return key
      }
    } catch {
      // try next path
    }
  }
  return undefined
}

async function fetchViaCurl(key: string): Promise<string> {
  // --config - keeps the Authorization header off the process argv.
  const { stdout } = await run(
    "curl",
    ["-sS", "-m", String(FETCH_TIMEOUT_MS), "--config", "-", QUOTA_URL],
    { input: `header = "Authorization: Bearer ${key}"\n` },
  )
  return stdout
}

async function fetchQuota(api: Record<string, unknown>): Promise<Snapshot> {
  const key = await readKey(api)
  if (!key) throw new Error("z.ai api key not found in auth.json")

  let text = ""
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(QUOTA_URL, {
        headers: { authorization: `Bearer ${key}` },
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      text = await res.text()
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    debug(
      `native fetch failed (${err instanceof Error ? err.message : String(err)}) — using curl fallback`,
    )
    text = await fetchViaCurl(key)
  }

  const json = JSON.parse(text)
  if (!json?.data) throw new Error("unexpected response shape")
  const { fiveHour, weekly } = classifyLimits(json?.data?.limits ?? [])
  return {
    plan: typeof json?.data?.level === "string" ? json.data.level : "",
    fiveHour,
    weekly,
    fetchedAt: Date.now(),
  }
}

function summaryText(s: Snapshot | undefined): string {
  if (!s || (!s.fiveHour && !s.weekly)) return "z.ai allowance unavailable"
  const parts: string[] = []
  if (s.fiveHour) {
    const reset = s.fiveHour.nextResetTime
      ? `, resets in ${formatDuration(s.fiveHour.nextResetTime - Date.now())}`
      : ""
    parts.push(`5h ${s.fiveHour.percentage ?? 0}% used${reset}`)
  }
  if (s.weekly) {
    const reset = s.weekly.nextResetTime
      ? `, resets in ${formatDuration(s.weekly.nextResetTime - Date.now())}`
      : ""
    parts.push(`week ${s.weekly.percentage ?? 0}% used${reset}`)
  }
  return parts.join(" · ")
}

type Solid = { createElement: any; insert: any }

function buildSection(solid: Solid, snapshot: Snapshot | undefined, theme: any) {
  const { createElement, insert } = solid
  function element(tag: string, props: Record<string, unknown>, children: unknown[]) {
    const node = createElement(tag, props ?? {})
    for (const child of children ?? []) {
      if (child === null || child === undefined || child === false) continue
      insert(node, child)
    }
    return node
  }
  const text = (props: Record<string, unknown>, children: unknown[]) =>
    element("text", props, children)
  const box = (props: Record<string, unknown>, children: unknown[] = []) =>
    element("box", props, children)

  function limitRow(label: string, limit: Limit | undefined) {
    if (!limit) return null
    const pct = Math.min(100, Math.max(0, Number(limit.percentage ?? 0)))
    const fg = pct >= 95 ? theme.error : pct >= 80 ? theme.warning : theme.primary
    const countdown = limit.nextResetTime
      ? ` · ${formatDuration(limit.nextResetTime - Date.now())}`
      : ""
    return box({ width: "100%", flexDirection: "row" }, [
      text({ fg: theme.textMuted, width: 6 }, [label]),
      text({ fg }, [bar(pct)]),
      text({ fg: theme.textMuted }, [`${pct}%${countdown}`]),
    ])
  }
  const title = box(
    { width: "100%", flexDirection: "row", justifyContent: "space-between" },
    [
      text({ fg: theme.primary }, ["z.ai"]),
      snapshot?.plan ? text({ fg: theme.textMuted }, [snapshot.plan]) : null,
    ],
  )
  const rows: unknown[] = [title]
  if (snapshot?.fiveHour || snapshot?.weekly) {
    rows.push(limitRow("5h", snapshot?.fiveHour))
    rows.push(limitRow("week", snapshot?.weekly))
  } else {
    rows.push(text({ fg: theme.textMuted }, [snapshot ? "allowance unavailable" : "loading…"]))
  }
  return box({ width: "100%", flexDirection: "column", marginBottom: 1 }, rows)
}

function ensureCycle(requestRender: () => void, authCtx: Record<string, unknown>): Promise<void> {
  if (cycleStarted) return Promise.resolve()
  cycleStarted = true
  const refresh = async () => {
    try {
      const snapshot = await fetchQuota(authCtx)
      setSnapshot(snapshot) // reactive: re-renders the section in place
      debug(
        `fetch OK: 5h=${snapshot.fiveHour?.percentage ?? "?"}% weekly=${snapshot.weekly?.percentage ?? "?"}%`,
      )
    } catch (err) {
      debug(`fetch failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      requestRender()
    }
  }
  const first = refresh()
  setInterval(refresh, POLL_MS)
  // Countdown ticks: requestRender lets the host re-run the reactive render.
  setInterval(requestRender, TICK_MS)
  return first
}

// ---- legacy path: tui(api) — kept for hosts that still call it ----

const tui = async (api: any) => {
  debug("tui(api) invoked")
  const g = globalThis as { __zaiAllowanceRegistered?: boolean }
  if (g.__zaiAllowanceRegistered) {
    debug("legacy tui() skipped — section already registered")
    return
  }
  const solid = (await import("@opentui/solid").catch((e) => {
    debug(`@opentui/solid import failed: ${e instanceof Error ? e.message : String(e)}`)
    return null
  })) as Solid | null
  if (!solid) {
    console.warn("[zai-allowance] @opentui/solid unavailable — plugin disabled")
    return
  }
  g.__zaiAllowanceRegistered = true

  api.slots?.register?.({
    order: 1000,
    slots: {
      sidebar_content() {
        try {
          return buildSection(solid, getSnapshot(), api.theme?.current ?? FALLBACK_THEME)
        } catch (err) {
          debug(`legacy render error: ${err instanceof Error ? err.message : String(err)}`)
          return null
        }
      },
    },
  })
  debug("legacy sidebar_content slot registered (order 1000)")

  if (api.command?.register) {
    api.command.register(() => [
      {
        title: "z.ai allowance",
        value: "zai-usage",
        slash: { name: "zai-usage" },
        onSelect: () => {
          fetchQuota(api)
            .then((s) => {
              setSnapshot(s)
              api.renderer?.requestRender?.()
            })
            .catch(() => {})
          api.ui?.toast?.({
            variant: "info",
            title: "z.ai allowance",
            message: summaryText(getSnapshot()),
          })
        },
      },
    ])
  }

  await ensureCycle(() => api.renderer?.requestRender?.(), api)
}

// ---- V2 path: setup(ctx) with one reactive ctx.ui.slot claim ----

let renderCalls = 0

async function setup(ctx: any) {
  debug(`setup(ctx) invoked ctxKeys=${Object.keys(ctx ?? {}).join(",")}`)
  const g = globalThis as { __zaiAllowanceRegistered?: boolean }
  if (g.__zaiAllowanceRegistered) {
    debug("setup skipped — section already registered (earlier generation or legacy path)")
    return
  }

  const slot = ctx?.ui?.slot
  if (typeof slot !== "function") {
    debug("ctx.ui.slot unavailable on this build")
    return
  }
  const solid = (await import("@opentui/solid").catch((e) => {
    debug(`@opentui/solid import failed: ${e instanceof Error ? e.message : String(e)}`)
    return null
  })) as Solid | null
  if (!solid) return

  g.__zaiAllowanceRegistered = true

  // Fetch first so the first render already has data (2.5s backstop).
  const first = ensureCycle(() => ctx.renderer?.requestRender?.(), ctx)
  await Promise.race([
    first.catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 2500)),
  ])

  // ONE claim for the lifetime of the process. render reads the snapshot
  // signal inside the host's reactive context: setSnapshot() re-renders this
  // section in place. Do NOT register again — claims coexist and stack.
  const dispose = slot({
    append: "sidebar.content",
    render: (_input: unknown) => {
      renderCalls++
      if (renderCalls <= 5 || renderCalls % 100 === 0) {
        debug(`v2 render call #${renderCalls} snapshot=${getSnapshot() ? "yes" : "no"}`)
      }
      try {
        return buildSection(solid, getSnapshot(), ctx.theme?.current ?? FALLBACK_THEME)
      } catch (err) {
        debug(`v2 render error: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    },
  })
  debug("v2 ctx.ui.slot claim registered (append=sidebar.content, single)")

  return typeof dispose === "function" ? dispose : undefined
}

export default { id: "zai-allowance", tui, setup }
