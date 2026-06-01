# status.llm7.io

Static Vite app for the public `status.llm7.io` dashboard.

## Local development

```bash
npm install
npm run dev -- --port 4174
```

Open `http://127.0.0.1:4174/`.

By default, local development uses the Vite proxy at `/llm7-ping/ping`, which forwards to `https://api.llm7.io/ping`.

To run against local mock data instead:

```bash
VITE_LLM7_PING_ENDPOINT=/mock-ping npm run dev -- --port 4174
```

## Production

Production uses the Cloudflare Pages Function at `/api/ping`, which proxies `https://api.llm7.io/ping` from the same origin.

Build locally with:

```bash
npm run build
```

## Deploy

This repo is set up to deploy to Cloudflare Pages from GitHub Actions on every push to `main`.

Required GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Expected Cloudflare Pages project:

- Project name: `status-llm7-io`
- Build output directory: `dist`

The workflow is defined in `.github/workflows/deploy.yml` and runs:

1. `npm ci`
2. `npm run build`
3. `wrangler pages deploy dist --project-name=status-llm7-io --branch=main`
