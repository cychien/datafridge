import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const exampleDir = fileURLToPath(new URL('..', import.meta.url))
const wranglerBin = fileURLToPath(new URL('../node_modules/.bin/wrangler', import.meta.url))

/**
 * workerd evaluates a Worker's whole module graph in global scope before any
 * handler runs, and bans AbortController, timers and randomness there. The
 * workers pool evaluates modules inside a request context instead, so only a
 * real runtime start witnesses this.
 */
test('the example Worker starts under workerd', async () => {
  const wrangler = spawn(wranglerBin, ['dev', '--port', '0', '--inspector-port', '0'], {
    cwd: exampleDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
  })

  let output = ''
  try {
    await new Promise<void>((resolve, reject) => {
      const read = (chunk: unknown) => {
        output += String(chunk)
        if (output.includes('Ready on http')) resolve()
        if (output.includes('runtime failed to start')) reject(new Error(output))
      }
      wrangler.stdout?.on('data', read)
      wrangler.stderr?.on('data', read)
      wrangler.on('error', reject)
      wrangler.on('exit', (code) => {
        reject(new Error(`wrangler dev exited with ${code}\n${output}`))
      })
    })
  } finally {
    wrangler.kill()
  }

  expect(output).not.toContain('Disallowed operation called within global scope')
})
