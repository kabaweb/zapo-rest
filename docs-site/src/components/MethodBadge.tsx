import type { HttpMethod } from '../content/endpoints'
import { cn } from '../lib/cn'

const colors: Record<HttpMethod, string> = {
  GET: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  POST: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  PUT: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
  PATCH: 'bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-300',
  DELETE: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
}

export function MethodBadge({ method, className }: { method: HttpMethod; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex min-w-[4.25rem] justify-center rounded-md px-2 py-0.5 font-mono text-[11px] font-bold tracking-wide',
        colors[method],
        className,
      )}
    >
      {method}
    </span>
  )
}
