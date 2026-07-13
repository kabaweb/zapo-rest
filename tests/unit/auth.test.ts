import { describe, expect, it } from 'vitest'
import { type Actor, canAccessInstance, isAdmin } from '~/auth/types'

describe('auth types', () => {
  it('isAdmin', () => {
    expect(isAdmin({ role: 'admin' })).toBe(true)
    expect(isAdmin({ role: 'instance', instanceName: 'a' })).toBe(false)
  })

  it('canAccessInstance', () => {
    const admin: Actor = { role: 'admin' }
    const inst: Actor = { role: 'instance', instanceName: 'sales' }
    expect(canAccessInstance(admin, 'any')).toBe(true)
    expect(canAccessInstance(inst, 'sales')).toBe(true)
    expect(canAccessInstance(inst, 'other')).toBe(false)
  })
})
