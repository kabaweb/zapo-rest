import { describe, expect, it } from 'vitest'
import { Semaphore } from '~/lib/semaphore'

describe('Semaphore', () => {
  it('limits concurrent runs', async () => {
    const sem = new Semaphore(2)
    let concurrent = 0
    let peak = 0

    const job = async () => {
      concurrent++
      peak = Math.max(peak, concurrent)
      await new Promise((r) => setTimeout(r, 30))
      concurrent--
    }

    await Promise.all([sem.run(job), sem.run(job), sem.run(job), sem.run(job)])
    expect(peak).toBeLessThanOrEqual(2)
    expect(sem.running).toBe(0)
    expect(sem.pending).toBe(0)
  })
})
