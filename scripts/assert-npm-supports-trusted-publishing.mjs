import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

// npm gained OIDC trusted publishing in 11.5.0; 11.5.2 is the first release carrying
// all three of its correctness fixes, including the provenance visibility check.
const minimum = [11, 5, 2]

// `changeset publish` shells out to `pnpm publish`, which packs a tarball and hands the
// registry call to the npm CLI - resolved with dirname(process.execPath) ahead of PATH.
// That is the npm that authenticates, so it is the one worth asserting on.
const adjacent = join(dirname(process.execPath), 'npm')
const npm = existsSync(adjacent) ? adjacent : 'npm'

const result = spawnSync(npm, ['--version'], { encoding: 'utf8' })
if (result.status !== 0) {
  process.stderr.write(`${npm} --version failed\n${result.stderr ?? ''}`)
  process.exit(1)
}

const reported = result.stdout.trim()
const parts = reported.split('-')[0].split('.').map(Number)
if (parts.length !== 3 || parts.some(Number.isNaN)) {
  process.stderr.write(`Could not parse an npm version from ${JSON.stringify(reported)}\n`)
  process.exit(1)
}

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

if (compare(parts, minimum) < 0) {
  process.stderr.write(
    `${npm} reports ${reported}, which predates npm ${minimum.join('.')} and cannot publish with trusted publishing.\n`,
  )
  process.exit(1)
}

process.stdout.write(`${npm} reports ${reported}; trusted publishing is supported.\n`)
