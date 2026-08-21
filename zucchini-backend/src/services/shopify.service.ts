import { prisma } from "../lib/prisma";
import { ApiError } from "../utils/asyncHandler";
import { getIO } from "../socket";
import { OrderStatus } from "../types/enums";
import { env } from "../config/env";
import { ShopifyOrderPayload } from "../types/shopify";
import { getValidShopifyAccessToken } from "./shopify.token";

const SHOPIFY_API_VERSION = "2024-10";

function adminUrl(shopDomain: string, path: string) {
  return `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}${path}`;
}

/**
 * ============================================================
 * REGISTER SHOPIFY WEBHOOKS
 * ============================================================
 *
 * Registers the orders/create webhook using the current
 * backend URL.
 *
 * IMPORTANT:
 *
 * If an old webhook exists from a previous Railway deployment,
 * it is removed first. This prevents Shopify from continuing
 * to send orders to an old backend URL.
 *
 * Shopify signs the webhook using the app Client Secret.
 * We do NOT generate or store a random webhook secret here.
 */
export async function registerShopifyWebhooks(
  shopDomain: string,
  accessToken: string
): Promise<void> {
  const base = (
    env.publicBackendUrl ||
    env.shopifyAppUrl ||
    ""
  ).replace(/\/$/, "");

  if (!base) {
    throw new ApiError(
      500,
      "PUBLIC_BACKEND_URL or SHOPIFY_APP_URL must be set to register webhooks"
    );
  }

  const address =
    `${base}/api/shopify/webhooks/orders-create`;

  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": accessToken,
  };

  /**
   * ----------------------------------------------------------
   * 1. Get existing webhooks
   * ----------------------------------------------------------
   */
  const existingResponse = await fetch(
    adminUrl(shopDomain, "/webhooks.json"),
    {
      method: "GET",
      headers,
    }
  );

  if (!existingResponse.ok) {
    const text = await existingResponse.text();

    console.error(
      "Failed to retrieve Shopify webhooks",
      {
        shopDomain,
        status: existingResponse.status,
      }
    );

    throw new ApiError(
      400,
      `Failed to retrieve Shopify webhooks (${existingResponse.status}): ${text}`
    );
  }

  const existingData = (await existingResponse.json()) as {
    webhooks?: Array<{
      id: number;
      topic: string;
      address: string;
    }>;
  };

  const webhooks = existingData.webhooks || [];

  /**
   * ----------------------------------------------------------
   * 2. Find existing orders/create webhooks
   * ----------------------------------------------------------
   */
  const ordersCreateWebhooks = webhooks.filter(
    (webhook) => webhook.topic === "orders/create"
  );

  /**
   * ----------------------------------------------------------
   * 3. Remove old orders/create webhooks
   * ----------------------------------------------------------
   *
   * This is important when the Railway deployment URL changes.
   */
  for (const webhook of ordersCreateWebhooks) {
    const deleteResponse = await fetch(
      adminUrl(
        shopDomain,
        `/webhooks/${webhook.id}.json`
      ),
      {
        method: "DELETE",
        headers,
      }
    );

    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      const text = await deleteResponse.text();

      console.error(
        "Failed to remove old Shopify webhook",
        {
          shopDomain,
          webhookId: webhook.id,
          status: deleteResponse.status,
        }
      );

      throw new ApiError(
        400,
        `Failed to remove old Shopify webhook (${deleteResponse.status}): ${text}`
      );
    }

    console.log(
      "Removed existing Shopify orders/create webhook",
      {
        shopDomain,
        webhookId: webhook.id,
        oldAddress: webhook.address,
      }
    );
  }

  /**
   * ----------------------------------------------------------
   * 4. Register the current orders/create webhook
   * ----------------------------------------------------------
   */
  const createResponse = await fetch(
    adminUrl(shopDomain, "/webhooks.json"),
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        webhook: {
          topic: "orders/create",
          address,
          format: "json",
        },
      }),
    }
  );

  if (!createResponse.ok) {
    const text = await createResponse.text();

    console.error(
      "Failed to register Shopify webhook",
      {
        shopDomain,
        status: createResponse.status,
      }
    );

    throw new ApiError(
      400,
      `Failed to register Shopify webhook (${createResponse.status}): ${text}`
    );
  }

  const createdData = (await createResponse.json()) as {
    webhook?: {
      id?: number;
      topic?: string;
      address?: string;
    };
  };

  console.log(
    "Shopify orders/create webhook registered successfully",
    {
      shopDomain,
      webhookId: createdData.webhook?.id,
      topic: createdData.webhook?.topic,
      address: createdData.webhook?.address || address,
    }
  );
}

/**
 * ============================================================
 * GET REGISTERED SHOPIFY WEBHOOKS
 * ============================================================
 *
 * Read-only lookup used by the /api/shopify/status diagnostic
 * endpoint. Does NOT create/delete anything.
 */
export async function getRegisteredShopifyWebhooks(
  shopDomain: string,
  accessToken: string
): Promise<Array<{ id: number; topic: string; address: string }>> {
  const resp = await fetch(adminUrl(shopDomain, "/webhooks.json"), {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
  });

  if (!resp.ok) {
    throw new ApiError(
      400,
      `Failed to retrieve Shopify webhooks (${resp.status})`
    );
  }

  const data = (await resp.json()) as {
    webhooks?: Array<{ id: number; topic: string; address: string }>;
  };

  return data.webhooks || [];
}

/**
 * ============================================================
 * TEST SHOPIFY CREDENTIALS
 * ============================================================
 */
export async function testShopifyCredentials(
  shopDomain: string,
  accessToken: string
) {
  const resp = await fetch(
    adminUrl(shopDomain, "/shop.json"),
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
      },
    }
  );

  if (!resp.ok) {
    throw new ApiError(
      401,
      "Shopify credentials rejected"
    );
  }

  return resp.json();
}

/**
 * ============================================================
 * IMPORT SHOPIFY ORDER
 * ============================================================
 *
 * Maps Shopify order → Zucchini Order.
 *
 * externalId:
 *     shopify:{numericId}
 *
 * This provides stable idempotency and prevents collisions
 * with manually created ORD-* orders.
 *
 * Shopify's human-readable order number such as #1001 is
 * stored in notes.
 *
 * Manual dispatcher order numbers are not modified.
 */
export async function importShopifyOrder(
  merchantId: string,
  payload: ShopifyOrderPayload
) {
  if (
    payload == null ||
    payload.id == null
  ) {
    throw new ApiError(
      400,
      "Invalid Shopify order payload"
    );
  }

  const externalId =
    `shopify:${payload.id}`;

  /**
   * Prevent duplicate Shopify orders.
   */
  const existing = await prisma.order.findUnique({
    where: {
      externalId,
    },
  });

  if (existing) {
    return existing;
  }

  /**
   * Customer name.
   */
  const customerName =
    [
      payload.customer?.first_name,
      payload.customer?.last_name,
    ]
      .filter(Boolean)
      .join(" ")
      .trim() ||
    "Shopify Customer";

  /**
   * Customer phone.
   */
  const phone =
    (
      payload.customer?.phone ||
      payload.phone ||
      payload.shipping_address?.phone ||
      ""
    ).trim() ||
    "unknown";

  /**
   * Destination address.
   */
  const destination = [
    payload.shipping_address?.address1,
    payload.shipping_address?.address2,
    payload.shipping_address?.city,
    payload.shipping_address?.province,
    payload.shipping_address?.country,
  ]
    .filter(Boolean)
    .join(", ");

  /**
   * Pickup is not always included in a Shopify order.
   *
   * For now, use the shipping address for routing.
   */
  const address =
    destination ||
    "No address provided";

  /**
   * Order amount.
   */
  const amount =
    payload.total_price
      ? parseFloat(
          String(payload.total_price)
        )
      : 0;

  /**
   * Payment type.
   */
  const paymentType =
    payload.financial_status === "paid"
      ? "PREPAID"
      : "COD";

  /**
   * Shopify human-readable order name.
   *
   * Example:
   *
   * #1001
   */
  const shopifyName =
    payload.name ||
    String(payload.id);

  try {
    const order =
      await prisma.order.create({
        data: {
          merchantId,

          customerName,

          phone,

          address,

          destination:
            destination || null,

          pickupLat:
            payload.shipping_address?.latitude ??
            undefined,

          pickupLng:
            payload.shipping_address?.longitude ??
            undefined,

          destinationLat:
            payload.shipping_address?.latitude ??
            undefined,

          destinationLng:
            payload.shipping_address?.longitude ??
            undefined,

          amount:
            Number.isFinite(amount)
              ? amount
              : 0,

          paymentType,

          status:
            OrderStatus.NEW,

          source:
            "SHOPIFY",

          externalId,

          notes:
            `Shopify ${shopifyName}`,

          isDeleted:
            false,
        },
      });

    /**
     * Emit real-time order-created events.
     */
    const serialized = {
      ...order,
      orderNumber:
        order.externalId,
    };

    try {
      getIO()?.emit(
        "order.created",
        serialized
      );

      getIO()?.emit(
        "order:created",
        serialized
      );
    } catch {
      /**
       * Socket.IO is optional.
       *
       * Do not fail Shopify order creation if
       * Socket.IO is unavailable.
       */
    }

    return order;
  } catch (e: any) {
    /**
     * Race condition:
     *
     * Shopify can occasionally deliver the same webhook
     * more than once.
     *
     * If another request created the same externalId first,
     * return that existing order.
     */
    if (e?.code === "P2002") {
      const again =
        await prisma.order.findUnique({
          where: {
            externalId,
          },
        });

      if (again) {
        return again;
      }
    }

    throw e;
  }
}

/**
 * ============================================================
 * BACKFILL RECENT SHOPIFY ORDERS
 * ============================================================
 *
 * Manually imports recent Shopify orders.
 *
 * This operation is idempotent because importShopifyOrder()
 * checks externalId before creating an order.
 */
export async function backfillRecentOrders(
  merchant: {
    id: string;
    shopifyShopDomain: string | null;
    shopifyAccessTokenEnc: string | null;
    shopifyAccessTokenExpiresAt?: Date | null;
    shopifyRefreshTokenEnc?: string | null;
    shopifyRefreshTokenExpiresAt?: Date | null;
  }
) {
  if (
    !merchant.shopifyShopDomain ||
    !merchant.shopifyAccessTokenEnc
  ) {
    throw new ApiError(
      400,
      "Merchant is not connected to Shopify"
    );
  }

  /**
   * Obtain a valid (refreshed if needed) Shopify Admin API access token.
   */
  const accessToken = await getValidShopifyAccessToken({
    id: merchant.id,
    shopifyShopDomain: merchant.shopifyShopDomain,
    shopifyAccessTokenEnc: merchant.shopifyAccessTokenEnc,
    shopifyAccessTokenExpiresAt: merchant.shopifyAccessTokenExpiresAt ?? null,
    shopifyRefreshTokenEnc: merchant.shopifyRefreshTokenEnc ?? null,
    shopifyRefreshTokenExpiresAt: merchant.shopifyRefreshTokenExpiresAt ?? null,
  });

  /**
   * Fetch recent Shopify orders.
   */
  const resp = await fetch(
    adminUrl(
      merchant.shopifyShopDomain,
      "/orders.json?status=any&limit=50"
    ),
    {
      headers: {
        "X-Shopify-Access-Token":
          accessToken,
      },
    }
  );

  if (!resp.ok) {
    throw new ApiError(
      502,
      "Failed to fetch orders from Shopify"
    );
  }

  const data =
    (await resp.json()) as {
      orders: ShopifyOrderPayload[];
    };

  let imported = 0;

  /**
   * Import each order idempotently.
   */
  for (
    const raw of data.orders || []
  ) {
    const before =
      await prisma.order.findUnique({
        where: {
          externalId:
            `shopify:${raw.id}`,
        },
      });

    await importShopifyOrder(
      merchant.id,
      raw
    );

    if (!before) {
      imported++;
    }
  }

  return imported;
}