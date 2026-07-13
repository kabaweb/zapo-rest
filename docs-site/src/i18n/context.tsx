import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { DEFAULT_LOCALE, isLocale, LOCALE_HTML_LANG, type Locale, STORAGE_KEY } from './types'
import { UI, type UiStrings } from './ui'

type LocaleContextValue = {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: UiStrings
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

function readStoredLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (isLocale(raw)) return raw
  } catch {
    /* ignore */
  }
  // Optional browser preference when nothing stored
  try {
    const langs = navigator.languages?.length ? navigator.languages : [navigator.language]
    for (const l of langs) {
      const lower = l.toLowerCase()
      if (lower.startsWith('pt')) return 'pt-BR'
      if (lower.startsWith('es')) return 'es'
      if (lower.startsWith('en')) return 'en'
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_LOCALE
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => readStoredLocale())

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = LOCALE_HTML_LANG[locale]
    const titles: Record<Locale, string> = {
      'pt-BR': 'zapo-rest · Documentação',
      en: 'zapo-rest · Documentation',
      es: 'zapo-rest · Documentación',
    }
    document.title = titles[locale]
  }, [locale])

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      t: UI[locale],
    }),
    [locale, setLocale],
  )

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error('useLocale must be used within LocaleProvider')
  return ctx
}
