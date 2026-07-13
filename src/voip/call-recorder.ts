/**
 * Dual-channel PCM recorder → WAV (16-bit LE, 16 kHz).
 * Channel 0 = local (mic), channel 1 = remote (peer).
 */

const SAMPLE_RATE = 16_000
/** Default max recording length (samples per channel). Overridden via constructor. */
const DEFAULT_MAX_SECONDS = 7200

export class CallPcmRecorder {
  private readonly local: Float32Array[] = []
  private readonly remote: Float32Array[] = []
  private localSamples = 0
  private remoteSamples = 0
  private closed = false
  private readonly maxSamples: number

  constructor(
    readonly callId: string,
    readonly instanceName: string,
    readonly meta: { peerJid?: string | null; direction?: string },
    maxSeconds = DEFAULT_MAX_SECONDS,
  ) {
    this.maxSamples = Math.max(1, maxSeconds) * SAMPLE_RATE
  }

  appendLocal(pcm: Float32Array): void {
    if (this.closed || pcm.length === 0) return
    if (this.localSamples >= this.maxSamples) return
    const room = this.maxSamples - this.localSamples
    const slice = pcm.length > room ? pcm.subarray(0, room) : pcm
    this.local.push(Float32Array.from(slice))
    this.localSamples += slice.length
  }

  appendRemote(pcm: Float32Array): void {
    if (this.closed || pcm.length === 0) return
    if (this.remoteSamples >= this.maxSamples) return
    const room = this.maxSamples - this.remoteSamples
    const slice = pcm.length > room ? pcm.subarray(0, room) : pcm
    this.remote.push(Float32Array.from(slice))
    this.remoteSamples += slice.length
  }

  /** Build interleaved stereo WAV. Empty if no audio. */
  finalize(): Buffer | null {
    this.closed = true
    const n = Math.max(this.localSamples, this.remoteSamples)
    if (n === 0) return null

    const local = concatF32(this.local, this.localSamples, n)
    const remote = concatF32(this.remote, this.remoteSamples, n)
    const int16 = new Int16Array(n * 2)
    for (let i = 0; i < n; i++) {
      int16[i * 2] = floatToInt16(local[i] ?? 0)
      int16[i * 2 + 1] = floatToInt16(remote[i] ?? 0)
    }
    return encodeWavPcm16(int16, SAMPLE_RATE, 2)
  }

  get durationSecs(): number {
    return Math.round(Math.max(this.localSamples, this.remoteSamples) / SAMPLE_RATE)
  }
}

function concatF32(chunks: Float32Array[], total: number, padTo: number): Float32Array {
  const out = new Float32Array(padTo)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  // pad remaining with silence
  void total
  return out
}

function floatToInt16(s: number): number {
  const x = Math.max(-1, Math.min(1, s))
  return Math.max(-32768, Math.min(32767, Math.round(x * 32767)))
}

function encodeWavPcm16(samples: Int16Array, sampleRate: number, channels: number): Buffer {
  const dataBytes = samples.byteLength
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16) // PCM chunk size
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * 2, 28) // byte rate
  buffer.writeUInt16LE(channels * 2, 32) // block align
  buffer.writeUInt16LE(16, 34) // bits
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataBytes, 40)
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(buffer, 44)
  return buffer
}
