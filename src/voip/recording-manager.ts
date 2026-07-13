import type { Env } from '~/config/env'
import type { InstanceRepo } from '~/instances/repo'
import { getLogger } from '~/lib/logger'
import type { MediaStorage } from '~/media/storage'
import type { CallStore } from '~/store/calls'
import { CallPcmRecorder } from './call-recorder'

export type InstanceCallConfig = {
  callRecordingEnabled: boolean
}

export class CallRecordingManager {
  private readonly log = getLogger({ component: 'call-recording' })
  private readonly active = new Map<string, CallPcmRecorder>()

  constructor(
    readonly _env: Env,
    private readonly storage: MediaStorage | null,
    private readonly calls: CallStore,
    private readonly instances: InstanceRepo,
  ) {}

  /** Storage is configured when media backend exists (local or S3). */
  storageReady(): boolean {
    return this.storage != null
  }

  async getConfig(instanceName: string): Promise<InstanceCallConfig & { storageReady: boolean }> {
    const cfg = await this.instances.getConfig(instanceName)
    return {
      callRecordingEnabled: Boolean(cfg.callRecordingEnabled),
      storageReady: this.storageReady(),
    }
  }

  async setRecordingEnabled(
    instanceName: string,
    enabled: boolean,
  ): Promise<{ callRecordingEnabled: boolean; storageReady: boolean }> {
    if (enabled && !this.storageReady()) {
      throw new Error('Call recording requires media storage (set MEDIA_STORAGE=local or s3 with S3_BUCKET).')
    }
    await this.instances.patchConfig(instanceName, { callRecordingEnabled: enabled })
    return this.getConfig(instanceName)
  }

  async isRecordingEnabled(instanceName: string): Promise<boolean> {
    if (!this.storageReady()) return false
    const cfg = await this.instances.getConfig(instanceName)
    return Boolean(cfg.callRecordingEnabled)
  }

  private key(instanceName: string, callId: string) {
    return `${instanceName}::${callId}`
  }

  async onCallStarted(
    instanceName: string,
    call: {
      callId: string
      peerJid?: string | null
      direction?: string
      mediaType?: string
      state?: string | null
    },
  ): Promise<void> {
    const recordingEnabled = await this.isRecordingEnabled(instanceName)
    await this.calls.upsertStart({
      instanceName,
      callId: call.callId,
      peerJid: call.peerJid,
      direction: call.direction,
      mediaType: call.mediaType,
      state: call.state,
      recordingEnabled,
    })

    if (!recordingEnabled || !this.storage) return
    const k = this.key(instanceName, call.callId)
    if (this.active.has(k)) return
    this.active.set(
      k,
      new CallPcmRecorder(
        call.callId,
        instanceName,
        {
          peerJid: call.peerJid,
          direction: call.direction,
        },
        this._env.CALL_RECORDING_MAX_SECONDS,
      ),
    )
    this.log.info({ instanceName, callId: call.callId }, 'recording started')
  }

  async onCallState(
    instanceName: string,
    call: { callId: string; state?: string | null; peerJid?: string | null; direction?: string },
  ): Promise<void> {
    await this.calls.updateState(instanceName, call.callId, { state: call.state ?? null })
    // Ensure recorder if call becomes active after start
    if (call.state && !['ended', 'failed', 'rejected'].includes(String(call.state))) {
      const enabled = await this.isRecordingEnabled(instanceName)
      if (enabled && this.storage) {
        const k = this.key(instanceName, call.callId)
        if (!this.active.has(k)) {
          await this.onCallStarted(instanceName, call)
        }
      }
    }
  }

  appendLocal(instanceName: string, callId: string, pcm: Float32Array): void {
    this.active.get(this.key(instanceName, callId))?.appendLocal(pcm)
  }

  appendRemote(instanceName: string, callId: string, pcm: Float32Array): void {
    this.active.get(this.key(instanceName, callId))?.appendRemote(pcm)
  }

  async onCallEnded(
    instanceName: string,
    call: { callId: string; endReason?: string | null; durationSecs?: number | null; state?: string | null },
  ): Promise<void> {
    const k = this.key(instanceName, call.callId)
    const rec = this.active.get(k)
    this.active.delete(k)

    await this.calls.markEnded(instanceName, call.callId, {
      endReason: call.endReason,
      durationSecs: call.durationSecs ?? rec?.durationSecs ?? null,
      state: call.state ?? 'ended',
    })

    if (!rec || !this.storage) {
      const row = await this.calls.get(instanceName, call.callId)
      if (row?.recordingEnabled && row.recordingStatus === 'recording') {
        await this.calls.setRecordingResult(instanceName, call.callId, {
          status: 'failed',
          error: 'no audio captured (open softphone stream to record both legs)',
        })
      }
      return
    }

    try {
      const wav = rec.finalize()
      if (!wav) {
        await this.calls.setRecordingResult(instanceName, call.callId, {
          status: 'failed',
          error: 'empty recording',
        })
        return
      }
      const stored = await this.storage.put(instanceName, wav, {
        mimeType: 'audio/wav',
        filename: `${call.callId}.wav`,
        messageId: `call-${call.callId}`,
      })
      const url =
        stored.url ??
        `/v1/instances/${encodeURIComponent(instanceName)}/calls/${encodeURIComponent(call.callId)}/recording`
      await this.calls.setRecordingResult(instanceName, call.callId, {
        status: 'ready',
        storageKey: stored.storageKey,
        url,
        mime: 'audio/wav',
        bytes: stored.sizeBytes,
      })
      this.log.info(
        { instanceName, callId: call.callId, bytes: stored.sizeBytes, key: stored.storageKey },
        'recording saved',
      )
    } catch (err) {
      this.log.warn({ err, callId: call.callId }, 'recording finalize failed')
      await this.calls.setRecordingResult(instanceName, call.callId, {
        status: 'failed',
        error: err instanceof Error ? err.message : 'recording failed',
      })
    }
  }
}
