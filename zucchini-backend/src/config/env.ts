import dotenv from "dotenv";
dotenv.config();

const isProduction = process.env.NODE_ENV === "production";

const INSECURE_DEV_DEFAULTS: Record<string, string> = {
  JWT_ACCESS_SECRET: "dev-access-secret-change-me",
  JWT_REFRESH_SECRET: "dev-refresh-secret-change-me",
  TOKEN_ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000",
};

/**
 * Secrets (JWT signing keys, token encryption key) must NEVER silently fall
 * back to a hardcoded default in production — that would mean a forgotten
 * Railway env var boots the app successfully with a guessable secret instead
 * of failing the deploy. Dev/test still get a working default so local
 * `npm run dev` works without a .env file.
 */
function requiredSecret(name: string): string {
  const val = process.env[name];
  if (val) return val;
  if (!isProduction) {
    return INSECURE_DEV_DEFAULTS[name];
  }
  throw new Error(
    `Missing required environment variable: ${name} (refusing to start in production with an insecure default — set this in Railway → Variables)`
  );
}

function required(name: string, fallback?: string): string {
  const val = process.env[name] ?? fallback;
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

export const env = {
  port: parseInt(process.env.PORT || "4000", 10),
  databaseUrl: required("DATABASE_URL", isProduction ? undefined : "file:./dev.db"),
  jwtAccessSecret: requiredSecret("JWT_ACCESS_SECRET"),
  jwtRefreshSecret: requiredSecret("JWT_REFRESH_SECRET"),
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL || "15m",
  refreshTokenTtlDays: parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || "30", 10),
  tokenEncryptionKey: requiredSecret("TOKEN_ENCRYPTION_KEY"),
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:5173",

  /**
   * Shopify App configuration.
   *
   * SHOPIFY_APP_URL / PUBLIC_BACKEND_URL:
   *   Public base URL of THIS backend (e.g. https://zucchini-backend.up.railway.app).
   *   NOT the customer storefront (https://zucchini.co.ke).
   *   Used to build OAuth redirect_uri and webhook callback URLs.
   *   On Railway you can set these to https://${{RAILWAY_PUBLIC_DOMAIN}} or paste
   *   the generated domain from Settings → Networking.
   *
   * SHOPIFY_REDIRECT_URI:
   *   Optional explicit override. Default: {SHOPIFY_APP_URL}/api/shopify/callback
   *   Must match the Allowed redirection URL in the Shopify Partner app settings.
   */
  shopifyClientId: process.env.SHOPIFY_CLIENT_ID || "",
  shopifyClientSecret: process.env.SHOPIFY_CLIENT_SECRET || "",
  shopifyAppUrl: (
    process.env.SHOPIFY_APP_URL ||
    process.env.PUBLIC_BACKEND_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : "")
  ).replace(/\/$/, ""),
  publicBackendUrl: (
    process.env.PUBLIC_BACKEND_URL ||
    process.env.SHOPIFY_APP_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : "")
  ).replace(/\/$/, ""),
  shopifyRedirectUri: process.env.SHOPIFY_REDIRECT_URI || "",
};
