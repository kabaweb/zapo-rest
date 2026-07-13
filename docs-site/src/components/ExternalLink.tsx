import type { ReactNode } from 'react'

/** Full-page navigation off the SPA (Swagger, OpenAPI JSON, etc.) */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="font-medium text-brand-600 underline-offset-2 hover:underline dark:text-brand-400">
      {children}
    </a>
  )
}
