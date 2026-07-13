# zapo-rest documentation site

Rich integration guide ( SPA) served by the API at **`/guide`**.

- Narrative docs: architecture, auth, messages, webhooks, VoIP, FAQ
- Full HTTP catalog from OpenAPI + routes not yet in the export
- Dark / light mode (Tailwind v4)
- Links to Scalar at **`/docs`**

## Develop

```bash
# from repo root
pnpm dev:docs
# → http://localhost:5174/guide/
```

Proxies `/v1`, `/docs`, `/health` to the API on `:3000`.

## Build

```bash
pnpm build:docs
# or
pnpm --dir docs-site build
```

Output: `docs-site/dist`. The API (`src/app.ts`) mounts it at `/guide` when the dist exists.

## Content

| Path | Role |
|------|------|
| `src/content/pages/{pt,en,es}.tsx` | Guide articles (i18n, one module per locale) |
| `src/content/endpoints.generated.ts` | Generated from root `openapi.json` |
| `src/content/extras.ts` | Routes missing from OpenAPI export |
| `src/content/nav.ts` | Sidebar structure |

Regenerate endpoint stubs after OpenAPI changes:

```bash
# export openapi then re-run the node generator used in docs setup, or refresh openapi.json
pnpm openapi:export
```
