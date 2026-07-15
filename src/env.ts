/**
 * Environment configuration, validated with Zod at process startup.
 * If the config is wrong, the process crashes immediately with a clear message
 * instead of failing deep inside a request handler later.
 */
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // Local Postgres detected on :5432 as user "dapoow" with no password.
  DATABASE_URL: z.string().url().default("postgres://dapoow@localhost:5432/pos_hono"),

  // Auth. JWT_SECRET is required and must be long enough to be safe for HS256.
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters."),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().positive().max(15).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // Cookie flags. Secure must be false over plain http in local dev.
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // CORS allowlist (comma-separated). Never "*" on authenticated routes.
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
