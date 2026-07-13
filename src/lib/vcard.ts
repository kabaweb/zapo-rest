export type VCardContact = {
  fullName: string
  phoneNumber: string
  /** WhatsApp user id digits (waid); defaults to digits of phoneNumber */
  wuid?: string
  organization?: string
  email?: string
  url?: string
}

/** Build a vCard 3.0 string (-compatible). */
export function buildVCard(contact: VCardContact): string {
  const wuid = (contact.wuid ?? contact.phoneNumber).replace(/\D/g, '')
  const phone = contact.phoneNumber
  let vcard = `BEGIN:VCARD\nVERSION:3.0\nN:${escapeVCard(contact.fullName)}\nFN:${escapeVCard(contact.fullName)}\n`

  if (contact.organization) {
    vcard += `ORG:${escapeVCard(contact.organization)};\n`
  }
  if (contact.email) {
    vcard += `EMAIL:${escapeVCard(contact.email)}\n`
  }
  if (contact.url) {
    vcard += `URL:${escapeVCard(contact.url)}\n`
  }

  vcard += `item1.TEL;waid=${wuid}:${phone}\nitem1.X-ABLabel:Celular\nEND:VCARD`
  return vcard
}

function escapeVCard(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n')
}
