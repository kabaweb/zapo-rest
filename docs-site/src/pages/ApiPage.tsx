import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { EndpointCard } from '../components/EndpointCard'
import { ExternalLink } from '../components/ExternalLink'
import { MethodBadge } from '../components/MethodBadge'
import { ALL_ENDPOINTS, allTags, endpointsByTag } from '../content/endpoints'
import { useLocale } from '../i18n/context'

export function ApiIndexPage() {
  const { t } = useLocale()
  const [q, setQ] = useState('')
  const tags = allTags()
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return ALL_ENDPOINTS
    return ALL_ENDPOINTS.filter(
      (e) =>
        e.path.toLowerCase().includes(s) ||
        e.summary.toLowerCase().includes(s) ||
        e.description.toLowerCase().includes(s) ||
        e.method.toLowerCase().includes(s) ||
        e.tags.some((tag) => tag.toLowerCase().includes(s)),
    )
  }, [q])

  return (
    <div>
      <h1 className="mb-2 text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">{t.apiIndexTitle}</h1>
      <p className="mb-4 text-lg text-zinc-500 dark:text-zinc-400">
        {t.apiIndexLead(ALL_ENDPOINTS.length)}
        <ExternalLink href="/docs">Scalar</ExternalLink>.
      </p>

      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t.apiFilterPlaceholder}
        className="mb-6 w-full rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm outline-none ring-brand-500/30 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-900"
      />

      <div className="mb-8 flex flex-wrap gap-2">
        {tags.map((tag) => (
          <Link
            key={tag}
            to={`/api/${encodeURIComponent(tag)}`}
            className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-sm text-zinc-700 transition hover:border-brand-300 hover:text-brand-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-brand-700"
          >
            {tag}
            <span className="ml-1.5 text-xs text-zinc-400">{endpointsByTag(tag).length}</span>
          </Link>
        ))}
      </div>

      <div className="space-y-1">
        {filtered.map((ep) => (
          <Link
            key={ep.id}
            to={`/api/${encodeURIComponent(ep.tags[0] || 'Misc')}#${ep.id}`}
            className="flex items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-zinc-100 dark:hover:bg-zinc-900"
          >
            <MethodBadge method={ep.method} />
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-zinc-800 dark:text-zinc-200">
              {ep.path}
            </span>
            <span className="hidden max-w-[40%] truncate text-sm text-zinc-500 sm:block">{ep.summary}</span>
          </Link>
        ))}
      </div>
      {!filtered.length ? <p className="mt-6 text-sm text-zinc-500">{t.apiNoMatch}</p> : null}
    </div>
  )
}

export function ApiTagPage() {
  const { t } = useLocale()
  const { tag = '' } = useParams()
  const decoded = decodeURIComponent(tag)
  const list = endpointsByTag(decoded)

  if (!list.length) {
    return (
      <div>
        <h1 className="text-2xl font-bold">
          {t.apiUnknownTag}: {decoded}
        </h1>
        <p className="mt-2">
          <Link to="/api" className="text-brand-600 hover:underline">
            {t.apiBackIndex}
          </Link>
        </p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-8">
        <div className="text-xs font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-400">
          {t.apiHttpRef}
        </div>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">{decoded}</h1>
        <p className="mt-2 text-zinc-500 dark:text-zinc-400">
          {t.apiEndpointCount(list.length)} · <ExternalLink href="/docs">{t.apiOpenScalar}</ExternalLink>
        </p>
      </div>

      <div className="mb-8 space-y-1 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
        {list.map((ep) => (
          <a
            key={ep.id}
            href={`#${ep.id}`}
            className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
          >
            <MethodBadge method={ep.method} />
            <span className="font-mono text-zinc-700 dark:text-zinc-200">{ep.path}</span>
          </a>
        ))}
      </div>

      {list.map((ep) => (
        <EndpointCard key={ep.id} ep={ep} />
      ))}
    </div>
  )
}
