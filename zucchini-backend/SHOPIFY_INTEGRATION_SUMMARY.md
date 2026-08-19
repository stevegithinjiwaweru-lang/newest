# Shopify Integration — Implementation Notes

## Public backend
- Production: whatever `SHOPIFY_APP_URL` / `PUBLIC_BACKEND_URL` is currently set to in Railway → Variables.
  **Do not hardcode this domain anywhere** (docs, code, or the Shopify Partner Dashboard) — Railway's
  assigned domain has changed more than once on this project, and every hardcoded copy is a place the
  integration silently breaks the next time it changes. Check the actual current value with
  `railway variables --service newest --environment production | grep -E "SHOPIFY_APP_URL|PUBLIC_BACKEND_URL"`
  and cross-check it against Settings → Networking → Public Domain for the `newest` service.
- OAuth install: `GET /api/shopify/install?shop={shop}.myshopify.com`
- OAuth callback: `GET /api/shopify/callback`
- Webhook: `POST /api/shopify/webhooks/orders-create`

## Environment variables
| Variable | Required for Shopify | Meaning |
|----------|---------------------|---------|
| SHOPIFY_CLIENT_ID | Yes | Partner app Client ID |
| SHOPIFY_CLIENT_SECRET | Yes | Partner app Client Secret (also used for webhook HMAC) |
| SHOPIFY_APP_URL | Yes | **This backend’s** current Railway public URL — NOT zucchini.co.ke. Must be updated every time Railway assigns a new domain. |
| PUBLIC_BACKEND_URL | Recommended | Same as SHOPIFY_APP_URL; used for webhook registration |
| SHOPIFY_REDIRECT_URI | Optional | Defaults to `{SHOPIFY_APP_URL}/api/shopify/callback` |
| TOKEN_ENCRYPTION_KEY | Yes | Encrypts stored Shopify access tokens |
| DATABASE_URL | Yes | Postgres |
| JWT_ACCESS_SECRET | Yes | Signs OAuth state JWT |

## Order mapping
- `externalId` = `shopify:{shopify_order_id}` (unique, idempotent)
- Manual dispatcher numbers (`ORD-…`) are never overwritten or auto-generated for Shopify imports
- Source = `SHOPIFY`

## Scopes requested
- `read_orders`
- `read_customers`

## Tests
```bash
npm run test:shopify
```
