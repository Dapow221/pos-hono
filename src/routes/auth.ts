/** Auth routes — thin controllers over the auth service. */
import { Hono } from "hono";
import type { Context } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { registerSchema, loginSchema } from "../schemas";
import * as authService from "../services/auth";
import type { AuthTokens, PublicUser } from "../services/auth";
import { requireAuth, type AuthEnv } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { Errors } from "../errors";
import { env } from "../env";

const REFRESH_COOKIE = "refresh_token";
const COOKIE_PATH = "/v1/auth";

const route = new Hono<AuthEnv>();

// All auth endpoints are rate-limited aggressively: 5 requests / minute / IP.
route.use("*", rateLimit({ windowMs: 60_000, max: 5 }));

function setRefreshCookie(c: Context, tokens: AuthTokens): void {
  setCookie(c, REFRESH_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "Strict",
    path: COOKIE_PATH,
    expires: tokens.refreshTokenExpiresAt,
  });
}

function authBody(user: PublicUser, tokens: AuthTokens) {
  return {
    data: {
      user,
      accessToken: tokens.accessToken,
      tokenType: "Bearer",
      expiresIn: tokens.accessTokenExpiresIn,
    },
  };
}

// POST /v1/auth/register
route.post("/register", async (c) => {
  const input = registerSchema.parse(await c.req.json().catch(() => ({})));
  const { user, tokens } = await authService.register(input);
  setRefreshCookie(c, tokens);
  return c.json(authBody(user, tokens), 201);
});

// POST /v1/auth/login
route.post("/login", async (c) => {
  const input = loginSchema.parse(await c.req.json().catch(() => ({})));
  const { user, tokens } = await authService.login(input);
  setRefreshCookie(c, tokens);
  return c.json(authBody(user, tokens), 200);
});

// POST /v1/auth/refresh — reads the httpOnly cookie, rotates the token.
route.post("/refresh", async (c) => {
  const presented = getCookie(c, REFRESH_COOKIE);
  if (!presented) throw Errors.unauthorized("Missing refresh token cookie.");
  const { user, tokens } = await authService.refresh(presented);
  setRefreshCookie(c, tokens);
  return c.json(authBody(user, tokens), 200);
});

// POST /v1/auth/logout — revokes the refresh token and clears the cookie.
route.post("/logout", async (c) => {
  const presented = getCookie(c, REFRESH_COOKIE);
  if (presented) await authService.logout(presented);
  deleteCookie(c, REFRESH_COOKIE, { path: COOKIE_PATH });
  return c.body(null, 204);
});

// GET /v1/auth/me — current user from the access token.
route.get("/me", requireAuth, (c) => {
  const u = c.get("user");
  return c.json({ data: { id: u.sub, email: u.email, role: u.role, permissions: u.permissions } });
});

export default route;
