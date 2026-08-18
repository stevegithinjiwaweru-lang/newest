import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { UPLOAD_ROOT } from "./utils/uploads";

import authRoutes from "./routes/auth.routes";
import orderRoutes from "./routes/orders.routes";
import riderRoutes from "./routes/riders.routes";
import usersRoutes from "./routes/users.routes";
import shopifyRoutes from "./routes/shopify.routes";
import dispatchRoutes from "./routes/dispatch.routes";

import { handleOrdersCreate } from "./controllers/shopify.controller";
import { install, callback } from "./controllers/shopify.oauth.controller";

const app = express();

/**
 * ============================================================
 * PROXY
 * ============================================================
 *
 * Railway terminates HTTPS at its proxy.
 */
app.set("trust proxy", 1);

/**
 * ============================================================
 * SECURITY HEADERS
 * ============================================================
 */
app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy: "cross-origin",
    },
  })
);

/**
 * ============================================================
 * CORS CONFIGURATION
 * ============================================================
 */

const configuredCorsOrigins = (env.corsOrigin || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const staticCorsOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://admin.easybox.ke",
  "https://newest-a2ylc6xi8-stevegithinjiwaweru-5699s-projects.vercel.app",
];

const corsOrigins = new Set([
  ...configuredCorsOrigins,
  ...staticCorsOrigins,
]);

/**
 * Check whether a browser origin is allowed.
 */
function isAllowedCorsOrigin(origin: string): boolean {
  /**
   * Allow all origins if CORS_ORIGIN=*
   */
  if (corsOrigins.has("*")) {
    return true;
  }

  /**
   * Exact origin match.
   */
  if (corsOrigins.has(origin)) {
    return true;
  }

  /**
   * Allow Vercel preview deployments for this project.
   */
  if (
    /^https:\/\/newest-[a-z0-9]+-stevegithinjiwaweru-5699s-projects\.vercel\.app$/i.test(
      origin
    )
  ) {
    return true;
  }

  return false;
}

/**
 * CORS middleware.
 */
app.use(
  cors({
    origin: (origin, callback) => {
      /**
       * Requests without Origin are normally:
       *
       * - curl
       * - Postman
       * - server-to-server requests
       * - health checks
       * - React Native
       */
      if (!origin) {
        return callback(null, true);
      }

      if (isAllowedCorsOrigin(origin)) {
        return callback(null, true);
      }

      /**
       * Do not throw an error for unauthorized origins.
       * The browser will simply reject the response.
       */
      return callback(null, false);
    },

    credentials: true,

    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ],

    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "Origin",
      "X-Requested-With",
    ],

    exposedHeaders: [
      "Content-Length",
      "Content-Type",
    ],

    optionsSuccessStatus: 204,
  })
);

/**
 * ============================================================
 * HTTP REQUEST LOGGING
 * ============================================================
 */
app.use(morgan("dev"));

/**
 * ============================================================
 * SHOPIFY WEBHOOK
 * ============================================================
 *
 * IMPORTANT:
 *
 * Shopify HMAC verification requires the ORIGINAL raw request
 * body.
 *
 * Therefore this route MUST be registered BEFORE:
 *
 *     express.json()
 *
 * DO NOT move this route below express.json().
 */

app.post(
  "/api/shopify/webhooks/orders-create",
  express.raw({
    type: "application/json",
    limit: "2mb",
  }),
  handleOrdersCreate
);

/**
 * ============================================================
 * SHOPIFY OAUTH
 * ============================================================
 *
 * These routes use query parameters and do not require a
 * request body parser.
 */

app.get(
  "/api/shopify/install",
  install
);

app.get(
  "/api/shopify/callback",
  callback
);

/**
 * ============================================================
 * BODY PARSERS
 * ============================================================
 *
 * These are applied after the Shopify webhook route so that
 * the webhook receives the raw request body.
 */

app.use(
  express.json({
    limit: "2mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "2mb",
  })
);

/**
 * ============================================================
 * STATIC FILES
 * ============================================================
 */

app.use(
  "/uploads",
  express.static(UPLOAD_ROOT)
);

/**
 * ============================================================
 * HEALTH CHECK
 * ============================================================
 *
 * Railway can use this endpoint to verify that the backend
 * is running.
 */

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "zucchini-backend",
  });
});

/**
 * ============================================================
 * ROOT / SHOPIFY EMBEDDED ENTRY
 * ============================================================
 *
 * Shopify Admin (embedded apps / App Bridge) often loads the
 * App URL as GET /?hmac=...&host=...&session=...&shop=...&timestamp=...
 *
 * Without a handler this returns 404. We accept the request and
 * either redirect to the admin frontend or return a friendly
 * response so the install / load does not fail.
 */
app.get("/", (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop.trim().toLowerCase() : "";
  const hmac = typeof req.query.hmac === "string" ? req.query.hmac : "";
  const host = typeof req.query.host === "string" ? req.query.host : "";
  const hasShopifyParams = Boolean(
    shop || hmac || host || req.query.session || req.query.timestamp
  );

  // Prefer an explicit frontend URL for embedded / admin UX
  const frontendUrl =
    process.env.ADMIN_FRONTEND_URL ||
    process.env.FRONTEND_URL ||
    (process.env.CORS_ORIGIN || "").split(",")[0]?.trim() ||
    "https://admin.easybox.ke";

  if (hasShopifyParams && shop) {
    // Shopify is loading the app — redirect to the admin UI
    const redirectTarget = `${frontendUrl.replace(/\/$/, "")}?shop=${encodeURIComponent(shop)}`;
    return res.redirect(302, redirectTarget);
  }

  // Plain root hit (health probes, browsers, etc.)
  res.status(200).json({
    ok: true,
    service: "zucchini-backend",
    message: "Easybox API is running",
  });
});

/**
 * ============================================================
 * API ROUTES
 * ============================================================
 */

app.use(
  "/api/auth",
  authRoutes
);

app.use(
  "/api/orders",
  orderRoutes
);

app.use(
  "/api/riders",
  riderRoutes
);

app.use(
  "/api/users",
  usersRoutes
);

/**
 * ============================================================
 * MERCHANTS API REMOVED
 * ============================================================
 */

app.use(
  "/api/merchants",
  (_req, res) => {
    res.status(410).json({
      ok: false,
      message: "Merchants API removed",
    });
  }
);

/**
 * ============================================================
 * CUSTOMERS API REMOVED
 * ============================================================
 */

app.use(
  "/api/customers",
  (_req, res) => {
    res.status(410).json({
      ok: false,
      message: "Customers API removed",
    });
  }
);

/**
 * ============================================================
 * DISPATCH API
 * ============================================================
 */

app.use(
  "/api/dispatches",
  dispatchRoutes
);

/**
 * ============================================================
 * SHOPIFY NON-WEBHOOK ROUTES
 * ============================================================
 */

app.use(
  "/api/shopify",
  shopifyRoutes
);

/**
 * ============================================================
 * 404 HANDLER
 * ============================================================
 */

app.use(
  notFoundHandler
);

/**
 * ============================================================
 * GLOBAL ERROR HANDLER
 * ============================================================
 */

app.use(
  errorHandler
);

export default app;