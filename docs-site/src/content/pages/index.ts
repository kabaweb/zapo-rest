import type { Locale } from '../../i18n/types'
import { GUIDE_PAGES as en } from './en'
import { GUIDE_PAGES as es } from './es'
import { GUIDE_PAGES as pt } from './pt'
import type { GuidePage } from './types'

export type { GuidePage }

const BY_LOCALE: Record<Locale, Record<string, GuidePage>> = {
  'pt-BR': pt,
  en,
  es,
}

export function getGuidePage(slug: string, locale: Locale = 'pt-BR'): GuidePage | undefined {
  return BY_LOCALE[locale][slug] ?? BY_LOCALE['pt-BR'][slug]
}
