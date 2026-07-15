/**
 * Password hashing. Uses bcrypt with cost 12 (the project floor) via Bun's
 * built-in `Bun.password`, so there is no native-module dependency to compile.
 */
const BCRYPT_COST = 12;

export function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, { algorithm: "bcrypt", cost: BCRYPT_COST });
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return Bun.password.verify(plain, hash);
}
