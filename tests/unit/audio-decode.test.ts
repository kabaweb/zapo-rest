import { describe, expect, it } from 'vitest'
import { decodeWavPcm, encodeResponseWav, TARGET_SAMPLE_RATE } from '~/voip/audio-decode'

/** Minimal 16-bit mono PCM WAV at 16 kHz with `n` silence samples. */
function makePcm16Wav(n: number, sampleRate = TARGET_SAMPLE_RATE): Buffer {
  const dataBytes = n * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataBytes, 40)
  // one non-zero sample so round-trip is meaningful
  if (n > 0) buf.writeInt16LE(16_000, 44)
  return buf
}

describe('decodeWavPcm', () => {
  it('decodes 16-bit mono 16 kHz WAV', () => {
    const wav = makePcm16Wav(4)
    const pcm = decodeWavPcm(wav)
    expect(pcm.length).toBe(4)
    expect(pcm[0]).toBeCloseTo(16_000 / 32_768, 3)
  })

  it('rejects non-RIFF / non-WAVE', () => {
    expect(() => decodeWavPcm(Buffer.alloc(44))).toThrow(/RIFF|WAVE|too small/)
    const bad = Buffer.from('RIFF....XXXX')
    expect(() => decodeWavPcm(bad)).toThrow()
  })

  it('round-trips through encodeResponseWav', () => {
    const samples = new Float32Array([0.5, -0.25, 0, 0.1])
    const wav = encodeResponseWav(samples, TARGET_SAMPLE_RATE)
    const back = decodeWavPcm(wav)
    expect(back.length).toBe(samples.length)
    for (let i = 0; i < samples.length; i++) {
      expect(back[i]).toBeCloseTo(samples[i] ?? 0, 2)
    }
  })
})
