import { useLocale } from '../i18n/context'
import { LOCALE_LABELS, LOCALE_SHORT, LOCALES, type Locale } from '../i18n/types'
import { cn } from '../lib/cn'

export function LanguageSelector({ className }: { className?: string }) {
  const { locale, setLocale, t } = useLocale()

  return (
    <div className={cn('relative inline-flex', className)}>
      <label className="sr-only" htmlFor="docs-lang">
        {t.language}
      </label>
      <select
        id="docs-lang"
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        className="h-9 cursor-pointer appearance-none rounded-lg border border-zinc-200 bg-white py-1.5 pl-3 pr-8 text-sm font-medium text-zinc-800 outline-none ring-brand-500/30 transition hover:border-zinc-300 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-600"
        aria-label={t.language}
      >
        {LOCALES.map((code) => (
          <option key={code} value={code}>
            {LOCALE_SHORT[code]} · {LOCALE_LABELS[code]}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-zinc-400">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </span>
    </div>
  )
}
