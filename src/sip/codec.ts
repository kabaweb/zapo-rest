/**
 * G.711 a-law / u-law codec for Float32 PCM bridge.
 *
 * WhatsApp side: Float32 LE mono @ 16 kHz
 * SIP side:      G.711 a-law or u-law @ 8 kHz (160 bytes / 20 ms RTP frame)
 *
 * Implements ITU-T G.711 with segmented computation (avoiding 64 KiB tables).
 * Reference: https://www.itu.int/rec/T-REC-G.711
 */

const SAMPLE_RATE_WHATSAPP = 16_000
const SAMPLE_RATE_SIP = 8_000

function clampInt16(v: number): number {
  if (v > 32767) return 32767
  if (v < -32768) return -32768
  return v | 0
}

function floatToInt16(f: number): number {
  return clampInt16(Math.round(f * 32767))
}

function int16ToFloat(i: number): number {
  return Math.max(-1, Math.min(1, i / 32768))
}

// ── G.711 A-law (ITU-T G.711) ─────────────────────────────────────────────────

/**
 * Encode 16-bit signed linear PCM → 8-bit a-law.
 * Reference implementation of ITU-T G.711 a-law companding.
 */
function encodeAlaw(sample: number): number {
  // Clamp to 13-bit range (a-law operates on 13-bit linear)
  let s = sample
  if (s > 32767) s = 32767
  else if (s < -32768) s = -32768

  // Sign bit (bit 7)
  const sign = s < 0 ? 0x00 : 0x80

  // Absolute value, shift to 13-bit range (drop 3 LSBs)
  let abs = s < 0 ? -s : s
  abs >>= 3

  if (abs > 4095) abs = 4095

  // Segment determination (logarithmic companding)
  let seg: number
  if (abs >= 2048) {
    seg = 7
  } else if (abs >= 1024) {
    seg = 6
  } else if (abs >= 512) {
    seg = 5
  } else if (abs >= 256) {
    seg = 4
  } else if (abs >= 128) {
    seg = 3
  } else if (abs >= 64) {
    seg = 2
  } else if (abs >= 32) {
    seg = 1
  } else {
    seg = 0
  }

  // Quantization step within segment: (abs - segment_start) / step_size
  let quant: number
  if (seg === 0) {
    quant = (abs & 0x1f) >> 0 // 2 steps per quant unit, 16 levels → 32 steps
  } else {
    const shift = seg - 1
    const segmentStart = 32 << shift // 2^(5 + shift)
    const step = 1 << shift // 2^shift
    quant = (abs - segmentStart) >> (shift + 1) // divide by step and by 2 (16 levels per segment)
  }

  const aLawByte = (sign | (seg << 4) | (quant & 0x0f)) ^ 0x55
  return aLawByte & 0xff
}

/**
 * Decode 8-bit a-law → 16-bit signed linear PCM.
 */
function decodeAlaw(aLawByte: number): number {
  let a = aLawByte ^ 0x55
  a &= 0xff

  const sign = a & 0x80 ? 1 : -1
  const seg = (a & 0x70) >> 4

  let val: number
  if (seg === 0) {
    val = ((a & 0x0f) << 1) | 1
  } else {
    val = (1 << (seg + 4)) | ((a & 0x0f) << (seg + 1))
    val |= 1 << seg
  }

  // Shift back to 16-bit range (multiply by 8 to undo the >> 3 during encode)
  return sign * (val << 3)
}

// ── G.711 μ-law (ITU-T G.711) ─────────────────────────────────────────────────

/**
 * Encode 16-bit signed linear PCM → 8-bit μ-law.
 */
function encodeUlaw(sample: number): number {
  const BIAS = 0x84

  let s = sample
  if (s > 32767) s = 32767
  else if (s < -32768) s = -32768

  const sign = s < 0 ? 0x00 : 0x80

  let abs = s < 0 ? -s : s
  abs >>= 2 // 14-bit range for μ-law

  abs += BIAS
  if (abs > 0x3fff) abs = 0x3fff

  // Segment determination
  let seg: number
  if (abs >= 0x2000) {
    seg = 7
  } else if (abs >= 0x1000) {
    seg = 6
  } else if (abs >= 0x0800) {
    seg = 5
  } else if (abs >= 0x0400) {
    seg = 4
  } else if (abs >= 0x0200) {
    seg = 3
  } else if (abs >= 0x0100) {
    seg = 2
  } else if (abs >= 0x0080) {
    seg = 1
  } else {
    seg = 0
  }

  // Quantization
  let quant: number
  if (seg === 0) {
    quant = (abs >> 1) & 0x0f
  } else {
    quant = (abs >> (seg + 1)) & 0x0f
  }

  return (sign | ((7 - seg) << 4) | (0x0f - quant)) ^ 0xff
}

/**
 * Decode 8-bit μ-law → 16-bit signed linear PCM.
 */
function decodeUlaw(uLawByte: number): number {
  let u = ~uLawByte & 0xff

  const sign = u & 0x80 ? 1 : -1
  const seg = 7 - ((u >> 4) & 0x07)
  const quant = 0x0f - (u & 0x0f)

  let val: number
  if (seg === 0) {
    val = (quant << 1) | 1
  } else {
    val = (1 << (seg + 5)) | (quant << (seg + 1))
    val |= 1 << seg
  }

  val -= 0x84 // remove bias

  // Shift back to 16-bit
  return sign * (val << 2)
}

// ── Public API ────────────────────────────────────────────────────────────────

export type G711Variant = 'alaw' | 'ulaw'

function getEncoder(variant: G711Variant) {
  return variant === 'alaw' ? encodeAlaw : encodeUlaw
}

function getDecoder(variant: G711Variant) {
  return variant === 'alaw' ? decodeAlaw : decodeUlaw
}

/**
 * Encode Float32 16kHz mono samples → G.711 RTP payload (Buffer).
 *
 * Pipeline: Float32 → Int16 → downsample 16kHz→8kHz → G.711 encode
 */
export function encodePcmToG711(samples: Float32Array, variant: G711Variant): Buffer {
  const encoder = getEncoder(variant)
  const outLen = samples.length >> 1
  const buf = Buffer.allocUnsafe(outLen)

  for (let i = 0; i < outLen; i++) {
    const left = floatToInt16(samples[i * 2] ?? 0)
    const right = floatToInt16(samples[i * 2 + 1] ?? 0)
    const avg = (left + right) >> 1
    buf[i] = encoder(avg)
  }

  return buf
}

/**
 * Decode G.711 RTP payload → Float32 16kHz mono samples.
 *
 * Pipeline: G.711 decode → Int16 8kHz → upsample 8kHz→16kHz → Float32
 */
export function decodeG711ToPcm(payload: Buffer, variant: G711Variant): Float32Array {
  const decoder = getDecoder(variant)
  const inLen = payload.length
  const outLen = inLen * 2
  const samples = new Float32Array(outLen)

  for (let i = 0; i < inLen; i++) {
    const decoded = decoder(payload[i] ?? 0)
    const f = int16ToFloat(decoded)
    const prev = i > 0 ? int16ToFloat(decoder(payload[i - 1] ?? 0)) : f
    const idx = i * 2
    // Linear interpolation: prev→current
    samples[idx] = i === 0 ? f : (prev + f) * 0.5
    samples[idx + 1] = f
  }

  return samples
}

/**
 * Convert Float32 16kHz to raw Int16 8kHz (no companding).
 * Useful when SIP side expects linear PCM.
 */
export function downsampleFloat32ToInt16(samples: Float32Array): Int16Array {
  const outLen = samples.length >> 1
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const left = floatToInt16(samples[i * 2] ?? 0)
    const right = floatToInt16(samples[i * 2 + 1] ?? 0)
    out[i] = (left + right) >> 1
  }
  return out
}

/**
 * Convert Int16 8kHz to Float32 16kHz (linear interpolation upsample).
 */
export function upsampleInt16ToFloat32(samples: Int16Array): Float32Array {
  const outLen = samples.length * 2
  const out = new Float32Array(outLen)
  for (let i = 0; i < samples.length; i++) {
    const curr = int16ToFloat(samples[i] ?? 0)
    const prev = i > 0 ? int16ToFloat(samples[i - 1] ?? 0) : curr
    const idx = i * 2
    out[idx] = i === 0 ? curr : (prev + curr) * 0.5
    out[idx + 1] = curr
  }
  return out
}

export { SAMPLE_RATE_SIP, SAMPLE_RATE_WHATSAPP }
