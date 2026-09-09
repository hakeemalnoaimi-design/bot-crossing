/**
 * `.env`, read once, for the harnesses that talk to something over a network.
 *
 * Bot Crossing's own harnesses read files on this machine and need no configuration at all.
 * A hosted one — n8n, and whatever comes after it — needs a URL and a key, and those are
 * secrets: they belong in a file that is not in the repository and never in anything the
 * browser downloads.
 *
 * Deliberately tiny, and deliberately not a dependency. What is supported is what a `.env`
 * actually contains: `KEY=value`, `#` comments, blank lines, optional `export`, and quotes
 * around a value that has spaces in it. Anything cleverer — variable interpolation, multi-line
 * values — is not, because a config file that needs its own language is a config file that
 * will one day be wrong in a way nobody can see.
 *
 * A real environment variable always wins. That is what lets a service unit, a container or a
 * one-off `N8N_BASE_URL=… npm run dev` override the file without editing it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
/** Read when the file is actually parsed, not at import, so a test can move it and reload. */
const envFile = () => process.env.BOT_CROSSING_ENV || path.join(here, '..', '..', '.env')

/** Strip one matching pair of surrounding quotes, and nothing else. */
function unquote(value) {
  const quoted = /^(['"])([\s\S]*)\1$/.exec(value)
  return quoted ? quoted[2] : value
}

function parse(text) {
  const out = new Map()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    // An unquoted trailing comment is a comment; one inside quotes is part of the value.
    const value = unquote(line.slice(eq + 1).trim()).replace(/\s+#.*$/, '')
    out.set(key, value)
  }
  return out
}

let cache = null

/**
 * Every name in `.env`, parsed once. A missing file is the normal case on a machine that only
 * uses the local harnesses, so it is not an error and not worth a warning.
 */
function file() {
  if (cache) return cache
  cache = new Map()
  try {
    cache = parse(fs.readFileSync(envFile(), 'utf8'))
  } catch {
    /* no .env — the local harnesses need none */
  }
  return cache
}

/** One setting: the real environment first, then `.env`, then the fallback. */
export function env(name, fallback = '') {
  const live = process.env[name]
  if (live !== undefined && live !== '') return live
  return file().get(name) ?? fallback
}

/** A setting that has to be a number, with a floor — a poll of 0 seconds is a busy loop. */
export function envNumber(name, fallback, min = 0) {
  const n = Number(env(name, ''))
  return Number.isFinite(n) && n >= min ? n : fallback
}

/** Forget the parsed file, so a test can point `BOT_CROSSING_ENV` somewhere else. */
export function reloadEnv() {
  cache = null
}
