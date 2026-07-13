/**
 * Bounded concurrency gate for fire-and-forget work (media downloads, etc.).
 *
 * @example
 *   const sem = new Semaphore(4)
 *   void sem.run(() => download(...)).catch(log)
 */
export class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly max: number) {
    if (max < 1) throw new Error('Semaphore max must be >= 1')
  }

  get running(): number {
    return this.active
  }

  get pending(): number {
    return this.waiters.length
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active++
        resolve()
      })
    })
  }

  private release(): void {
    this.active--
    const next = this.waiters.shift()
    if (next) next()
  }
}
