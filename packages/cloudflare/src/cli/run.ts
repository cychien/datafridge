import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  D1_DATABASE_NAME,
  InitError,
  SCHEDULERS,
  STORES,
  declarationSnippets,
  planInit,
} from './init-wrangler.js'
import type {
  InitAction,
  InitPlan,
  InitSelection,
  SchedulerChoice,
  StoreChoice,
} from './init-wrangler.js'

const USAGE = `Usage: datafridge init --scheduler <${SCHEDULERS.join('|')}> --store <${STORES.join('|')}> [--config <path>]

The scheduler and the store are chosen independently, and only the declarations
that combination needs are written - nothing is scaffolded for you to delete.

  --scheduler durable-object   Durable Object alarms; exact due times, keeps its
                               own schedule bookkeeping in the object's SQLite
  --scheduler cron             Cron Trigger; 1-minute floor, schedule
                               bookkeeping lives in the store
  --store d1                   Cloudflare D1

Idempotent: declarations already present are detected and never duplicated;
existing configuration is never rewritten. --config defaults to ./wrangler.toml.`

function nextSteps(selection: InitSelection): string {
  const wire =
    selection.scheduler === 'durable-object'
      ? `export a PollerDO subclass named ${'Poller'} and call ensureStarted once after deploying`
      : 'wire cronPoller as your scheduled handler'
  return `
Next steps:
  1. wrangler d1 create ${D1_DATABASE_NAME}, then paste the database_id into wrangler.toml
  2. ${wire}
  3. the D1 tables are created on the first write; declare the schema yourself only if you
     prefer to: wrangler d1 execute ${D1_DATABASE_NAME} --remote --file node_modules/@datafridge/cloudflare/migrations/0001_datafridge_init.sql`
}

export interface CliIo {
  cwd: string
  log(line: string): void
  error(line: string): void
  today(): string
}

export function runCli(argv: readonly string[], io: CliIo): number {
  const positionals: string[] = []
  let configPath: string | undefined
  let scheduler: string | undefined
  let store: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      io.log(USAGE)
      return 0
    }
    if (arg === '--config' || arg === '--scheduler' || arg === '--store') {
      const flag = arg
      i += 1
      const value = argv[i]
      if (value === undefined) return fail(io, `${flag} requires a value`)
      if (flag === '--config') configPath = value
      else if (flag === '--scheduler') scheduler = value
      else store = value
    } else if (arg !== undefined) {
      positionals.push(arg)
    }
  }
  if (positionals.length !== 1 || positionals[0] !== 'init') {
    return fail(io, `unknown command '${positionals.join(' ')}'`)
  }
  if (scheduler === undefined || store === undefined) {
    return fail(io, 'init requires --scheduler and --store; there is no default pairing')
  }
  if (!isScheduler(scheduler)) {
    return fail(io, `unknown scheduler '${scheduler}'; supported: ${SCHEDULERS.join(', ')}`)
  }
  if (!isStore(store)) {
    return fail(io, `unknown store '${store}'; supported: ${STORES.join(', ')}`)
  }
  const selection: InitSelection = { scheduler, store }

  const path = resolve(io.cwd, configPath ?? 'wrangler.toml')
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (existing === null) {
    const sibling = ['wrangler.jsonc', 'wrangler.json']
      .map((name) => resolve(dirname(path), name))
      .find((candidate) => existsSync(candidate))
    if (sibling !== undefined) {
      io.error(
        `datafridge init: found ${sibling}; this tool only writes wrangler.toml and refuses to ` +
          'scaffold one that would conflict with your existing config. ' +
          'Add the equivalent of these declarations manually:\n\n' +
          declarationSnippets(selection).join('\n\n'),
      )
      return 1
    }
  }
  let plan: InitPlan
  try {
    plan = planInit(existing, io.today(), selection)
  } catch (err) {
    if (err instanceof InitError) {
      io.error(`datafridge init: ${err.message}`)
      return 1
    }
    throw err
  }

  const manualRemaining = plan.actions.some((action) => action.kind === 'manual')
  for (const action of plan.actions) io.log(renderAction(action))
  if (plan.changed) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, plan.content)
    io.log(`${plan.created ? 'created' : 'updated'} ${path}`)
    io.log(nextSteps(selection))
  } else if (manualRemaining) {
    io.log(`${path} not modified; manual steps remain above`)
  } else {
    io.log(`${path} already fully configured; nothing written`)
  }
  return manualRemaining ? 1 : 0
}

function renderAction(action: InitAction): string {
  const mark = action.kind === 'add' ? '+' : action.kind === 'skip' ? '=' : '!'
  const line = `  ${mark} ${action.subject}: ${action.detail}`
  return action.kind === 'manual' && action.snippet ? `${line}\n      ${action.snippet}` : line
}

function isScheduler(value: string): value is SchedulerChoice {
  return (SCHEDULERS as readonly string[]).includes(value)
}

function isStore(value: string): value is StoreChoice {
  return (STORES as readonly string[]).includes(value)
}

function fail(io: CliIo, message: string): number {
  io.error(`datafridge: ${message}`)
  io.error(USAGE)
  return 1
}
