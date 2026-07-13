/**
 * Per-message original filename helpers.
 *
 * Storage is content-addressed (CAS) and shared across messages with the same
 * bytes. The **display/download name** is always taken from the message row
 * (`media_filename`), never from the storage key — so A can send
 * `APRESENTACAO.xlsx` and B the same bytes as `RELATORIO.xlsx`, and each
 * download keeps its own original name.
 */

/** Sanitize for Content-Disposition `filename="..."` (ASCII fallback). */
export function sanitizeFilename(name: string): string {
  // strip path segments first if a client ever sends a path
  const leaf = name.split(/[/\\]/).pop() ?? name
  const base = leaf
    .replace(/[?%*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return base.slice(0, 200) || 'file'
}

/**
 * Build Content-Disposition with ASCII + UTF-8 (RFC 5987 `filename*`).
 * @example attachment; filename="report.xlsx"; filename*=UTF-8''report.xlsx
 */
export function contentDisposition(
  filename: string | null | undefined,
  disposition: 'inline' | 'attachment' = 'inline',
): string {
  const safe = sanitizeFilename(filename?.trim() || 'file')
  // quoted-string: escape backslash and quote
  const quoted = safe.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const encoded = encodeURIComponent(safe).replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${disposition}; filename="${quoted}"; filename*=UTF-8''${encoded}`
}

/** Prefer stored original name; otherwise invent a stable fallback from mime/type. */
export function resolveDownloadFilename(opts: {
  mediaFilename?: string | null
  mimeType?: string | null
  messageType?: string | null
  messageId?: string
}): string {
  if (opts.mediaFilename?.trim()) return sanitizeFilename(opts.mediaFilename)
  const ext = extFromMime(opts.mimeType) || extFromMessageType(opts.messageType) || 'bin'
  const id = (opts.messageId ?? 'media').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'media'
  return `${id}.${ext}`
}

function extFromMime(mime?: string | null): string | null {
  if (!mime) return null
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'video/mp4': 'mp4',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/msword': 'doc',
  }
  if (map[mime]) return map[mime]
  const slash = mime.split('/')[1]
  if (slash && /^[a-z0-9.+-]+$/i.test(slash) && slash.length <= 8) {
    return slash.replace(/^\./, '')
  }
  return null
}

function extFromMessageType(type?: string | null): string | null {
  if (!type) return null
  const map: Record<string, string> = {
    image: 'jpg',
    video: 'mp4',
    audio: 'ogg',
    document: 'bin',
    sticker: 'webp',
  }
  return map[type] ?? null
}
