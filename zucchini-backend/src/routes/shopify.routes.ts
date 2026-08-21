import { Router } from "express";
import { install, callback } from "../controllers/shopify.oauth.controller";
import { getShopifyStatus, resyncWebhooks } from "../controllers/shopify.admin.controller";
import { requireAuth, requireRole } from "../middleware/auth";

/**
 * OAuth routes are also mounted explicitly in app.ts.
 * This router remains for consistency / future Shopify endpoints.
 * Webhook is mounted ONLY in app.ts with express.raw (do not add it here).
 */
const router = Router();

router.get("/install", install);
router.get("/callback", callback);

/**
 * Diagnostics: read-only report of Shopify connection + webhook
 * registration health for every connected merchant. See
 * shopify.admin.controller.ts for what this checks and why.
 */
router.get("/status", requireAuth, requireRole("ADMIN"), getShopifyStatus);

/**
 * Re-registers the orders/create webhook against this backend's
 * current public URL. Use this after a Railway URL change instead
 * of redoing full OAuth install.
 */
router.post("/resync-webhooks", requireAuth, requireRole("ADMIN"), resyncWebhooks);

export default router;
