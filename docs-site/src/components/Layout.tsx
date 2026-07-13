import { type ReactNode, useEffect, useState } from 'react'
import { useLocale } from '../i18n/context'
import { applyTheme, getPreferredTheme, type Theme, toggleTheme } from '../lib/theme'
import { LanguageSelector } from './LanguageSelector'
import { Sidebar } from './Sidebar'
import { ThemeToggle } from './ThemeToggle'

export function Layout({ children }: { children: ReactNode }) {
  const { t } = useLocale()
  // Match FOUC script in index.html to avoid wrong icon / flash
  const [theme, setTheme] = useState<Theme>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  )
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    const next = getPreferredTheme()
    applyTheme(next)
    setTheme(next)
  }, [])

  return (
    <div className="flex min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} query={query} onQuery={setQuery} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-zinc-200/80 bg-white/80 px-4 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-200 bg-white lg:hidden dark:border-zinc-700 dark:bg-zinc-900"
            onClick={() => setSidebarOpen(true)}
            aria-label={t.openMenu}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-zinc-500 dark:text-zinc-400">{t.topbarSubtitle}</div>
          </div>

          <LanguageSelector />

          <a
            href="/docs"
            className="hidden rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-800 transition hover:bg-brand-100 sm:inline-flex dark:border-brand-700 dark:bg-brand-950 dark:text-brand-200 dark:hover:bg-brand-900"
          >
            Scalar
          </a>
          <ThemeToggle
            theme={theme}
            onToggle={() => {
              setTheme((current) => toggleTheme(current))
            }}
          />
        </header>

        <main className="flex-1 px-4 py-8 sm:px-8 lg:px-12">
          <div className="mx-auto max-w-3xl">{children}</div>
        </main>

        <footer className="border-t border-zinc-200 px-6 py-6 text-center text-xs text-zinc-500 dark:border-zinc-800">
          {t.footerDocs} ·{' '}
          <a href="/docs" className="text-brand-600 hover:underline dark:text-brand-400">
            {t.footerOpenApi}
          </a>{' '}
          ·{' '}
          <a href="/docs/json" className="text-brand-600 hover:underline dark:text-brand-400">
            {t.footerJson}
          </a>
        </footer>
      </div>
    </div>
  )
}
