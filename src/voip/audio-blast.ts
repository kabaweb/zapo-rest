import type { InstanceManager } from '~/instances/manager'
import { asVoipClient } from '~/instances/wa-client'
import type { CacheClient } from '~/redis/client'
import { resolveRecipientJid } from '~/lib/phone-resolve'
import { getLogger } from '~/lib/logger'
import { downloadAndDecode, encodeResponseWav, removeTempDir } from '~/voip/audio-decode'
import type { MediaStorage } from '~/media/storage'
import { isAnsweredCallState } from '~/voip/recording-manager'
import { transcribeAudio } from '~/voip/audio-transcribe'

const TARGET_SAMPLE_RATE = 16_000

export type AudioBlastSttOpts = {
  enabled: boolean
  apiUrl: string
  apiKey: string
  model?: string
  temperature?: number
  language?: string
}

export type AudioBlastRequest = {
  manager: InstanceManager
  instanceName: string
  to: string
  audioUrl: string
  responseTimeoutMs: number
  callTimeoutMs: number
  recordResponse: boolean
  mediaStorage?: MediaStorage
  cache?: CacheClient
  stt?: AudioBlastSttOpts
}

export type AudioBlastResult = {
  callId: string
  peerJid: string
  audioPlayed: boolean
  recordingUrl: string | null
  responseDurationMs: number
  totalDurationMs: number
  transcription: string | null
  error?: string
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

async function waitForCallAnswered(
  client: ReturnType<typeof asVoipClient>,
  callId: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  const log = getLogger({ component: 'blast-wait-answer', callId })
  const deadline = Date.now() + timeoutMs

  const pending = client.voip.getCall(callId)
  if (pending && isAnsweredCallState((pending as { stateData?: { state?: string } }).stateData?.state)) {
    return true
  }

  type CallInfo = { callId?: string; stateData?: { state?: string }; isEnded?: boolean }

  return new Promise((resolve) => {
    const cleanup = () => {
      try {
        ;(client as unknown as { off: (e: string, fn: unknown) => void }).off(
          'voip_call_state',
          onState as unknown as (...args: unknown[]) => void,
        )
        ;(client as unknown as { off: (e: string, fn: unknown) => void }).off(
          'voip_call_ended',
          onEnded as unknown as (...args: unknown[]) => void,
        )
      } catch {
        /* */
      }
    }

    let resolved = false
    const done = (answered: boolean) => {
      if (resolved) return
      resolved = true
      clearInterval(timer)
      cleanup()
      resolve(answered)
    }

    const onState = (c: CallInfo) => {
      if ((c.callId ?? '').toLowerCase() !== callId.toLowerCase()) return
      if (c.isEnded) {
        log.warn({ state: c.stateData?.state }, 'call ended before answer')
        done(false)
        return
      }
      if (isAnsweredCallState(c.stateData?.state)) {
        log.info({ state: c.stateData?.state }, 'call answered')
        done(true)
      }
    }

    const onEnded = (c: CallInfo) => {
      if ((c.callId ?? '').toLowerCase() !== callId.toLowerCase()) return
      log.warn('call ended before answer')
      done(false)
    }

    ;(client as unknown as { on: (e: string, fn: unknown) => void }).on(
      'voip_call_state',
      onState as unknown as (...args: unknown[]) => void,
    )
    ;(client as unknown as { on: (e: string, fn: unknown) => void }).on(
      'voip_call_ended',
      onEnded as unknown as (...args: unknown[]) => void,
    )

    const timer = setInterval(() => {
      if (signal.aborted) {
        log.warn('blast aborted while waiting for answer')
        done(false)
        return
      }
      if (Date.now() >= deadline) {
        log.warn('call answer timeout')
        done(false)
      }
    }, 250)

    signal.addEventListener('abort', () => done(false), { once: true })
  })
}

function collectInboundAudio(
  client: ReturnType<typeof asVoipClient>,
  callId: string,
  signal: AbortSignal,
): Float32Array[] {
  const chunks: Float32Array[] = []

  // biome-ignore lint/suspicious/noExplicitAny: plugin event
  const onAudio = ({ call, pcm }: { call: any; pcm: Float32Array }) => {
    if ((call?.callId ?? '').toLowerCase() !== callId.toLowerCase()) return
    if (signal.aborted) return
    chunks.push(new Float32Array(pcm))
  }

  ;(client as unknown as { on: (e: string, fn: unknown) => void }).on(
    'voip_call_inbound_audio',
    onAudio as unknown as (...args: unknown[]) => void,
  )

  return chunks
}

async function feedAudio(
  client: ReturnType<typeof asVoipClient>,
  callId: string,
  samples: Float32Array,
  signal: AbortSignal,
): Promise<boolean> {
  const log = getLogger({ component: 'blast-feed', callId })
  const watermarks = client.voip.getFeedWatermarksMs()
  const SAFE_MS = Math.max(watermarks.resumeMs * 2, 200)
  let offset = 0

  // Phase 1 — pre-fill buffer so playback doesn't starve
  while (offset < samples.length && !signal.aborted) {
    const bufferedMs = client.voip.getLiveBufferMs(callId)
    if (bufferedMs >= SAFE_MS) break

    const neededMs = Math.max(20, SAFE_MS - Math.max(0, bufferedMs))
    const neededSamples = Math.round((neededMs / 1000) * TARGET_SAMPLE_RATE)
    const remaining = samples.length - offset
    const take = Math.min(neededSamples, remaining)
    if (take <= 0) break

    const chunk = samples.subarray(offset, offset + take)
    offset += take
    client.voip.feedLiveAudio(callId, chunk)
    await sleep(0)
  }

  log.debug({ prefillSamples: offset, bufferMs: client.voip.getLiveBufferMs(callId) }, 'pre-fill complete')

  // Phase 2 — maintain: feed when buffer has room, wait when full
  while (offset < samples.length && !signal.aborted) {
    const bufferedMs = client.voip.getLiveBufferMs(callId)

    if (bufferedMs >= watermarks.pauseMs) {
      await sleep(15)
      continue
    }

    const roomMs = Math.max(0, watermarks.pauseMs - bufferedMs)
    if (roomMs < 10) {
      await sleep(5)
      continue
    }

    const roomSamples = Math.round((roomMs / 1000) * TARGET_SAMPLE_RATE)
    const remaining = samples.length - offset
    const take = Math.min(roomSamples, remaining)
    const chunk = samples.subarray(offset, offset + take)
    offset += take
    client.voip.feedLiveAudio(callId, chunk)
    await sleep(0)
  }

  // Drain remaining buffer
  while (client.voip.getLiveBufferMs(callId) > 15 && !signal.aborted) {
    await sleep(30)
  }

  log.debug({ totalSamples: samples.length }, 'audio feed complete')
  return true
}

export async function executeAudioBlast(opts: AudioBlastRequest): Promise<AudioBlastResult> {
  const log = getLogger({ component: 'audio-blast', instance: opts.instanceName })
  const startedAt = Date.now()
  let tempDir = ''
  let callId = ''

  try {
    const { manager, instanceName, to, audioUrl, responseTimeoutMs, callTimeoutMs, recordResponse, mediaStorage, cache, stt } =
      opts

    const client = asVoipClient(manager.requireRegisteredClient(instanceName))

    log.info({ to }, 'starting blast call')
    const peerJid = await resolveRecipientJid(client, to, cache)

    const decoded = await downloadAndDecode(audioUrl)
    const { pcm } = decoded
    tempDir = decoded.tempDir
    const audioDurationMs = Math.round((pcm.length / TARGET_SAMPLE_RATE) * 1000)
    log.info({ audioDurationMs, samples: pcm.length }, 'audio ready')

    callId = await client.voip.startCall({ peerJid })
    client.voip.setExternalAudioMode(callId, true)
    log.info({ callId, peerJid }, 'call started')

    const abort = new AbortController()

    const answered = await waitForCallAnswered(client, callId, callTimeoutMs, abort.signal)
    if (!answered) {
      abort.abort()
      try {
        await client.voip.endCall(callId)
      } catch {
        /* */
      }
      return {
        callId,
        peerJid,
        audioPlayed: false,
        recordingUrl: null,
        responseDurationMs: 0,
        totalDurationMs: Date.now() - startedAt,
        transcription: null,
        error: 'call not answered',
      }
    }

    const inboundChunks = collectInboundAudio(client, callId, abort.signal)

    const played = await feedAudio(client, callId, pcm, abort.signal)
    log.info({ played }, 'audio playback finished')

    // Wait for response
    if (recordResponse && played) {
      const waitMs = responseTimeoutMs
      log.info({ waitMs }, 'waiting for response')
      await sleep(waitMs)
    }

    abort.abort()

    try {
      await client.voip.endCall(callId)
    } catch {
      /* */
    }

    // Flatten captured audio
    let totalSamples = 0
    for (const c of inboundChunks) {
      totalSamples += c.length
    }
    const merged = new Float32Array(totalSamples)
    let off = 0
    for (const c of inboundChunks) {
      merged.set(c, off)
      off += c.length
    }

    let recordingUrl: string | null = null
    let storedWav: Buffer | null = null
    if (recordResponse && totalSamples > 0 && mediaStorage) {
      try {
        storedWav = encodeResponseWav(merged, TARGET_SAMPLE_RATE)
        const stored = await mediaStorage.put(instanceName, storedWav, {
          mimeType: 'audio/wav',
          filename: `blast-${callId}.wav`,
          messageId: `blast-${callId}`,
        })
        recordingUrl =
          stored.url ?? `/v1/instances/${encodeURIComponent(instanceName)}/calls/${encodeURIComponent(callId)}/recording`
        log.info({ recordingUrl, bytes: stored.sizeBytes }, 'response recording saved')
      } catch (err) {
        log.warn({ err }, 'failed to save response recording')
      }
    }

    let transcription: string | null = null
    if (stt?.enabled && storedWav) {
      try {
        log.info('transcribing response audio')
        const result = await transcribeAudio({
          apiUrl: stt.apiUrl,
          apiKey: stt.apiKey,
          model: stt.model,
          temperature: stt.temperature,
          language: stt.language,
          audioBytes: storedWav,
          filename: `blast-${callId}.wav`,
        })
        transcription = result.text
        log.info({ text: result.text?.slice(0, 80) }, 'transcription complete')
      } catch (err) {
        log.warn({ err }, 'transcription failed')
      }
    }

    const totalMs = Date.now() - startedAt
    const responseMs = Math.round(totalSamples / TARGET_SAMPLE_RATE * 1000)

    return {
      callId,
      peerJid,
      audioPlayed: played,
      recordingUrl: totalSamples > 0 ? recordingUrl : null,
      responseDurationMs: responseMs,
      totalDurationMs: totalMs,
      transcription,
    }
  } finally {
    if (tempDir) {
      await removeTempDir(tempDir)
    }
  }
}
