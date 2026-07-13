import type { ReactNode } from 'react'
import { cn } from '../lib/cn'

/** Solid surfaces with guaranteed contrast in light and dark (no translucent brand-50 traps). */
const tones = {
  info: cn(
    'border-brand-200 bg-brand-50 text-brand-950',
    'dark:border-brand-800 dark:bg-brand-950 dark:text-brand-100',
  ),
  tip: cn('border-sky-200 bg-sky-50 text-sky-950', 'dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100'),
  warn: cn('border-amber-200 bg-amber-50 text-amber-950', 'dark:border-amber-800 dark:bg-amber-950 dark:text-amber-50'),
}

export function Callout({
  title,
  children,
  tone = 'info',
}: {
  title?: string
  children: ReactNode
  tone?: keyof typeof tones
}) {
  return (
    <aside className={cn('docs-callout mb-6 rounded-xl border px-4 py-3 text-sm', tones[tone])}>
      {title ? <div className="mb-1.5 font-semibold tracking-tight">{title}</div> : null}
      <div className="opacity-95 [&_a]:font-medium [&_a]:underline [&_a]:underline-offset-2 [&_p]:mb-0 [&_ul]:mb-0">
        {children}
      </div>
    </aside>
  )
}
