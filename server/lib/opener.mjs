/**
 * One way to hand something to the desktop: a `harness://…` deep link, or a folder.
 *
 * This is the only place in the project that knows what "open this" means on each OS. No harness
 * knowledge reaches it — an adapter says *what* it wants opened and this decides *how*, which is
 * the seam that keeps `server/harnesses/` swappable. `server/api.mjs` is the only caller.
 *
 * The opener always gets an argument list, never a shell string. Targets arrive from a page,
 * which got them from a scan that may be minutes stale, so nothing here may depend on the target
 * being well-behaved.
 *
 * ## What each platform uses
 *
 * macOS's `open(1)` and Linux's `xdg-open` both do the two jobs at once: a registered scheme goes
 * to its app, a directory goes to the file manager.
 *
 * Windows's equivalent is ShellExecute, reached here through `rundll32 url.dll,FileProtocolHandler`
 * — a registered protocol URL goes to its app and a folder opens in Explorer, with the argument
 * passed through untouched. `cmd /c start "" <target>` is the better-known idiom and is kept as
 * the fallback, but it cannot be the first choice, because `cmd` parses the argument line before
 * `start` ever sees it. Measured on Windows 11 against the targets this project actually produces:
 *
 *   | target                              | through `cmd /c` |
 *   | ----------------------------------- | ---------------- |
 *   | `claude://code/new?folder=C%3A%5C…`  | survives         |
 *   | `C:\Users\me\%USERPROFILE% backup`   | expands to `C:\Users\me\C:\Users\me backup` |
 *   | `C:\Users\me\report^v2`              | becomes `C:\Users\me\reportv2` |
 *
 * Both of those are legal Windows folder names, and neither `^%`, `%^` nor `%%` escaping recovers
 * them — command-line percent expansion happens before caret removal, so there is no spelling of
 * the target that survives. A wrong folder opening silently is worse than no folder opening, so
 * `start` is only reached when `rundll32` cannot be spawned at all, which is the case it is there
 * for: a machine whose policy blocks `rundll32`.
 *
 * `explorer.exe <target>` was the third candidate and is not used: it silently drops any URL
 * carrying a query string, so `code/new?folder=…` never arrives.
 */
import { spawn } from 'node:child_process'

/**
 * Per platform, the openers to try in order. Each is an argv prefix; the target is appended.
 * A platform absent from this table has no opener and `openTarget` does nothing there.
 */
const OPENERS = {
  darwin: [['open']],
  win32: [
    ['rundll32', 'url.dll,FileProtocolHandler'],
    ['cmd', '/c', 'start', ''],
  ],
  linux: [['xdg-open']],
}

/**
 * Spawn one opener. Resolves `false` only when the command could not be started at all — the
 * binary is missing, or policy refused it — which is the one failure worth trying another opener
 * over. Anything after the process starts is the OS's business and is not reported: an opener
 * that launched and then found nothing to do exits quietly on every platform, and there is
 * nothing the page could do with the difference.
 *
 * The `error` listener is not optional. An unhandled `error` event on a child process is an
 * unhandled exception, which would take the whole server down over a missing `xdg-open`.
 */
function trySpawn(argv, target, spawn) {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv
    let child
    try {
      child = spawn(cmd, [...args, target], { stdio: 'ignore', detached: true, windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    // Resolved from the error handler, so a spawn that succeeds is never waited on.
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    child.on('error', () => done(false))
    child.on('spawn', () => {
      child.unref()
      done(true)
    })
  })
}

/**
 * Open `target` with whatever this OS uses for the job. Fire-and-forget: the page is told the
 * request was made, not that a window appeared, because no opener on any platform reports that.
 *
 * The scan path must never depend on whether presentation worked, so this never throws.
 */
export async function openTarget(target, { spawn: spawnFn = spawnImpl, platform = process.platform } = {}) {
  if (typeof target !== 'string' || !target) return
  for (const argv of OPENERS[platform] || []) {
    if (await trySpawn(argv, target, spawnFn)) return
  }
}

/** Test seam: swap the process-spawner used when `openTarget` is not given one. Returns the old one. */
let spawnImpl = spawn
export function setSpawnForTests(fn) {
  const old = spawnImpl
  spawnImpl = fn || spawn
  return old
}
