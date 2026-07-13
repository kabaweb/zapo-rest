export type Actor = { role: 'admin' } | { role: 'instance'; instanceName: string }

export function isAdmin(actor: Actor): boolean {
  return actor.role === 'admin'
}

export function canAccessInstance(actor: Actor, instanceName: string): boolean {
  if (actor.role === 'admin') return true
  return actor.instanceName === instanceName
}
