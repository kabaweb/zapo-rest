/**
 * Process-level + per-instance resource snapshots.
 * True per-instance CPU isolation is not available in a multi-session Node process;
 * we report process totals and a fair-share estimate across live sessions.
 */

export type ProcessResourceSnapshot = {
  pid: number
  uptimeSecs: number
  memory: {
    rssBytes: number
    heapUsedBytes: number
    heapTotalBytes: number
    externalBytes: number
    arrayBuffersBytes: number
  }
  cpu: {
    /** Cumulative user+system µs since process start */
    userMicros: number
    systemMicros: number
    /** Approximate % of one core since last sample (null on first sample) */
    percentSinceLastSample: number | null
  }
  sampledAt: string
}

export type InstanceResourceSnapshot = {
  instance: string
  live: boolean
  process: ProcessResourceSnapshot
  /** Live WA sessions currently held in this process */
  liveSessions: number
  /** Rough equal share of heap among live sessions (or full heap if only this one) */
  estimatedHeapShareBytes: number | null
  estimatedRssShareBytes: number | null
  storage: {
    mediaObjectsBytes: number
    callRecordingBytes: number
    estimatedTotalBytes: number
    messagesCount: number
    chatsCount: number
    contactsCount: number
  }
  cache: {
    kind: 'redis' | 'memory' | 'unknown'
    /** Best-effort; redis INFO used when available */
    note: string
  }
}

let lastCpu: NodeJS.CpuUsage | null = null
let lastCpuAt = 0

export function sampleProcessResources(): ProcessResourceSnapshot {
  const mem = process.memoryUsage()
  const cpu = process.cpuUsage()
  const now = Date.now()
  let percent: number | null = null
  if (lastCpu && lastCpuAt > 0) {
    const elapsedMicros = (now - lastCpuAt) * 1000
    if (elapsedMicros > 0) {
      const deltaUser = cpu.user - lastCpu.user
      const deltaSys = cpu.system - lastCpu.system
      percent = Math.round(((deltaUser + deltaSys) / elapsedMicros) * 1000) / 10
    }
  }
  lastCpu = cpu
  lastCpuAt = now

  return {
    pid: process.pid,
    uptimeSecs: Math.floor(process.uptime()),
    memory: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      arrayBuffersBytes: mem.arrayBuffers ?? 0,
    },
    cpu: {
      userMicros: cpu.user,
      systemMicros: cpu.system,
      percentSinceLastSample: percent,
    },
    sampledAt: new Date().toISOString(),
  }
}
