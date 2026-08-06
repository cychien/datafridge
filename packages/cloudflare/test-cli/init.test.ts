import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'smol-toml'
import { afterEach, describe, expect, it } from 'vitest'

import { InitError, planInit } from '../src/cli/init-wrangler.js'
import type { InitSelection } from '../src/cli/init-wrangler.js'
import { runCli } from '../src/cli/run.js'
import type { CliIo } from '../src/cli/run.js'

const TODAY = '2026-08-06'
const fixture = readFileSync(
  fileURLToPath(new URL('./fixtures/user-wrangler.toml', import.meta.url)),
  'utf8',
)

const DO_SELECTION: InitSelection = { scheduler: 'durable-object', store: 'd1' }
const CRON_SELECTION: InitSelection = { scheduler: 'cron', store: 'd1' }

const plan = (existing: string | null, selection: InitSelection = DO_SELECTION) =>
  planInit(existing, TODAY, selection)

const DO_ARGS = ['init', '--scheduler', 'durable-object', '--store', 'd1']
const CRON_ARGS = ['init', '--scheduler', 'cron', '--store', 'd1']

function parsed(content: string): Record<string, unknown> {
  return parse(content) as Record<string, unknown>
}

describe('planInit', () => {
  it('writes exactly what the durable-object scheduler needs, and no cron', () => {
    const result = plan(null)
    expect(result.created).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.actions.map((a) => a.kind)).toEqual(['add', 'add', 'add'])

    const root = parsed(result.content)
    expect(root).toMatchObject({
      durable_objects: { bindings: [{ name: 'POLLER', class_name: 'Poller' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Poller'] }],
      d1_databases: [{ binding: 'DB', database_name: 'datafridge', database_id: 'TODO' }],
      compatibility_date: TODAY,
    })
    // Nothing to delete afterwards: the scheduler you did not pick is absent.
    expect(root.triggers).toBeUndefined()
  })

  it('writes exactly what the cron scheduler needs, and no Durable Object', () => {
    const result = plan(null, CRON_SELECTION)
    expect(result.actions.map((a) => a.kind)).toEqual(['add', 'add'])

    const root = parsed(result.content)
    expect(root).toMatchObject({
      triggers: { crons: ['* * * * *'] },
      d1_databases: [{ binding: 'DB', database_name: 'datafridge', database_id: 'TODO' }],
    })
    expect(root.durable_objects).toBeUndefined()
    expect(root.migrations).toBeUndefined()
  })

  it('is idempotent: a second run changes nothing and adds nothing', () => {
    const first = plan(fixture)
    expect(first.changed).toBe(true)

    const second = plan(first.content)
    expect(second.changed).toBe(false)
    expect(second.content).toBe(first.content)
    expect(second.actions.map((a) => a.kind)).toEqual(['skip', 'skip', 'skip'])
  })

  it('preserves unrelated user content byte-for-byte and only appends', () => {
    const result = plan(fixture)
    expect(result.content.startsWith(fixture)).toBe(true)

    const root = parsed(result.content)
    expect(root).toMatchObject({
      name: 'my-app',
      vars: { API_URL: 'https://example.com', RETRIES: 3 },
      kv_namespaces: [{ binding: 'CACHE', id: 'abc123' }],
      env: { staging: { name: 'my-app-staging' } },
    })
  })

  it('skips an existing Poller binding but still adds its migration with the next free tag', () => {
    const existing = `${fixture}
[[durable_objects.bindings]]
name = "JOBS"
class_name = "Poller"

[[migrations]]
tag = "v1"
new_classes = ["SomethingElse"]
`
    const result = plan(existing)
    const skip = result.actions.find((a) => a.subject === 'durable_objects.bindings')
    expect(skip?.kind).toBe('skip')

    const root = parsed(result.content)
    expect(root.migrations).toEqual([
      { tag: 'v1', new_classes: ['SomethingElse'] },
      { tag: 'v2', new_sqlite_classes: ['Poller'] },
    ])
    const bindings = (root.durable_objects as { bindings: unknown[] }).bindings
    expect(bindings).toHaveLength(1)
  })

  it('skips migrations that already declare the Poller class', () => {
    const existing = `${fixture}
[[migrations]]
tag = "v1"
new_sqlite_classes = ["Poller"]
`
    const result = plan(existing)
    expect(result.actions.find((a) => a.subject === 'migrations')?.kind).toBe('skip')
    expect(parsed(result.content).migrations).toEqual([
      { tag: 'v1', new_sqlite_classes: ['Poller'] },
    ])
  })

  it('leaves an existing cron schedule alone', () => {
    const existing = `${fixture}
[triggers]
crons = ["*/5 * * * *"]
`
    const result = plan(existing, CRON_SELECTION)
    expect(result.actions.find((a) => a.subject === 'triggers.crons')?.kind).toBe('skip')
    expect(parsed(result.content).triggers).toEqual({ crons: ['*/5 * * * *'] })
  })

  it('inserts crons into an existing [triggers] section instead of duplicating it', () => {
    const existing = `${fixture}
[triggers]
`
    const result = plan(existing, CRON_SELECTION)
    expect(result.actions.find((a) => a.subject === 'triggers.crons')?.kind).toBe('add')
    expect(result.content.match(/\[triggers\]/g)).toHaveLength(1)
    expect(parsed(result.content).triggers).toMatchObject({ crons: ['* * * * *'] })
  })

  it('skips D1 when any database binding already exists', () => {
    const existing = `${fixture}
[[d1_databases]]
binding = "ANALYTICS"
database_name = "analytics"
database_id = "1234"
`
    const result = plan(existing)
    expect(result.actions.find((a) => a.subject === 'd1_databases')?.kind).toBe('skip')
    expect(parsed(result.content).d1_databases).toEqual([
      { binding: 'ANALYTICS', database_name: 'analytics', database_id: '1234' },
    ])
  })

  it('rejects an invalid wrangler.toml without guessing', () => {
    expect(() => plan('name = "broken')).toThrow(InitError)
    expect(() => plan('name = "broken')).toThrow(/wrangler\.toml is not valid TOML/)
  })

  it('refuses to write when appending would corrupt the file (inline durable_objects)', () => {
    const existing = `name = "my-app"
durable_objects = { bindings = [{ name = "OTHER", class_name = "Other" }] }
`
    expect(() => plan(existing)).toThrow(/refusing to write/)
    expect(() => plan(existing)).toThrow(/left untouched/)
  })
})

describe('runCli', () => {
  let dir: string | undefined

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  function io(cwd: string): CliIo & { lines: string[]; errors: string[] } {
    const lines: string[] = []
    const errors: string[] = []
    return {
      cwd,
      lines,
      errors,
      log: (line) => lines.push(line),
      error: (line) => errors.push(line),
      today: () => TODAY,
    }
  }

  it('writes idempotently to a wrangler.toml on disk', () => {
    dir = mkdtempSync(join(tmpdir(), 'datafridge-init-'))
    const path = join(dir, 'wrangler.toml')
    writeFileSync(path, fixture)

    const first = io(dir)
    expect(runCli(DO_ARGS, first)).toBe(0)
    const afterFirst = readFileSync(path, 'utf8')
    expect(afterFirst.startsWith(fixture)).toBe(true)
    expect(first.lines.join('\n')).toContain(`updated ${path}`)

    const second = io(dir)
    expect(runCli(DO_ARGS, second)).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe(afterFirst)
    expect(second.lines.join('\n')).toContain('nothing written')
  })

  it('creates the file when missing and honors --config', () => {
    dir = mkdtempSync(join(tmpdir(), 'datafridge-init-'))
    const cli = io(dir)
    expect(runCli([...CRON_ARGS, '--config', 'infra/wrangler.toml'], cli)).toBe(0)
    const written = readFileSync(join(dir, 'infra/wrangler.toml'), 'utf8')
    expect(parsed(written)).toMatchObject({ triggers: { crons: ['* * * * *'] } })
  })

  it.each(['wrangler.jsonc', 'wrangler.json'])(
    'refuses to scaffold a wrangler.toml next to an existing %s and prints manual snippets',
    (siblingName) => {
      dir = mkdtempSync(join(tmpdir(), 'datafridge-init-'))
      writeFileSync(join(dir, siblingName), '{ "name": "my-app" }\n')

      const cli = io(dir)
      expect(runCli(DO_ARGS, cli)).toBe(1)
      expect(existsSync(join(dir, 'wrangler.toml'))).toBe(false)

      const output = cli.errors.join('\n')
      expect(output).toContain(join(dir, siblingName))
      expect(output).toContain('[[durable_objects.bindings]]')
      expect(output).toContain('[[migrations]]')
      expect(output).toContain('[[d1_databases]]')
      // The snippets follow the selection too, so there is nothing extra to prune.
      expect(output).not.toContain('crons =')
    },
  )

  it('distinguishes outstanding manual steps from a fully configured file', () => {
    dir = mkdtempSync(join(tmpdir(), 'datafridge-init-'))
    const path = join(dir, 'wrangler.toml')
    const configured = `triggers = {}
name = "my-app"

[[durable_objects.bindings]]
name = "POLLER"
class_name = "Poller"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Poller"]

[[d1_databases]]
binding = "DB"
database_name = "datafridge"
database_id = "1234"
`
    writeFileSync(path, configured)

    const cli = io(dir)
    expect(runCli(CRON_ARGS, cli)).toBe(1)
    expect(readFileSync(path, 'utf8')).toBe(configured)

    const output = cli.lines.join('\n')
    expect(output).not.toContain('already fully configured')
    expect(output).toContain(`${path} not modified; manual steps remain above`)
  })

  it('leaves an invalid file untouched and exits non-zero', () => {
    dir = mkdtempSync(join(tmpdir(), 'datafridge-init-'))
    const path = join(dir, 'wrangler.toml')
    writeFileSync(path, 'name = "broken')

    const cli = io(dir)
    expect(runCli(DO_ARGS, cli)).toBe(1)
    expect(readFileSync(path, 'utf8')).toBe('name = "broken')
    expect(cli.errors.join('\n')).toContain('not valid TOML')
  })

  it('requires the scheduler and the store to be chosen, with no default pairing', () => {
    dir = mkdtempSync(join(tmpdir(), 'datafridge-init-'))

    const bare = io(dir)
    expect(runCli(['init'], bare)).toBe(1)
    expect(bare.errors.join('\n')).toContain('requires --scheduler and --store')
    expect(existsSync(join(dir, 'wrangler.toml'))).toBe(false)

    const noStore = io(dir)
    expect(runCli(['init', '--scheduler', 'cron'], noStore)).toBe(1)
    expect(noStore.errors.join('\n')).toContain('requires --scheduler and --store')

    const badScheduler = io(dir)
    expect(runCli(['init', '--scheduler', 'quartz', '--store', 'd1'], badScheduler)).toBe(1)
    expect(badScheduler.errors.join('\n')).toContain(
      "unknown scheduler 'quartz'; supported: durable-object, cron",
    )

    const badStore = io(dir)
    expect(runCli(['init', '--scheduler', 'cron', '--store', 'redis'], badStore)).toBe(1)
    expect(badStore.errors.join('\n')).toContain("unknown store 'redis'; supported: d1")

    const noValue = io(dir)
    expect(runCli(['init', '--scheduler'], noValue)).toBe(1)
    expect(noValue.errors.join('\n')).toContain('--scheduler requires a value')
  })

  it('rejects unknown commands with usage', () => {
    dir = mkdtempSync(join(tmpdir(), 'datafridge-init-'))
    expect(runCli([], io(dir))).toBe(1)
    expect(runCli(['frobnicate'], io(dir))).toBe(1)
    expect(runCli(['init', 'aws', '--scheduler', 'cron', '--store', 'd1'], io(dir))).toBe(1)

    const help = io(dir)
    expect(runCli(['--help'], help)).toBe(0)
    const usage = help.lines.join('\n')
    // The command shape stays the same as targets are added; only the list grows.
    expect(usage).toContain('Usage: datafridge init --scheduler <durable-object|cron> --store <d1>')
  })
})
