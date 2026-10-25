# papermark-railway

Container image behind the Papermark Railway template: upstream
[papermark/papermark](https://github.com/papermark/papermark) at a pinned
commit, plus the patches in `image/patches/` that make it run without
Vercel, Trigger.dev, Tinybird or Upstash.

| Patch | Why |
|---|---|
| `lib/trigger-shim/` (aliased over `@trigger.dev/sdk` and `@trigger.dev/react-hooks`) | Runs Trigger.dev tasks (PDF page rendering, notifications, exports) inside the web process |
| `lib/tinybird/pg.ts` | Page-view analytics stored in Postgres; each Tinybird pipe ported to SQL |
| `middleware.ts` | The app's own Railway domain is not treated as a customer custom domain |
| `lib/resend.ts` | Mail is sent from `EMAIL_FROM` instead of papermark.com addresses |
| `lib/auth/auth-options.ts`, login page | `ADMIN_EMAIL` + `ADMIN_PASSWORD` sign-in; QStash and Hanko optional |

Image: `ghcr.io/hmseeb/papermark-railway`. Licensed AGPL-3.0 like the
Papermark core; Papermark's `ee/` directories keep their own commercial
license and are fetched from upstream at build time.
