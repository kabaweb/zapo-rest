import { describe, expect, it } from 'vitest'
import { buildVCard } from '~/lib/vcard'

describe('buildVCard', () => {
  it('builds a single contact vcard with waid', () => {
    const v = buildVCard({
      fullName: 'Maria Silva',
      phoneNumber: '+55 11 99999-0000',
      wuid: '5511999990000',
      organization: 'Acme',
      email: 'm@acme.com',
    })
    expect(v).toContain('BEGIN:VCARD')
    expect(v).toContain('FN:Maria Silva')
    expect(v).toContain('ORG:Acme;')
    expect(v).toContain('EMAIL:m@acme.com')
    expect(v).toContain('waid=5511999990000')
    expect(v).toContain('END:VCARD')
  })
})
