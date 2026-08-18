-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN IF NOT EXISTS "shopifyAccessTokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "Merchant" ADD COLUMN IF NOT EXISTS "shopifyRefreshTokenEnc" TEXT;
ALTER TABLE "Merchant" ADD COLUMN IF NOT EXISTS "shopifyRefreshTokenExpiresAt" TIMESTAMP(3);
