import { Request, Response } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { asyncHandler, ApiError } from "../utils/asyncHandler";
import { prisma } from "../lib/prisma";
import { encryptSecret, timingSafeEqual } from "../utils/crypto";
import { registerShopifyWebhooks, backfillRecentOrders } from "../services/shopify.service";
import { ShopifyAccessTokenResponse } from "../types/shopify";

/**
 * Shopify OAuth:
 * GET /api/shopify/install?shop=xxx.myshopify.com
 * GET /api/shopify/callback?shop=&code=&state=&hmac=
 *
 * SHOPIFY_APP_URL = public backend base URL (e.g. https://zucchini-backend.up.railway.app)
 * NOT the storefront (zucchini.co.ke).
 */

function validShopDomain(shop?: string): shop is string {
  if (!shop) return false;
  return /^[a-z0-9][a-z0-9\-]*\.myshopify\.com$/i.test(shop);
}

function signState(shop: string, nonce: string) {
  return jwt.sign({ shop, nonce }, env.jwtAccessSecret, { expiresIn: "10m" });
}

function verifyStateToken(token: string) {
  return jwt.verify(token, env.jwtAccessSecret) as { shop: string; nonce: string };
}

function buildShopifyAuthUrl(shop: string, state: string) {
  const clientId = env.shopifyClientId;
  // Prefer explicit redirect URI; else derive from public backend URL
  const redirect =
    env.shopifyRedirectUri ||
    `${(env.shopifyAppUrl || env.publicBackendUrl).replace(/\/$/, "")}/api/shopify/callback`;
  const scopes = ["read_orders", "read_customers"].join(",");
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("state", state);
  return url.toString();
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** Shopify OAuth callback HMAC over sorted query params (excluding hmac). */
function verifyOAuthCallbackHmac(query: Record<string, unknown>, secret: string, hmac: string): boolean {
  if (!hmac || !secret) return false;
  const message = Object.keys(query)
    .filter((k) => k !== "hmac" && query[k] !== undefined && query[k] !== null)
    .sort()
    .map((k) => `${k}=${String(query[k])}`)
    .join("&");
  const computed = crypto.createHmac("sha256", secret).update(message).digest("hex");
  return timingSafeEqual(computed, hmac);
}

export const install = asyncHandler(async (req: Request, res: Response) => {
  const shop = String(req.query.shop || "")
    .trim()
    .toLowerCase();
  if (!validShopDomain(shop)) throw new ApiError(400, "Invalid shop parameter");

  const appBase = env.shopifyAppUrl || env.publicBackendUrl;
  if (!env.shopifyClientId || !env.shopifyClientSecret || !appBase) {
    throw new ApiError(500, "Shopify OAuth is not configured on this server");
  }

  const nonce = crypto.randomBytes(16).toString("hex");
  const stateToken = signState(shop, nonce);

  res.cookie("shopify_oauth_state", stateToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: true, // OAuth always over HTTPS in production / Shopify
    maxAge: 10 * 60 * 1000,
  });

  const redirectUrl = buildShopifyAuthUrl(shop, stateToken);
  res.redirect(302, redirectUrl);
});

export const callback = asyncHandler(async (req: Request, res: Response) => {
  const { shop, code, state, hmac } = req.query as Record<string, string | undefined>;
  if (!shop || !code || !state) throw new ApiError(400, "Missing OAuth callback parameters");
  if (!validShopDomain(shop)) throw new ApiError(400, "Invalid shop parameter");
  if (!env.shopifyClientId || !env.shopifyClientSecret) {
    throw new ApiError(500, "Shopify OAuth not configured on this server");
  }

  const cookies = parseCookies(req.headers.cookie as string | undefined);
  const stateCookie = cookies["shopify_oauth_state"];
  if (!stateCookie) throw new ApiError(400, "Missing OAuth state cookie");

  // CSRF: state query param must match the cookie we set at install
  if (!timingSafeEqual(String(state), String(stateCookie))) {
    throw new ApiError(400, "OAuth state mismatch");
  }

  try {
    const decoded = verifyStateToken(stateCookie);
    if (decoded.shop.toLowerCase() !== shop.toLowerCase()) {
      throw new ApiError(400, "OAuth state mismatch (shop)");
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(400, "Invalid or expired OAuth state token");
  }

  if (!verifyOAuthCallbackHmac(req.query as Record<string, unknown>, env.shopifyClientSecret, String(hmac || ""))) {
    throw new ApiError(400, "Invalid HMAC on OAuth callback");
  }

  // Request an *expiring* offline access token (required for public apps).
  // Without expiring=1 Shopify returns a legacy non-expiring token that the
  // Admin API rejects with 403 for new public apps.
  const tokenUrl = `https://${shop}/admin/oauth/access_token`;
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: env.shopifyClientId,
      client_secret: env.shopifyClientSecret,
      code,
      expiring: 1,
    }),
  });

  if (!resp.ok) {
    // Do not log response body (may contain sensitive details)
    console.error("Shopify token exchange failed", { shop, status: resp.status });
    throw new ApiError(502, "Failed to exchange authorization code for access token");
  }

  const tokenBody = (await resp.json()) as ShopifyAccessTokenResponse;
  if (!tokenBody.access_token) {
    throw new ApiError(502, "Shopify access token missing in response");
  }

  if (!tokenBody.refresh_token || !tokenBody.expires_in) {
    // Soft warning: some app configurations may still return non-expiring tokens.
    // Admin API calls will fail for public apps until expiring tokens are used.
    console.warn("Shopify token response missing refresh_token/expires_in — ensure the app requests expiring offline tokens", {
      shop,
      hasRefresh: Boolean(tokenBody.refresh_token),
      expiresIn: tokenBody.expires_in ?? null,
    });
  }

  // Encrypt tokens — never log access_token or refresh_token
  const encrypted = encryptSecret(tokenBody.access_token);
  const refreshEnc = tokenBody.refresh_token ? encryptSecret(tokenBody.refresh_token) : null;
  const now = Date.now();
  const accessExpiresAt =
    typeof tokenBody.expires_in === "number"
      ? new Date(now + tokenBody.expires_in * 1000)
      : null;
  const refreshExpiresAt =
    typeof tokenBody.refresh_token_expires_in === "number"
      ? new Date(now + tokenBody.refresh_token_expires_in * 1000)
      : null;

  const tokenFields = {
    shopifyAccessTokenEnc: encrypted,
    shopifyAccessTokenExpiresAt: accessExpiresAt,
    shopifyRefreshTokenEnc: refreshEnc,
    shopifyRefreshTokenExpiresAt: refreshExpiresAt,
    shopifyShopDomain: shop,
    status: "CONNECTED" as const,
  };

  let merchant = await prisma.merchant.findFirst({ where: { shopifyShopDomain: shop } });
  if (!merchant) {
    merchant = await prisma.merchant.create({
      data: {
        name: shop,
        connector: "API",
        ...tokenFields,
      },
    });
  } else {
    merchant = await prisma.merchant.update({
      where: { id: merchant.id },
      data: tokenFields,
    });
  }

  // Register orders/create webhook (best-effort; does not fail install)
  try {
    await registerShopifyWebhooks(shop, tokenBody.access_token);
  } catch (e: any) {
    console.warn("Failed to register Shopify webhooks", { shop, err: e?.message || String(e) });
  }

  /**
   * Import recent existing orders immediately on install/reconnect.
   *
   * Webhooks only cover orders created AFTER registration succeeds.
   * Without this, a merchant installing (or reconnecting after a
   * token/URL problem) would see zero Shopify orders until a brand
   * new order was placed. This is best-effort and never fails
   * install — a failed backfill just means the merchant relies on
   * the webhook going forward, or can retry via
   * POST /api/shopify/resync-webhooks.
   */
  let importedOnInstall = 0;
  try {
    importedOnInstall = await backfillRecentOrders(merchant);
  } catch (e: any) {
    console.warn("Failed to backfill recent Shopify orders on install", {
      shop,
      err: e?.message || String(e),
    });
  }

  // Clear state cookie
  res.clearCookie("shopify_oauth_state");

  res.json({
    ok: true,
    message: "Shopify app installed",
    merchant: { id: merchant.id, shop: merchant.shopifyShopDomain },
    importedOnInstall,
  });
});
