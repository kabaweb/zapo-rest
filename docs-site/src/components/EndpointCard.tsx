import type { EndpointDoc } from '../content/endpoints'
import { buildCurl } from '../content/endpoints'
import { useLocale } from '../i18n/context'
import { CodeBlock } from './CodeBlock'
import { MethodBadge } from './MethodBadge'

function renderMarkdownish(text: string) {
  // light rendering: paragraphs split by blank lines; keep as pre-wrapped prose with code spans
  const parts = text.split(/(`[^`]+`)/g)
  return parts.map((part, i) => {
    const key = `${part.slice(0, 24)}-${i}`
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={key} className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] dark:bg-zinc-800">
          {part.slice(1, -1)}
        </code>
      )
    }
    return <span key={key}>{part}</span>
  })
}

export function EndpointCard({ ep }: { ep: EndpointDoc }) {
  const { t } = useLocale()
  const curl = buildCurl(ep)
  const isSse = ep.path === '/v1/events'
  const isWs = ep.path === '/v1/voip' || ep.path.endsWith('/stream')

  return (
    <article
      id={ep.id}
      className="scroll-mt-28 mb-10 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60"
    >
      <header className="flex flex-wrap items-start gap-3 border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
        <MethodBadge method={ep.method} />
        <div className="min-w-0 flex-1">
          <div className="break-all font-mono text-sm font-medium text-zinc-900 dark:text-zinc-50">
            {isSse ? 'SSE ' : isWs ? 'WS ' : ''}
            {ep.path}
          </div>
          <h3 className="mt-1 text-base font-semibold text-zinc-800 dark:text-zinc-100">{ep.summary}</h3>
        </div>
        <div className="flex flex-wrap gap-1">
          {ep.tags.map((t) => (
            <span
              key={t}
              className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
            >
              {t}
            </span>
          ))}
          {ep.security !== false ? (
            <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-800 dark:bg-brand-950 dark:text-brand-200">
              auth
            </span>
          ) : (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800">
              public
            </span>
          )}
        </div>
      </header>

      <div className="space-y-4 px-5 py-4">
        {ep.description ? (
          <div className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
            {renderMarkdownish(ep.description)}
          </div>
        ) : null}

        {ep.notes?.length ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-300">
            {ep.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}

        {ep.bodyExample ? (
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t.requestBody}</h4>
            <CodeBlock language="json" code={JSON.stringify(ep.bodyExample, null, 2)} />
          </div>
        ) : null}

        {ep.responseExample ? (
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t.responseExample}</h4>
            <CodeBlock language="json" code={JSON.stringify(ep.responseExample, null, 2)} />
          </div>
        ) : null}

        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t.example}</h4>
          <CodeBlock language="bash" code={curl} />
        </div>
      </div>
    </article>
  )
}
