import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { D1_SCHEMA } from '../src/schema.js'

const migration = readFileSync(
  fileURLToPath(new URL('../migrations/0001_datafridge_init.sql', import.meta.url)),
  'utf8',
)

const normalize = (sql: string) =>
  sql
    .replace(/\s+/g, ' ')
    .replace(/\s*([()])\s*/g, '$1')
    .trim()

describe('the packaged migration and the schema d1() applies stay identical', () => {
  it('every statement d1() applies is present in the migration', () => {
    const normalized = normalize(migration)
    for (const statement of D1_SCHEMA) {
      expect(normalized).toContain(normalize(statement))
    }
  })

  it('the migration declares nothing beyond those statements', () => {
    const statements = migration
      .split(';')
      .map((part) =>
        part
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n'),
      )
      .map(normalize)
      .filter(Boolean)
    expect(statements).toHaveLength(D1_SCHEMA.length)
  })
})
