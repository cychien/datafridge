import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { D1_DATABASE_NAME, InitError, planInit } from './init-wrangler.js'
import type { InitAction, InitPlan } from './init-wrangler.js'

const USAGE = `Usage: datafridge init cloudflare [--config <path>]

Adds the wrangler.toml declarations for both datafridge combos:
  combo A: Durable Object alarms scheduler (DO binding + SQLite class migration) + D1 results
  combo B: cron trigger + D1 full store (CAS-protected concurrent ticks)

Idempotent: declarations already present are detected and never duplicated;
existing configuration is never rewritten. --config defaults to ./wrangler.toml.`

const NEXT_STEPS = `
Next steps:
  1. wrangler d1 create ${D1_DATABASE_NAME}, then paste the database_id into wrangler.toml
  2. apply the schema: wrangler d1 execute ${D1_DATABASE_NAME} --remote --file node_modules/@datafridge/cloudflare/migrations/0001_datafridge_init.sql
  3. combo A: export a PollerDO subclass named Poller; combo B: wire cronPoller as your scheduled handler
  4. keep the combo you use and delete the other declarations`

export interface CliIo {
  cwd: string
  log(line: string): void
  error(line: string): void
  today(): string
}

export function runCli(argv: readonly string[], io: CliIo): number {
  const positionals: string[] = []
  let configPath: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      io.log(USAGE)
      return 0
    }
    if (arg === '--config') {
      i += 1
      configPath = argv[i]
      if (configPath === undefined) return fail(io, '--config requires a path')
    } else if (arg !== undefined) {
      positionals.push(arg)
    }
  }
  if (positionals[0] !== 'init') {
    return fail(io, `unknown command '${positionals.join(' ')}'`)
  }
  if (positionals.length !== 2 || positionals[1] !== 'cloudflare') {
    return fail(
      io,
      `unknown init target '${positionals.slice(1).join(' ')}'; supported: cloudflare`,
    )
  }

  const path = resolve(io.cwd, configPath ?? 'wrangler.toml')
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null
  let plan: InitPlan
  try {
    plan = planInit(existing, io.today())
  } catch (err) {
    if (err instanceof InitError) {
      io.error(`datafridge init: ${err.message}`)
      return 1
    }
    throw err
  }

  for (const action of plan.actions) io.log(renderAction(action))
  if (plan.changed) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, plan.content)
    io.log(`${plan.created ? 'created' : 'updated'} ${path}`)
    io.log(NEXT_STEPS)
  } else {
    io.log(`${path} already fully configured; nothing written`)
  }
  return plan.actions.some((action) => action.kind === 'manual') ? 1 : 0
}

function renderAction(action: InitAction): string {
  const mark = action.kind === 'add' ? '+' : action.kind === 'skip' ? '=' : '!'
  const line = `  ${mark} ${action.subject}: ${action.detail}`
  return action.kind === 'manual' && action.snippet ? `${line}\n      ${action.snippet}` : line
}

function fail(io: CliIo, message: string): number {
  io.error(`datafridge: ${message}`)
  io.error(USAGE)
  return 1
}
