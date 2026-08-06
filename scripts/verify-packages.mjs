import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const packages = [
  {
    directory: join(root, 'packages/core'),
    archivePrefix: 'datafridge-core-',
    required: [
      'package/LICENSE',
      'package/README.md',
      'package/dist/index.js',
      'package/dist/index.d.ts',
      'package/dist/contract-tests.js',
      'package/dist/contract-tests.d.ts',
    ],
  },
  {
    directory: join(root, 'packages/cloudflare'),
    archivePrefix: 'datafridge-cloudflare-',
    required: [
      'package/LICENSE',
      'package/README.md',
      'package/dist/index.js',
      'package/dist/index.d.ts',
      'package/dist/do.js',
      'package/dist/do.d.ts',
      'package/dist/d1.js',
      'package/dist/d1.d.ts',
      'package/dist/cron.js',
      'package/dist/cron.d.ts',
      'package/dist/cli.js',
      'package/migrations/0001_datafridge_init.sql',
    ],
  },
]

const temporary = await mkdtemp(join(tmpdir(), 'datafridge-release-check-'))

try {
  const rounds = [join(temporary, 'round-1'), join(temporary, 'round-2')]
  await Promise.all(rounds.map((directory) => mkdir(directory)))

  for (const definition of packages) {
    for (const round of rounds) {
      run('pnpm', ['pack', '--pack-destination', round], { cwd: definition.directory })
    }
  }

  const firstArchives = await archivesByPrefix(rounds[0])
  const secondArchives = await archivesByPrefix(rounds[1])

  for (const definition of packages) {
    const first = firstArchives.get(definition.archivePrefix)
    const second = secondArchives.get(definition.archivePrefix)
    if (!first || !second) throw new Error(`missing archive for ${definition.archivePrefix}`)

    const [firstHash, secondHash] = await Promise.all([sha256(first), sha256(second)])
    if (firstHash !== secondHash) {
      throw new Error(`${definition.archivePrefix} pack is not reproducible`)
    }

    const contents = run('tar', ['-tzf', first]).stdout.trim().split('\n')
    for (const required of definition.required) {
      if (!contents.includes(required)) throw new Error(`${first} is missing ${required}`)
    }
    const forbidden = contents.find((path) =>
      /^package\/(?:src|test|test-cli|node_modules|coverage)(?:\/|$)/.test(path),
    )
    if (forbidden) throw new Error(`${first} contains development-only path ${forbidden}`)

    const packagedLicense = run('tar', ['-xOf', first, 'package/LICENSE']).stdout
    if (packagedLicense !== (await readFile(join(root, 'LICENSE'), 'utf8'))) {
      throw new Error(`${first} contains a stale license copy`)
    }

    const manifest = JSON.parse(run('tar', ['-xOf', first, 'package/package.json']).stdout)
    if (JSON.stringify(manifest).includes('workspace:')) {
      throw new Error(`${first} contains an unresolved workspace dependency`)
    }
    if (
      manifest.publishConfig?.access !== 'public' ||
      manifest.publishConfig?.provenance !== true
    ) {
      throw new Error(`${first} is missing public provenance publish configuration`)
    }
  }

  const fixture = join(temporary, 'consumer')
  await mkdir(fixture)
  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify({ name: 'datafridge-consumer-check', private: true, type: 'module' }),
  )
  await writeFile(
    join(fixture, 'verify.mjs'),
    `import { createReader, defineQueries, memoryStore } from '@datafridge/core'
import { cronDriver } from '@datafridge/cloudflare/cron'
import { d1 } from '@datafridge/cloudflare/d1'

const queries = defineQueries([{ name: 'fixture', every: '1m', fetch: async () => 1 }])
if (queries.get('fixture')?.everyMs !== 60_000) throw new Error('core import failed')
if (typeof createReader !== 'function' || typeof memoryStore !== 'function') throw new Error('core exports failed')
if (typeof cronDriver !== 'function' || typeof d1 !== 'function') throw new Error('Cloudflare subpath exports failed')

const store = memoryStore()
await store.writeResult('fixture', { data: 7, fetchedAt: 0, freshUntil: 1 })
const read = await createReader({ store }).read('fixture')
if (read?.data !== 7 || read.status !== 'ok') throw new Error('read shape failed')
`,
  )
  await writeFile(
    join(fixture, 'verify.ts'),
    `import { createReader, defineParameterizedQuery, defineQueries, memoryStore } from '@datafridge/core'
import type { QueryCodec } from '@datafridge/core'
import { cronFridge } from '@datafridge/cloudflare/cron'
import { d1 } from '@datafridge/cloudflare/d1'

const codec: QueryCodec<Map<string, number>> = {
  encode: (value) => ({ rows: [...value] }),
  decode: (raw) => new Map((raw as { rows: [string, number][] }).rows),
}

const parameterized = defineParameterizedQuery({
  name: 'fixture',
  every: '1m',
  dimensions: { id: ['a'], window: async () => ['7d'] },
  validUntil: ({ now }) => now + 60_000,
  codec,
  fetch: async () => new Map([['/a', 1]]),
})
const queries = defineQueries([parameterized])
const reader = createReader({ store: memoryStore(), queries })
void reader.read<Map<string, number>>('fixture', { id: 'a', window: '7d' })
void queries.dynamic
void cronFridge
void d1
`,
  )
  await writeFile(
    join(fixture, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['verify.ts'],
    }),
  )

  const coreArchive = firstArchives.get('datafridge-core-')
  const cloudflareArchive = firstArchives.get('datafridge-cloudflare-')
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      coreArchive,
      cloudflareArchive,
    ],
    { cwd: fixture },
  )
  run('node', ['verify.mjs'], { cwd: fixture })
  run(join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], { cwd: fixture })
  run(join(fixture, 'node_modules/.bin/datafridge'), ['--help'], { cwd: fixture })

  for (const [prefix, archive] of firstArchives) {
    process.stdout.write(`${prefix}${await sha256(archive)}  ${archive}\n`)
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}

async function archivesByPrefix(directory) {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.tgz'))
  return new Map(
    packages.map(({ archivePrefix }) => {
      const name = names.find((candidate) => candidate.startsWith(archivePrefix))
      return [archivePrefix, name ? join(directory, name) : undefined]
    }),
  )
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    )
  }
  return result
}
