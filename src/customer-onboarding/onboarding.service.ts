import argon2 from "argon2";
import { DatabaseError } from "pg";

import { db } from "../database/db.js";
import { AppError } from "../errors/app-error.js";
import { findExistingUser } from "../agent-invitations/invitation.repository.js";
import { createUser } from "../organization-registration/user.repository.js";
import {
  findPublicActiveOrganizationBySlug,
  findRegistrationOrganizationForShare,
} from "./organization.repository.js";
import type { CustomerRegistrationInput } from "./onboarding.schema.js";

export async function getPublicOrganization(slug: string) {
  const organization = await findPublicActiveOrganizationBySlug(db, slug);
  if (!organization) throw new AppError(404, "Support organization not found");
  return organization;
}

export async function registerCustomer(
  slug: string,
  input: CustomerRegistrationInput,
) {
  // Availability preflight only; the transaction below resolves the organization again.
  await getPublicOrganization(slug);
  const passwordHash = await argon2.hash(input.password, {
    type: argon2.argon2id,
  });

  try {
    return await db.transaction().execute(async (trx) => {
      const organization = await findRegistrationOrganizationForShare(
        trx,
        slug,
      );
      if (!organization || organization.deactivatedAt !== null) {
        throw new AppError(404, "Support organization not found");
      }
      if (await findExistingUser(trx, organization.id, input.email)) {
        throw new AppError(409, "An account with this email already exists");
      }
      const customer = await createUser(trx, {
        organizationId: organization.id,
        name: input.name,
        email: input.email,
        passwordHash,
        role: "CUSTOMER",
        teamId: null,
      });
      return {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        role: customer.role,
      };
    });
  } catch (error) {
    if (
      error instanceof DatabaseError &&
      error.code === "23505" &&
      error.constraint === "users_organization_id_email_unique"
    ) {
      throw new AppError(409, "An account with this email already exists");
    }
    throw error;
  }
}
