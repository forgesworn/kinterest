# Kinterest — one-page marketing site

Static page in the style of the Kindred site. No build step, no external
requests, no web fonts. The site is `public/`.

## Preview

    python3 -m http.server -d sites/kinterest/public 8000

then open http://localhost:8000. Check it at 375px wide (no horizontal scroll)
and at desktop width.

## Deploy

Served by Cloudflare Pages (project `kinterest`) on `kinterest.app` and
`www.kinterest.app`. A push to `main` that touches `sites/kinterest/` deploys
it automatically (`.github/workflows/deploy-site.yml`), then checks that
kinterest.app is serving the new files. The workflow can also be run by hand
from the Actions tab. To deploy from a local checkout instead:

    npx wrangler pages deploy sites/kinterest/public --project-name=kinterest --branch=main

## Files

- `public/index.html` — the page
- `public/styles.css` — copy of the Kindred site stylesheet, extended (linked as `styles.css?v=2`)
- `public/favicon.svg` — the bare Kindred flame
- `public/robots.txt`, `public/sitemap.xml` — single-page site, so the sitemap lists `https://kinterest.app/` only
