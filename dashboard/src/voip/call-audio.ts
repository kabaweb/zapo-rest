/**
 * Live VoIP audio bridge for softphone:
 * - Mic → HPF / gain → noise gate → downsample 16 kHz f32le → WS binary
 * - WS binary 16 kHz → upsample → selected speaker (AudioContext setSinkId)
 *
 * Reliability notes:
 * - Fresh ArrayBuffer on every ws.send (never share WebAudio channel buffers)
 * - Capture kept alive via MediaStreamDestination + zero-gain destination pull
 * - Resume AudioContext if the browser suspends mid-call
 */

import type { SoftphoneAudioPrefs } from './audio-settings'

export const TARGET_SR = 16_000

export type CallAudioHandles = {
  getMicLevel: () => number
  setMuted: (muted: boolean) => void
  setPrefs: (prefs: SoftphoneAudioPrefs) => void
  setSpeakerId: (deviceId: string) => Promise<void>
  pushRemotePcm: (ab: ArrayBuffer) => void
  stop: () => void
}

function resample(input: Float32Array, fromRate: number, toRate: number, mode: 'down' | 'up'): Float32Array {
  if (fromRate === toRate) {
    const copy = new Float32Array(input.length)
    copy.set(input)
    return copy
  }
  const ratio = mode === 'down' ? fromRate / toRate : toRate / fromRate
  const outLen =
    mode === 'down' ? Math.max(1, Math.floor(input.length / ratio)) : Math.max(1, Math.floor(input.length * ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const src = mode === 'down' ? i * ratio : i / ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const t = src - i0
    out[i] = (input[i0] ?? 0) * (1 - t) + (input[i1] ?? 0) * t
  }
  return out
}

class NoiseGate {
  private env = 0
  process(samples: Float32Array, enabled: boolean): void {
    if (!enabled) return
    const attack = 0.3
    const release = 0.04
    const openThresh = 0.01
    const closeThresh = 0.005
    let open = this.env > openThresh
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i] ?? 0
      const a = Math.abs(x)
      this.env = a > this.env ? this.env + (a - this.env) * attack : this.env + (a - this.env) * release
      if (open) {
        if (this.env < closeThresh) open = false
      } else if (this.env > openThresh) {
        open = true
      }
      const g = open ? 1 : Math.min(1, this.env / openThresh) * 0.12
      samples[i] = x * g
    }
  }
}

function softClipGain(samples: Float32Array, gain: number): void {
  if (Math.abs(gain - 1) < 0.001) return
  for (let i = 0; i < samples.length; i++) {
    let v = (samples[i] ?? 0) * gain
    if (v > 1) v = 1
    else if (v < -1) v = -1
    samples[i] = v
  }
}

function rms(samples: Float32Array): number {
  if (!samples.length) return 0
  let s = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0
    s += v * v
  }
  return Math.sqrt(s / samples.length)
}

function toPcmBuffer(samples: Float32Array): ArrayBuffer {
  const ab = new ArrayBuffer(samples.byteLength)
  new Float32Array(ab).set(samples)
  return ab
}

export async function startCallAudio(opts: {
  ws: WebSocket
  prefs: SoftphoneAudioPrefs
  muted?: boolean
  onError?: (err: Error) => void
}): Promise<CallAudioHandles> {
  const { ws, onError } = opts
  let prefs = { ...opts.prefs }
  let muted = Boolean(opts.muted)
  let micLevel = 0
  const gate = new NoiseGate()

  const ctx = new AudioContext()
  if (ctx.state === 'suspended') await ctx.resume()

  const applySink = async (deviceId: string) => {
    if (!deviceId) return
    const anyCtx = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }
    if (typeof anyCtx.setSinkId === 'function') {
      try {
        await anyCtx.setSinkId(deviceId)
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(String(err)))
      }
    }
  }
  await applySink(prefs.speakerId)

  // Playback
  const playGain = ctx.createGain()
  playGain.gain.value = 1
  playGain.connect(ctx.destination)

  const playNode = ctx.createScriptProcessor(4096, 1, 1)
  let playBuf = new Float32Array(0)
  const playQueue: Float32Array[] = []
  playNode.onaudioprocess = (ev) => {
    const out = ev.outputBuffer.getChannelData(0)
    while (playQueue.length && playBuf.length < out.length) {
      const next = playQueue.shift()
      if (!next) break
      const merged = new Float32Array(playBuf.length + next.length)
      merged.set(playBuf)
      merged.set(next, playBuf.length)
      playBuf = merged
    }
    if (playBuf.length >= out.length) {
      out.set(playBuf.subarray(0, out.length))
      playBuf = playBuf.subarray(out.length)
    } else {
      out.fill(0)
      if (playBuf.length) {
        out.set(playBuf, 0)
        playBuf = new Float32Array(0)
      }
    }
  }
  playNode.connect(playGain)

  // Capture constraints
  const baseConstraints: MediaTrackConstraints = {
    echoCancellation: prefs.echoCancellation,
    noiseSuppression: prefs.browserNoiseSuppression,
    autoGainControl: prefs.autoGainControl,
    channelCount: 1,
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: prefs.micId ? { ...baseConstraints, deviceId: { exact: prefs.micId } } : baseConstraints,
    })
  } catch {
    stream = await navigator.mediaDevices.getUserMedia({ audio: baseConstraints })
  }

  for (const t of stream.getAudioTracks()) {
    t.enabled = !muted
  }

  const source = ctx.createMediaStreamSource(stream)
  const highpass = ctx.createBiquadFilter()
  highpass.type = 'highpass'
  highpass.frequency.value = prefs.noiseFilter ? 90 : 20
  highpass.Q.value = Math.SQRT1_2

  const micGainNode = ctx.createGain()
  micGainNode.gain.value = prefs.micGain

  const captureProc = ctx.createScriptProcessor(4096, 1, 1)
  const silentDest = ctx.createMediaStreamDestination()
  const zeroGain = ctx.createGain()
  zeroGain.gain.value = 0
  zeroGain.connect(ctx.destination)

  captureProc.onaudioprocess = (ev) => {
    if (ws.readyState !== WebSocket.OPEN) return
    if (ctx.state === 'suspended') void ctx.resume()

    const input = ev.inputBuffer.getChannelData(0)
    const framesOut = Math.max(1, Math.floor((ev.inputBuffer.length * TARGET_SR) / ctx.sampleRate))

    if (muted) {
      try {
        ws.send(toPcmBuffer(new Float32Array(framesOut)))
      } catch {
        /* */
      }
      micLevel = 0
      return
    }

    // Copy — WebAudio reuses the channel buffer every callback
    const chunk = new Float32Array(input.length)
    chunk.set(input)
    gate.process(chunk, prefs.noiseFilter)
    softClipGain(chunk, 1) // already gained in graph; keep for safety clip only

    // Peak soft-clip after noise gate
    for (let i = 0; i < chunk.length; i++) {
      const v = chunk[i] ?? 0
      if (v > 0.98) chunk[i] = 0.98
      else if (v < -0.98) chunk[i] = -0.98
    }

    micLevel = micLevel * 0.65 + rms(chunk) * 0.35

    const down = resample(chunk, ctx.sampleRate, TARGET_SR, 'down')
    try {
      ws.send(toPcmBuffer(down))
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }

  source.connect(highpass)
  highpass.connect(micGainNode)
  micGainNode.connect(captureProc)
  captureProc.connect(silentDest)
  captureProc.connect(zeroGain)

  const pushRemotePcm = (ab: ArrayBuffer) => {
    if (!ab || ab.byteLength < 4) return
    const byteLen = ab.byteLength - (ab.byteLength % 4)
    if (byteLen <= 0) return
    // Copy — avoid detached/shared buffers from WS
    const copy = ab.slice(0, byteLen)
    const f32 = new Float32Array(copy)
    const up = resample(f32, TARGET_SR, ctx.sampleRate, 'up')
    playQueue.push(up)
    let total = 0
    for (const c of playQueue) total += c.length
    while (total > ctx.sampleRate && playQueue.length > 1) {
      total -= playQueue.shift()?.length
    }
  }

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    for (const node of [captureProc, playNode, source, highpass, micGainNode, zeroGain, playGain]) {
      try {
        node.disconnect()
      } catch {
        /* */
      }
    }
    for (const t of stream.getTracks()) t.stop()
    void ctx.close().catch(() => undefined)
  }

  return {
    getMicLevel: () => micLevel,
    setMuted: (m) => {
      muted = m
      for (const t of stream.getAudioTracks()) t.enabled = !m
    },
    setPrefs: (p) => {
      prefs = { ...p }
      micGainNode.gain.value = Math.min(3, Math.max(0.2, p.micGain))
      highpass.frequency.value = p.noiseFilter ? 90 : 20
      const track = stream.getAudioTracks()[0]
      if (track) {
        void track
          .applyConstraints({
            echoCancellation: p.echoCancellation,
            noiseSuppression: p.browserNoiseSuppression,
            autoGainControl: p.autoGainControl,
          })
          .catch(() => undefined)
      }
    },
    setSpeakerId: applySink,
    pushRemotePcm,
    stop,
  }
}
