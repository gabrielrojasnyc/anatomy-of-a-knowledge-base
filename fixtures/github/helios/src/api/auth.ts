import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthPrincipal } from "../types/core.js";

const TOKEN_SECRET = process.env.HELIOS_TOKEN_SECRET ?? "dev-only-secret";

interface TokenPayload {
  subject: string;
  scopes: string[];
  exp: number;
}

/** Issues a signed bearer token for a principal, valid for ttlSeconds. */
export function issueToken(
  subject: string,
  scopes: string[],
  ttlSeconds = 3600,
): string {
  const payload: TokenPayload = {
    subject,
    scopes,
    exp: Date.now() + ttlSeconds * 1000,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = sign(body);
  return `${body}.${sig}`;
}

export function verifyToken(token: string): AuthPrincipal {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new Error("malformed token");
  const expected = sign(body);
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new Error("token signature invalid");
  }
  const payload = JSON.parse(
    Buffer.from(body, "base64url").toString("utf8"),
  ) as TokenPayload;
  if (payload.exp < Date.now()) {
    throw new Error("token expired");
  }
  return {
    subject: payload.subject,
    scopes: payload.scopes,
    expiresAt: new Date(payload.exp).toISOString(),
  };
}

export function requireScope(principal: AuthPrincipal, scope: string): void {
  if (
    !principal.scopes.includes(scope) &&
    !principal.scopes.includes("admin")
  ) {
    throw new Error(
      `principal ${principal.subject} lacks required scope ${scope}`,
    );
  }
}

function sign(body: string): string {
  return createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
}
