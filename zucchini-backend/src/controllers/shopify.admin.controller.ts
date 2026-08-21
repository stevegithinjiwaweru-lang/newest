import { Response } from "express";
import { Merchant } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { asyncHandler, ApiError } from "../utils/asyncHandler";
import { env } from "../config/env";
import { AuthedRequest } from "../middleware/auth";
import {
  getRegisteredShopifyWebhooks,
  registerShopifyWebhooks,
} from "../services/shopify.service";
import { getValidShopifyAccessToken } from "../services/shopify.token";

/**
 * ============================================================
 * GET /api/shopify/status
 * ============================================================
 *
 * Root-cause diagnostic endpoint.
 *
 * Railway/Vercel deployments change the backend's public URL over
 * time (e.g. Railway assigns a new *.up.railway.app domain when a
 * service is recreated). The orders/create webhook is only ever
 * (re)registered with Shopify during the OAuth install/callback
 * flow. If the backend's public URL changes after that — without
 * anyone re-running OAuth install — Shopify keeps sending webhooks
 * to the OLD, now-dead URL. The backend never receives them, so no
 * order is ever written to Postgres, and the frontend correctly
 * shows nothing (there's nothing to show).
 *
 * This endpoint reports, per connected merchant:
 *  - Shopify token status (connected / expiring-token missing /
 *    refresh token missing or expired)
 *  - The orders/create webhook(s) actually registered with Shopify
 *  - Whether that address matches THIS backend's current expected
 *    webhook URL
 *  - Local order counts for that merchant
 *
 * Read-only. Never mutates Shopify or the database.
 */
export const getShopifyStatus = asyncHandler(async (_req: AuthedRequest, res: Response) => {
  const expectedAddress = `${(env.publicBackendUrl || env.shopifyAppUrl || "").replace(/\/$/, "")}/api/shopify/webhooks/orders-create`;

  const merchants = await prisma.merchant.findMany({
    where: { shopifyShopDomain: { not: null } },
  });

  const results = await Promise.all(
    merchants.map(async (merchant: Merchant) => {
      const base: any = {
        merchantId: merchant.id,
        shopDomain: merchant.shopifyShopDomain,
        status: merchant.status,
        hasAccessToken: Boolean(merchant.shopifyAccessTokenEnc),
        accessTokenExpiresAt: merchant.shopifyAccessTokenExpiresAt,
        hasRefreshToken: Boolean(merchant.shopifyRefreshTokenEnc),
        refreshTokenExpiresAt: merchant.shopifyRefreshTokenExpiresAt,
        legacyNonExpiringToken:
          Boolean(merchant.shopifyAccessTokenEnc) && !merchant.shopifyAccessTokenExpiresAt,
      };

      const orderCount = await prisma.order.count({
        where: { merchantId: merchant.id, source: "SHOPIFY" },
      });
      const lastOrder = await prisma.order.findFirst({
        where: { merchantId: merchant.id, source: "SHOPIFY" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, externalId: true },
      });
      base.shopifyOrderCount = orderCount;
      base.lastShopifyOrderAt = lastOrder?.createdAt || null;
      base.lastShopifyOrderExternalId = lastOrder?.externalId || null;

      if (!merchant.shopifyShopDomain || !merchant.shopifyAccessTokenEnc) {
        base.registeredWebhooks = [];
        base.webhookAddressMatchesCurrentBackend = false;
        base.diagnosis = "Not connected — complete Shopify OAuth install.";
        return base;
      }

      try {
        const accessToken = await getValidShopifyAccessToken({
          id: merchant.id,
          shopifyShopDomain: merchant.shopifyShopDomain,
          shopifyAccessTokenEnc: merchant.shopifyAccessTokenEnc,
          shopifyAccessTokenExpiresAt: merchant.shopifyAccessTokenExpiresAt,
          shopifyRefreshTokenEnc: merchant.shopifyRefreshTokenEnc,
          shopifyRefreshTokenExpiresAt: merchant.shopifyRefreshTokenExpiresAt,
        });

        const webhooks = await getRegisteredShopifyWebhooks(merchant.shopifyShopDomain, accessToken);
        const ordersCreateHooks = webhooks.filter((w) => w.topic === "orders/create");
        base.registeredWebhooks = ordersCreateHooks;
        base.expectedWebhookAddress = expectedAddress;
        base.webhookAddressMatchesCurrentBackend = ordersCreateHooks.some(
          (w) => w.address === expectedAddress
        );

        if (ordersCreateHooks.length === 0) {
          base.diagnosis =
            "No orders/create webhook is registered with Shopify at all. Orders will never reach this backend. Call POST /api/shopify/resync-webhooks.";
        } else if (!base.webhookAddressMatchesCurrentBackend) {
          base.diagnosis = `Registered webhook points to a DIFFERENT/stale backend URL than this deployment's current URL (${expectedAddress}). This is the most common reason orders silently stop arriving after a Railway redeploy/URL change. Call POST /api/shopify/resync-webhooks to fix.`;
        } else {
          base.diagnosis = "Webhook is registered and points at this backend. Order ingestion should be working.";
        }
      } catch (e: any) {
        base.registeredWebhooks = [];
        base.webhookAddressMatchesCurrentBackend = false;
        base.diagnosis = `Could not verify webhook registration: ${e?.message || String(e)}`;
      }

      return base;
    })
  );

  res.json({
    ok: true,
    expectedWebhookAddress: expectedAddress,
    merchants: results,
  });
});

/**
 * ============================================================
 * POST /api/shopify/resync-webhooks
 * ============================================================
 *
 * Re-registers the orders/create webhook for one merchant (body:
 * { merchantId }) or ALL connected merchants (no body), pointing
 * it at THIS backend's current public URL. Removes any stale
 * webhook first (see registerShopifyWebhooks). Safe to call
 * repeatedly — idempotent.
 *
 * This does not touch OAuth tokens, does not disable HMAC
 * verification, and does not modify order data. It only fixes
 * *where* Shopify sends the webhook.
 */
export const resyncWebhooks = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const { merchantId } = req.body || {};

  const merchants = await prisma.merchant.findMany({
    where: {
      shopifyShopDomain: { not: null },
      shopifyAccessTokenEnc: { not: null },
      ...(merchantId ? { id: merchantId } : {}),
    },
  });

  if (merchants.length === 0) {
    throw new ApiError(404, "No connected Shopify merchant found to resync");
  }

  const results = [];
  for (const merchant of merchants) {
    try {
      const accessToken = await getValidShopifyAccessToken({
        id: merchant.id,
        shopifyShopDomain: merchant.shopifyShopDomain,
        shopifyAccessTokenEnc: merchant.shopifyAccessTokenEnc,
        shopifyAccessTokenExpiresAt: merchant.shopifyAccessTokenExpiresAt,
        shopifyRefreshTokenEnc: merchant.shopifyRefreshTokenEnc,
        shopifyRefreshTokenExpiresAt: merchant.shopifyRefreshTokenExpiresAt,
      });
      await registerShopifyWebhooks(merchant.shopifyShopDomain as string, accessToken);
      results.push({ merchantId: merchant.id, shopDomain: merchant.shopifyShopDomain, ok: true });
    } catch (e: any) {
      results.push({
        merchantId: merchant.id,
        shopDomain: merchant.shopifyShopDomain,
        ok: false,
        error: e?.message || String(e),
      });
    }
  }

  res.json({ ok: true, results });
});
