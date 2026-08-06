import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

const changesetDirectory = resolve(import.meta.dirname, '../.changeset')

// Mirrors the predicate @changesets/read uses for `hasChangesets`, which is what
// changesets/action branches on between versioning and publishing.
const pending = (await readdir(changesetDirectory)).filter(
  (entry) => !entry.startsWith('.') && entry.endsWith('.md') && !/^README\.md$/i.test(entry),
)

if (pending.length > 0) {
  process.stderr.write(
    `Refusing to publish: ${pending.length} pending changeset(s) in .changeset (${pending.join(', ')}).\n` +
      'Merge the version PR first so main carries the versions to publish.\n',
  )
  process.exit(1)
}

process.stdout.write('Changeset queue is empty; main carries the versions to publish.\n')
