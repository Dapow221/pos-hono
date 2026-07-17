/** User routes — staff provisioning (admin) + PIN management for the cashier-switch screen. */
import { Hono } from "hono";
import { createUserSchema, setPinSchema } from "../schemas";
import { createUser, listUsers, listUsersWithPin, setUserPin } from "../services/users";
import { requirePermission, type AuthEnv } from "../middleware/auth";
import { PERMISSIONS } from "../auth/rbac";
import { Errors } from "../errors";
import { parsePagination, pageMeta } from "../pagination";

const route = new Hono<AuthEnv>();

// GET /v1/users/with-pin?limit&offset — PUBLIC: this is the lock screen's staff
// picker, shown before anyone is signed in. It only returns what a picker
// displays (name + role); emails and PIN hashes never leave the server.
route.get("/with-pin", async (c) => {
  const page = parsePagination(c.req.query(), { defaultLimit: 100 });
  const { rows, total } = await listUsersWithPin(page);
  return c.json({ data: rows, meta: pageMeta(total, page, rows.length) });
});

// GET /v1/users?limit&offset — every account, for the admin staff screen. Admin only.
route.get("/", requirePermission(PERMISSIONS.USERS_MANAGE), async (c) => {
  const page = parsePagination(c.req.query());
  const { rows, total } = await listUsers(page);
  return c.json({ data: rows, meta: pageMeta(total, page, rows.length) });
});

// POST /v1/users — admin provisions a staff account (any role, optional PIN).
// Unlike /v1/auth/register this issues NO session, so the admin stays signed in.
route.post("/", requirePermission(PERMISSIONS.USERS_MANAGE), async (c) => {
  const body = await c.req.json().catch(() => {
    throw Errors.validation("Request body must be valid JSON.");
  });
  const user = await createUser(createUserSchema.parse(body));
  c.header("Location", `/v1/users/${user.id}`);
  return c.json({ data: user }, 201);
});

// PUT /v1/users/{id}/pin — set/replace a user's PIN. Admin only (users:manage).
route.put("/:id/pin", requirePermission(PERMISSIONS.USERS_MANAGE), async (c) => {
  const { pin } = setPinSchema.parse(await c.req.json().catch(() => ({})));
  await setUserPin(c.req.param("id"), pin);
  return c.body(null, 204);
});

export default route;
