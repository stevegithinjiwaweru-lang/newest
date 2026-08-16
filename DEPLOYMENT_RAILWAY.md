# Zucchini — Railway Deployment Guide

> **Connection map / env inventory:** see [`CONNECTION.md`](./CONNECTION.md) — fill in Railway domains so frontend, rider app, and Shopify all hit the same backend.

This project previously used **Render** (`render.yaml`). This guide migrates hosting to **Railway**.

| App | What it is | Where it runs on Railway |
|---|---|---|
| `zucchini-backend` | Express + Prisma + Socket.io API | Railway **Web Service** (Node) |
| `zucchini-frontend` | React/Vite dispatcher dashboard | Railway **Web Service** (static SPA via Caddy) |
| Postgres | Application database | Railway **Postgres** plugin |
| `zucchini-riderapp` | Expo/React Native rider app | **Not Railway** — builds to `.apk` via EAS |

## Architecture on Railway

One Railway **project** containing three resources:

1. **Postgres** database (plugin)
2. **zucchini-backend** service (root directory: `zucchini-backend`)
3. **zucchini-frontend** service (root directory: `zucchini-frontend`)

Services talk to each other using Railway’s private networking / public domains and variable references like `${{Postgres.DATABASE_URL}}` and `${{zucchini-backend.RAILWAY_PUBLIC_DOMAIN}}`.

## What was added for Railway

- `zucchini-backend/railway.toml` — build/start/healthcheck settings
- `zucchini-frontend/Caddyfile` — serves Vite `dist/` as an SPA (client-side routing)
- `zucchini-frontend/nixpacks.toml` — installs Caddy and runs the static server
- `zucchini-frontend/railway.toml` — service metadata
- Frontend `package.json` has a fallback `"start"` script using `serve` (Caddy is preferred)

The existing backend `start` script already runs migrations + seed on boot:

```bash
prisma migrate deploy && node dist/seed.js && node dist/server.js
```

That continues to work on Railway.

---

## Deploy steps (recommended path)

### 1. Push the repo

Push this folder structure to GitHub/GitLab/Bitbucket:

```
zucchini-backend/
zucchini-frontend/
DEPLOYMENT_RAILWAY.md
# (rider app optional / separate repo)
```

You can keep `render.yaml` in the repo for reference; Railway ignores it.

### 2. Create a Railway project

1. Go to [railway.app](https://railway.app) → **New Project**
2. Choose **Deploy from GitHub repo** and select this repository
3. Railway may auto-detect packages; you will still configure two services + Postgres manually if needed

### 3. Add Postgres

1. In the project canvas: **+ New** → **Database** → **Add PostgreSQL**
2. Name it something clear (e.g. `zucchini-db`)
3. Note: Railway provides `DATABASE_URL` (and related vars) automatically once you reference the service

### 4. Backend service

1. **+ New** → **GitHub Repo** (same repo) **or** empty service and connect the repo
2. Open the service → **Settings**:
   - **Root Directory**: `zucchini-backend`
   - **Build Command** (if not picked up from `railway.toml`):  
     `npm install --include=dev && npm run build`
   - **Start Command**: `npm start`
   - **Healthcheck Path**: `/health`
3. Generate a public domain: **Settings → Networking → Generate Domain**  
   Example: `https://zucchini-backend-production-xxxx.up.railway.app`
4. **Variables** tab — set at least:

| Variable | Value / reference |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (or your Postgres service name) |
| `JWT_ACCESS_SECRET` | long random string (or Railway “Generate”) |
| `JWT_REFRESH_SECRET` | long random string |
| `TOKEN_ENCRYPTION_KEY` | 64-char hex or strong passphrase |
| `ACCESS_TOKEN_TTL` | `15m` |
| `REFRESH_TOKEN_TTL_DAYS` | `30` |
| `CORS_ORIGIN` | `https://YOUR-FRONTEND-DOMAIN` (set after frontend is live) |
| `SHOPIFY_CLIENT_ID` | (optional, from Shopify Partner dashboard) |
| `SHOPIFY_CLIENT_SECRET` | (optional) |
| `SHOPIFY_APP_URL` | `https://YOUR-BACKEND-DOMAIN` |
| `PUBLIC_BACKEND_URL` | `https://YOUR-BACKEND-DOMAIN` |
| `SHOPIFY_REDIRECT_URI` | `https://YOUR-BACKEND-DOMAIN/api/shopify/callback` |

Railway injects `PORT` automatically — do not hardcode it.

### 5. Frontend service

1. **+ New** → same GitHub repo
2. **Settings**:
   - **Root Directory**: `zucchini-frontend`
   - Build uses `nixpacks.toml` (installs Caddy, runs `npm run build`)
   - Start command comes from `nixpacks.toml` (`caddy run ...`)
3. **Generate Domain** for the frontend
4. **Variables** (build-time for Vite):

| Variable | Value |
|---|---|
| `VITE_API_URL` | `https://YOUR-BACKEND-DOMAIN/api` |
| `VITE_SOCKET_URL` | `https://YOUR-BACKEND-DOMAIN` |

Important: Vite bakes `VITE_*` into the JS bundle at **build** time. After changing these, trigger a **redeploy** of the frontend so the new values are compiled in.

You can also use Railway references once both services exist, e.g.:

```
VITE_API_URL=https://${{zucchini-backend.RAILWAY_PUBLIC_DOMAIN}}/api
VITE_SOCKET_URL=https://${{zucchini-backend.RAILWAY_PUBLIC_DOMAIN}}
```

(Service names must match exactly what you named them in Railway.)

### 6. Close the CORS loop

1. Copy the frontend public URL
2. Set backend `CORS_ORIGIN` to that URL (exact origin, no trailing slash unless your frontend uses one)
3. Redeploy backend if it does not pick up the change automatically

### 7. First login

Seeded accounts (change immediately — see `zucchini-backend/src/seed.ts`):

- Admin: `0700000001` / `ChangeMe123!`
- Dispatcher: `0700000002` / `ChangeMe123!`

### 8. Rider app

In `zucchini-riderapp/.env` (or EAS secrets):

```
EXPO_PUBLIC_API_BASE_URL=https://YOUR-BACKEND-DOMAIN
EXPO_PUBLIC_SOCKET_URL=https://YOUR-BACKEND-DOMAIN
```

Then rebuild the APK via EAS as usual.

---

## Shopify OAuth / webhooks after migration

Update the Shopify Partner app settings:

- **App URL** / allowed redirection URLs → new Railway backend domain  
  e.g. `https://YOUR-BACKEND.up.railway.app/api/shopify/callback`
- Webhook endpoint (if configured) → same backend domain
- Keep `SHOPIFY_APP_URL`, `PUBLIC_BACKEND_URL`, and `SHOPIFY_REDIRECT_URI` in sync with the live backend URL

---

## Differences vs Render (what to expect)

| Topic | Render (previous) | Railway |
|---|---|---|
| Free tier sleep | Free web services sleep after ~15 min idle | No sleep on paid usage; hobby plans are usage-based |
| Postgres free tier | Free DB deleted after 30 days | Managed Postgres; billed by usage / plan |
| Config file | `render.yaml` Blueprint | Dashboard + optional `railway.toml` / `nixpacks.toml` |
| Static SPA | Native static site + rewrite rules | Serve with Caddy (or `serve`) from a web service |
| Variable linking | `fromDatabase` / `fromService` in YAML | `${{ServiceName.VAR}}` references |
| Uploads (`/uploads`) | Ephemeral on free tier | Still ephemeral unless you add a volume or move to S3/Cloudinary |

### Persistent POD photo uploads

Same limitation as before: local disk is ephemeral. For production:

- Attach a Railway **volume** and point `UPLOAD_ROOT` at the mount path, **or**
- Switch `podUpload` in `src/utils/uploads.ts` to S3 / Cloudinary / similar

---

## Local development (unchanged)

Backend (Postgres required):

```bash
docker run -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
cd zucchini-backend
cp .env.example .env   # edit DATABASE_URL, secrets, etc.
npm install
npm run prisma:migrate
npm run seed
npm run dev
```

Frontend:

```bash
cd zucchini-frontend
cp .env.example .env
npm install
npm run dev
```

---

## Quick checklist

- [ ] Repo pushed with `zucchini-backend` + `zucchini-frontend`
- [ ] Railway project created
- [ ] Postgres plugin added
- [ ] Backend service: Root Directory = `zucchini-backend`, health `/health`, public domain
- [ ] Backend env: `DATABASE_URL`, JWT secrets, `TOKEN_ENCRYPTION_KEY`, Shopify URLs
- [ ] Frontend service: Root Directory = `zucchini-frontend`, Caddy/nixpacks, public domain
- [ ] Frontend env: `VITE_API_URL`, `VITE_SOCKET_URL` (then redeploy)
- [ ] Backend `CORS_ORIGIN` = frontend origin
- [ ] Shopify Partner app redirect URLs updated
- [ ] Seeded passwords changed
- [ ] Rider app env pointed at new backend domain

---

## Optional: Railway CLI

```bash
npm i -g @railway/cli
railway login
railway link          # select project
railway up            # deploy from current directory (respect root if set)
railway variables     # inspect / set vars
railway logs
```

When using the CLI from a monorepo, either `cd` into the service folder or set the service’s root directory in the dashboard so only that subtree is uploaded/built.
