export type InstanceStatus = 'created' | 'connecting' | 'qr' | 'pairing' | 'open' | 'close' | 'logged_out'

export type InstanceConfig = {
  callRecordingEnabled?: boolean
  [key: string]: unknown
}

export type InstanceRecord = {
  name: string
  apiKey: string
  webhookUrl: string | null
  webhookEvents: string[]
  status: InstanceStatus
  meJid: string | null
  pairPhone: string | null
  lastQr: string | null
  lastQrAt: Date | null
  config: InstanceConfig
  createdAt: Date
  updatedAt: Date
}

export type CreateInstanceInput = {
  name: string
  webhookUrl?: string | null
  webhookEvents?: string[]
  pairPhone?: string | null
}

export function toPublicInstance(row: InstanceRecord) {
  return {
    name: row.name,
    apiKey: row.apiKey,
    webhookUrl: row.webhookUrl,
    webhookEvents: row.webhookEvents,
    status: row.status,
    meJid: row.meJid,
    pairPhone: row.pairPhone,
    lastQr: row.lastQr,
    lastQrAt: row.lastQrAt?.toISOString() ?? null,
    callRecordingEnabled: Boolean(row.config?.callRecordingEnabled),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
