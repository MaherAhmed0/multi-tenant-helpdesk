import { createHash } from "node:crypto";

export function hashLoginIdentifier(organizationSlug: string, email: string): string {
  // Inputs are normalized by loginSchema; valid slugs cannot contain NUL.
  return createHash("sha256")
    .update(organizationSlug)
    .update("\0")
    .update(email)
    .digest("hex");
}
