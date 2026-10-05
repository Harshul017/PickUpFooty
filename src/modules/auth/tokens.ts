import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "../../lib/env.js";

export interface AccessTokenPayload {
  sub: string; // user id
  role: "PLAYER" | "ADMIN";
}

// env values are plain strings at the type level; jsonwebtoken wants its
// own narrower literal type for `expiresIn`, so we assert it here once
// rather than losing type safety on every call site.
const accessOptions: SignOptions = { expiresIn: env.JWT_ACCESS_TTL as SignOptions["expiresIn"] };
const refreshOptions: SignOptions = { expiresIn: env.JWT_REFRESH_TTL as SignOptions["expiresIn"] };

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, accessOptions);
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId, typ: "refresh" }, env.JWT_REFRESH_SECRET, refreshOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): { sub: string } {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as { sub: string };
}
