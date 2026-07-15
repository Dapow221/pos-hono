/**
 * RBAC permission catalogue.
 *
 * Handlers check *permissions*, never role strings, so access rules live in one
 * place. Roles and their permission arrays are stored in the `roles` table
 * (seeded in migrate.ts); these constants are the canonical names both the
 * seed and the route guards refer to.
 */
export const PERMISSIONS = {
  PRODUCTS_READ: "products:read",
  PRODUCTS_WRITE: "products:write",
  CHECKOUT_CREATE: "checkout:create",
  REPORTS_READ: "reports:read",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Default role -> permission mapping used to seed the `roles` table. */
export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  admin: [
    PERMISSIONS.PRODUCTS_READ,
    PERMISSIONS.PRODUCTS_WRITE,
    PERMISSIONS.CHECKOUT_CREATE,
    PERMISSIONS.REPORTS_READ,
  ],
  cashier: [PERMISSIONS.PRODUCTS_READ, PERMISSIONS.CHECKOUT_CREATE],
};
