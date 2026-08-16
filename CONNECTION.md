# Zucchini — Connection Inventory (Production)

Fill in the Railway domains after **Generate Domain** on each service.
All three clients (dispatcher frontend, rider app, Shopify) must point at the **same** backend base URL.

## Public endpoints (fill after deploy)

| Resource | URL |
|----------|-----|
| **Backend API base** | `https://________________.up.railway.app` |
| **Backend health** | `https://________________.up.railway.app/health` |
| **Backend Socket.IO** | `https://________________.up.railway.app` (path `/socket.io`) |
| **Static uploads** | `https://________________.up.railway.app/uploads/...` |
| **Frontend (dispatcher)** | `https://________________.up.railway.app` |
| **Shopify install** | `https://________________.up.railway.app/api/shopify/install?shop=STORE.myshopify.com` |
| **Shopify OAuth callback** | `https://________________.up.railway.app/api/shopify/callback` |
| **Shopify webhook (orders/create)** | `https://________________.up.railway.app/api/shopify/webhooks/orders-create` |

Private DB is **not** public — only `DATABASE_URL` inside Railway backend.

---

## How each client talks to the backend

```
┌─────────────────────┐     HTTPS REST + Socket.IO      ┌──────────────────────┐
│  zucchini-frontend  │ ──────────────────────────────► │  zucchini-backend    │
│  (Vite SPA / Caddy) │   VITE_API_URL=/api             │  Express + Prisma    │
│                     │   VITE_SOCKET_URL=origin        │  Socket.IO           │
└─────────────────────┘                                 │         ▲            │
                                                        │         │            │
┌─────────────────────┐     HTTPS REST (+ optional WS)  │         │            │
│  zucchini-riderapp  │ ──────────────────────────────► │         │            │
│  (Expo / EAS APK)   │   EXPO_PUBLIC_API_BASE_URL      │         │            │
│                     │   EXPO_PUBLIC_SOCKET_URL        │         │            │
└─────────────────────┘                                 └─────────┼────────────┘
                                                                  │
┌─────────────────────┐     OAuth + webhooks                      │
│  Shopify test store │ ──────────────────────────────────────────┘
└─────────────────────┘
```

### Path contract (must match)

| Client call | Backend route |
|-------------|----------------|
| `POST /api/auth/login` | Auth (admin / dispatcher / rider) |
| `POST /api/auth/rider/login` | Same login handler (alias) |
| `GET  /api/orders/mine` | Rider’s assigned orders |
| `PATCH /api/orders/:id/status` | Status transitions (rider allowed) |
| `POST /api/orders/:id/pod` | Proof-of-delivery image |
| `POST /api/riders/:id/location` | GPS update |
| `GET  /health` | Liveness |

Frontend `VITE_API_URL` **includes** `/api`.  
Rider `EXPO_PUBLIC_API_BASE_URL` is **origin only**; client appends `/api`.

---

## Railway variable checklist

### Backend service (`zucchini-backend`)

```env
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
JWT_ACCESS_SECRET=<long-random>
JWT_REFRESH_SECRET=<long-random>
TOKEN_ENCRYPTION_KEY=<64-char-hex-or-strong-secret>
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL_DAYS=30
CORS_ORIGIN=https://YOUR-FRONTEND.up.railway.app
SHOPIFY_CLIENT_ID=
SHOPIFY_CLIENT_SECRET=
SHOPIFY_APP_URL=https://YOUR-BACKEND.up.railway.app
PUBLIC_BACKEND_URL=https://YOUR-BACKEND.up.railway.app
SHOPIFY_REDIRECT_URI=https://YOUR-BACKEND.up.railway.app/api/shopify/callback
# Optional persistent POD storage:
# UPLOAD_ROOT=/data/uploads
```

### Frontend service (`zucchini-frontend`) — **build-time**

```env
VITE_API_URL=https://YOUR-BACKEND.up.railway.app/api
VITE_SOCKET_URL=https://YOUR-BACKEND.up.railway.app
```

Redeploy frontend after any change to `VITE_*`.

### Rider app (EAS secrets / `.env` before build)

```env
EXPO_PUBLIC_API_BASE_URL=https://YOUR-BACKEND.up.railway.app
EXPO_PUBLIC_SOCKET_URL=https://YOUR-BACKEND.up.railway.app
EXPO_PUBLIC_APP_ENV=production
```

Rebuild the APK after changing `EXPO_PUBLIC_*`.

---

## Smoke tests (after domains are live)

1. `curl -sS https://YOUR-BACKEND.up.railway.app/health` → `{"ok":true,...}`
2. Open frontend → login as dispatcher (`0700000002` / seed password — **change immediately**)
3. Network tab: API calls go to `YOUR-BACKEND.../api/...` (not localhost / onrender)
4. Rider APK: login as a RIDER user → `/orders/mine` returns 200
5. Assign order in dispatcher → appears on rider → status updates visible on both
6. POD photo upload → `podUrl` on order, file under `/uploads/pod/...`
7. Shopify: open install URL with test shop → OAuth completes → new order webhook creates order

---

## Local LAN tip (physical phone)

```env
# Machine IP example — same Wi‑Fi as phone
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.10:4000
EXPO_PUBLIC_SOCKET_URL=http://192.168.1.10:4000
```

Backend `CORS_ORIGIN` can stay the Vite origin for web; mobile has no Origin header and is allowed.
