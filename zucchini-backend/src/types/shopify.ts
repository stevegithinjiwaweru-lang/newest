export interface ShopifyAccessTokenResponse {
  access_token: string;
  scope?: string;
  /** Present when requesting expiring offline tokens (expiring=1). Typically ~3600. */
  expires_in?: number;
  /** Refresh token for rotating expiring offline access tokens. */
  refresh_token?: string;
  /** Lifetime of the refresh token in seconds (typically ~7776000 = 90 days). */
  refresh_token_expires_in?: number;
}

export interface ShopifyOrderPayload {
  id: number | string;
  name?: string; // e.g. "#1001"
  email?: string;
  customer?: {
    first_name?: string;
    last_name?: string;
    phone?: string;
    email?: string;
  };
  phone?: string;
  total_price?: string;
  financial_status?: string;
  shipping_address?: {
    address1?: string;
    address2?: string;
    city?: string;
    province?: string;
    country?: string;
    phone?: string;
    latitude?: number;
    longitude?: number;
  };
  line_items?: Array<{ title?: string; quantity?: number }>;
  created_at?: string;
}
