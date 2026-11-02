-- Counter mode (fast food): branch flag + pay-first kitchen hold on orders.
-- Additive with defaults; existing branches and orders behave as before.
ALTER TABLE "branches" ADD COLUMN "counterMode" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN "kitchenHeldUntilPaid" BOOLEAN NOT NULL DEFAULT false;
