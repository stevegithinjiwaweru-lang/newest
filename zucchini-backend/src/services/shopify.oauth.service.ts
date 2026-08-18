// zucchini-backend/src/services/shopify.oauth.service.ts
import { ApiError } from "../utils/asyncHandler";
import { getValidShopifyAccessToken } from "./shopify.token";

const SHOPIFY_API_VERSION = "2024-10";

type MerchantTokenRow = {
  id: string;
  shopifyShopDomain: string | null;
  shopifyAccessTokenEnc: string | null;
  shopifyAccessTokenExpiresAt?: Date | null;
  shopifyRefreshTokenEnc?: string | null;
  shopifyRefreshTokenExpiresAt?: Date | null;
};

/**
 * Generic Shopify Admin API request helper.
 * Resolves a valid (refreshed if needed) access token from the merchant record.
 * Throws on non-2xx responses with details.
 */
export async function shopifyRequest<T = any>(
  merchant: MerchantTokenRow,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  path = "/",
  body?: any,
  extraHeaders: Record<string, string> = {}
): Promise<T> {
  if (!merchant.shopifyShopDomain) {
    throw new ApiError(400, "Merchant has no Shopify shop domain");
  }

  const accessToken = await getValidShopifyAccessToken({
    id: merchant.id,
    shopifyShopDomain: merchant.shopifyShopDomain,
    shopifyAccessTokenEnc: merchant.shopifyAccessTokenEnc,
    shopifyAccessTokenExpiresAt: merchant.shopifyAccessTokenExpiresAt ?? null,
    shopifyRefreshTokenEnc: merchant.shopifyRefreshTokenEnc ?? null,
    shopifyRefreshTokenExpiresAt: merchant.shopifyRefreshTokenExpiresAt ?? null,
  });

  const url = `https://${merchant.shopifyShopDomain}/admin/api/${SHOPIFY_API_VERSION}${path}`;
  const opts: RequestInit = {
    method,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...extraHeaders,
    },
  };
  if (body !== undefined) {
    (opts as any).body = JSON.stringify(body);
  }

  const resp = await fetch(url, opts);
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Shopify request failed (${resp.status}): ${text}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export async function fetchShopifyOrders(merchant: MerchantTokenRow, params = "") {
  return shopifyRequest<{ orders: any[] }>(
    merchant,
    "GET",
    `/orders.json${params ? "?" + params : ""}`
  );
}

export async function registerOrdersCreateWebhook(
  merchant: MerchantTokenRow,
  callbackUrl: string
) {
  const body = {
    webhook: { topic: "orders/create", address: callbackUrl, format: "json" },
  };
  return shopifyRequest(merchant, "POST", "/webhooks.json", body);
}
