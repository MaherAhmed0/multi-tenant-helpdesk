import argon2 from "argon2";
import { DatabaseError } from "pg";

import { db } from "../database/db.js";
import { AppError } from "../errors/app-error.js";
import { createOrganization } from "./organization.repository.js";
import { createUser } from "./user.repository.js";

import type { RegistrationInput } from "./registration.schema.js";

export async function registerOrganization(input: RegistrationInput) {
  const passwordHash = await argon2.hash(input.adminPassword, {
    type: argon2.argon2id,
  });

  try {
    return await db.transaction().execute(async (trx) => {
      const organization = await createOrganization(trx, {
        name: input.organizationName,
        slug: input.organizationSlug,
      });

      const admin = await createUser(trx, {
        organizationId: organization.id,
        name: input.adminName,
        email: input.adminEmail,
        passwordHash,
        role: "ORGANIZATION_ADMIN",
      });

      return {
        organization: {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
        },
        admin: {
          id: admin.id,
          name: admin.name,
          email: admin.email,
          role: admin.role,
        },
      };
    });
  } catch (error) {
    if (
      error instanceof DatabaseError &&
      error.code === "23505" &&
      error.constraint === "organizations_slug_unique"
    ) {
      throw new AppError(409, "Organization slug already exists");
    }

    throw error;
  }
}
