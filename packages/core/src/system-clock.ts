import type { Clock } from './clock.js'

// The one sanctioned wall-clock module: everything else in core must use the
// injected Clock / random source (enforced by eslint).
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export const systemRandom = (): number => Math.random()
