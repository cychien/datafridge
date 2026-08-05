export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export async function flushMicrotasks(rounds = 32): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

interface FakeTimer {
  at: number
  fn: () => void
  seq: number
}

export class FakeClock implements Clock {
  #now: number
  #seq = 0
  #timers = new Map<number, FakeTimer>()

  constructor(start = 0) {
    this.#now = start
  }

  now(): number {
    return this.#now
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const seq = ++this.#seq
    this.#timers.set(seq, { at: this.#now + Math.max(0, ms), fn, seq })
    return seq
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.#timers.delete(handle)
  }

  async advance(ms: number): Promise<void> {
    const target = this.#now + ms
    for (;;) {
      const next = [...this.#timers.values()]
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0]
      if (!next) break
      this.#now = Math.max(this.#now, next.at)
      this.#timers.delete(next.seq)
      next.fn()
      await flushMicrotasks()
    }
    this.#now = target
    await flushMicrotasks()
  }
}
