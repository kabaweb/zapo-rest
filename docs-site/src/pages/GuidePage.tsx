import { Link } from 'react-router-dom'
import { getGuidePage } from '../content/pages'
import { useLocale } from '../i18n/context'

export function GuidePage({ slug }: { slug: string }) {
  const { locale, t } = useLocale()
  const page = getGuidePage(slug, locale)
  if (!page) {
    return (
      <div className="prose-docs">
        <h1 className="mb-2 text-3xl font-bold tracking-tight">{t.pageNotFound}</h1>
        <p>
          {t.backToIntroBefore}
          <Link to="/">{t.backToIntro}</Link>
          {t.backToIntroAfter}
        </p>
      </div>
    )
  }

  return (
    <article className="prose-docs" lang={locale === 'pt-BR' ? 'pt-BR' : locale}>
      <h1 className="mb-2 text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50 sm:text-4xl">
        {page.title}
      </h1>
      {page.description ? (
        <p className="mb-8 text-lg text-zinc-500 dark:text-zinc-400">{page.description}</p>
      ) : (
        <div className="mb-8" />
      )}
      {page.body}
    </article>
  )
}
