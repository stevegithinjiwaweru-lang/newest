import { prisma } from "../lib/prisma";
import { encryptSecret, decryptSecret } from "../utils/crypto";
import { env } from "../config/env";
import { ApiError } from "../utils/asyncHandler";
import { ShopifyAccessTokenResponse } from "../types/shopify";

/** Refresh a few minutes before expiry to avoid edge races. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

type MerchantTokenFields = {
  id: string;
  shopifyShopDomain: string | null;
  shopifyAccessTokenEnc: string | null;
  shopifyAccessTokenExpiresAt: Date | null;
  shopifyRefreshTokenEnc: string | null;
  shopifyRefreshTokenExpiresAt: Date | null;
};

/**
 * Refresh an expiring offline access token using the stored refresh token.
 * Updates the merchant row with the new token pair.
 */
async function refreshOfflineToken(merchant: MerchantTokenFields): Promise<string> {
  const shop = merchant.shopifyShopDomain;
  if (!shop) {
    throw new ApiError(400, "Merchant has no Shopify shop domain");
  }
  if (!merchant.shopifyRefreshTokenEnc) {
    throw new ApiError(
      401,
      "Shopify access token expired and no refresh token is stored — reinstall the app (OAuth) to obtain expiring offline tokens"
    );
  }
  if (
    merchant.shopifyRefreshTokenExpiresAt &&
    merchant.shopifyRefreshTokenExpiresAt.getTime() <= Date.now()
  ) {
    throw new ApiError(
      401,
      "Shopify refresh token has expired — merchant must reopen/reinstall the app to re-authorize"
    );
  }

  const refreshToken = decryptSecret(merchant.shopifyRefreshTokenEnc);
  const tokenUrl = `https://${shop}/admin/oauth/access_token`;

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: env.shopifyClientId,
      client_secret: env.shopifyClientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!resp.ok) {
    const status = resp.status;
    // Do not log body (may contain error details that are sensitive)
    console.error("Shopify token refresh failed", { shop, status });
    if (status === 401 || status === 400) {
      throw new ApiError(
        401,
        "Shopify refresh token rejected — merchant must reinstall the app to re-authorize"
      );
    }
    throw new ApiError(502, `Failed to refresh Shopify access token (${status})`);
  }

  const body = (await resp.json()) as ShopifyAccessTokenResponse;
  if (!body.access_token) {
    throw new ApiError(502, "Shopify refresh response missing access_token");
  }

  const now = Date.now();
  const accessExpiresAt =
    typeof body.expires_in === "number" ? new Date(now + body.expires_in * 1000) : null;
  const refreshExpiresAt =
    typeof body.refresh_token_expires_in === "number"
      ? new Date(now + body.refresh_token_expires_in * 1000)
      : merchant.shopifyRefreshTokenExpiresAt;

  await prisma.merchant.update({
    where: { id: merchant.id },
    data: {
      shopifyAccessTokenEnc: encryptSecret(body.access_token),
      shopifyAccessTokenExpiresAt: accessExpiresAt,
      // Always persist the new refresh token when present (old one is one-time use)
      ...(body.refresh_token
        ? {
            shopifyRefreshTokenEnc: encryptSecret(body.refresh_token),
            shopifyRefreshTokenExpiresAt: refreshExpiresAt,
          }
        : {}),
    },
  });

  return body.access_token;
}

/**
 * Returns a valid (non-expired) Shopify offline access token for the merchant.
 * Refreshes proactively when the token is within the skew window of expiry.
 *
 * If the merchant still has a legacy non-expiring token (no expiresAt), the
 * stored token is returned as-is. Public apps must migrate to expiring tokens.
 */
export async function getValidShopifyAccessToken(
  merchant: MerchantTokenFields
): Promise<string> {
  if (!merchant.shopifyAccessTokenEnc) {
    throw new ApiError(400, "Merchant is not connected to Shopify");
  }

  const expiresAt = merchant.shopifyAccessTokenExpiresAt;
  const needsRefresh =
    expiresAt != null && expiresAt.getTime() - REFRESH_SKEW_MS <= Date.now();

  if (needsRefresh) {
    return refreshOfflineToken(merchant);
  }

  return decryptSecret(merchant.shopifyAccessTokenEnc);
}

/**
 * Load merchant by shop domain and return a valid access token.
 */
export async function getValidShopifyAccessTokenForShop(shopDomain: string): Promise<{
  merchant: MerchantTokenFields;
  accessToken: string;
}> {
  const merchant = await prisma.merchant.findFirst({
    where: { shopifyShopDomain: shopDomain.toLowerCase() },
  });
  if (!merchant) {
    throw new ApiError(404, "Shop not registered — complete OAuth install first");
  }
  const accessToken = await getValidShopifyAccessToken(merchant);
  return { merchant, accessToken };
}
