# Fixes applied

## 1. Shopify GET / 404
- Added `GET /` in `src/app.ts` (before `notFoundHandler`).
- Normal request → HTTP 200 JSON:
  `{ "ok": true, "service": "zucchini-backend", "message": "Easybox API is running" }`
- Shopify params (`shop`, `hmac`, `host`, `session`, `timestamp`) present + `shop` → 302 redirect to
  `ADMIN_FRONTEND_URL` || `FRONTEND_URL` || first `CORS_ORIGIN` || `https://admin.easybox.ke`
  with `?shop=...` preserved.
- No secrets exposed. Existing `/api/shopify/install` and `/api/shopify/callback` unchanged.

## 2. Production-safe seed
- `SKIP_SEED=true` → exits cleanly without seeding.
- `SEED_DEFAULT_PASSWORD` supported.
- Passwords never printed in production unless `SEED_VERBOSE=true`.
- Removed dead/unreachable code in `ensureRider`.
- Idempotent behavior preserved (existing users/riders are skipped).

## 3. Unchanged (intentionally)
- Webhook `POST /api/shopify/webhooks/orders-create` still uses `express.raw` and is registered **before** `express.json()`.
- All `/api/auth`, `/api/orders`, `/api/riders`, `/api/dispatches`, OAuth, CORS, Prisma, socket, health endpoints preserved.
- Server still binds `0.0.0.0` and uses `process.env.PORT` (via `env.port`).
