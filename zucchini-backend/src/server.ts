import http from "http";
import app from "./app";
import { initSocket } from "./socket";
import { env } from "./config/env";

const server = http.createServer(app);
initSocket(server);

// Bind 0.0.0.0 so the process is reachable on Railway / containers
// (default host can be loopback-only in some environments).
const host = process.env.HOST || "0.0.0.0";

server.listen(env.port, host, () => {
  console.log(`Zucchini backend listening on http://${host}:${env.port}`);

  /**
   * ============================================================
   * SHOPIFY URL DIAGNOSTIC (startup-only, non-fatal)
   * ============================================================
   *
   * Railway's public domain has changed across deployments in this
   * project before, and SHOPIFY_APP_URL / PUBLIC_BACKEND_URL are only
   * read once at boot (see src/config/env.ts). If either was set to an
   * old Railway domain and never updated, OAuth redirect_uri and the
   * registered webhook address will silently point at a dead URL —
   * install still appears to succeed, but no orders ever sync.
   *
   * This block only logs; it never changes runtime behavior.
   */
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : null;

  console.log("Shopify URL config:", {
    SHOPIFY_APP_URL: env.shopifyAppUrl || "(unset)",
    PUBLIC_BACKEND_URL: env.publicBackendUrl || "(unset)",
    RAILWAY_PUBLIC_DOMAIN: railwayDomain || "(unset)",
  });

  if (!env.shopifyAppUrl && !env.publicBackendUrl) {
    console.warn(
      "SHOPIFY WARNING: neither SHOPIFY_APP_URL nor PUBLIC_BACKEND_URL is set, and RAILWAY_PUBLIC_DOMAIN was not available at boot. " +
        "Shopify install/OAuth/webhook registration will fail until one of these is set in Railway → Variables."
    );
  } else if (
    railwayDomain &&
    env.shopifyAppUrl &&
    env.shopifyAppUrl.replace(/\/$/, "") !== railwayDomain.replace(/\/$/, "")
  ) {
    console.warn(
      `SHOPIFY WARNING: SHOPIFY_APP_URL/PUBLIC_BACKEND_URL (${env.shopifyAppUrl}) does not match this deploy's ` +
        `RAILWAY_PUBLIC_DOMAIN (${railwayDomain}). If the Railway domain changed and this variable was not ` +
        `updated, OAuth redirects and webhook registration are pointing at the wrong host. Update SHOPIFY_APP_URL ` +
        "and PUBLIC_BACKEND_URL in Railway → Variables to match the current domain, then reinstall the app on the test store."
    );
  }
});
