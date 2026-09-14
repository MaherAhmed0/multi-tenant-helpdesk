import argon2 from "argon2";
import { DatabaseError } from "pg";

import { db } from "../database/db.js";
import { AppError } from "../errors/app-error.js";
import { hashInvitationToken } from "../agent-invitations/invitation-token.js";
import { findExistingUser } from "../agent-invitations/invitation.repository.js";
import { createUser } from "../organization-registration/user.repository.js";
import { findGeneralTeam, findTeamForShare } from "../teams/team.repository.js";
import {
  consumeInvitation,
  findAcceptanceOrganizationForShare,
  findInvitationByTokenHash,
  findInvitationForAcceptance,
} from "./acceptance.repository.js";
import type { AcceptanceInput } from "./acceptance.schema.js";

export interface AcceptedInvitationUser {
  id: string;
  name: string;
  email: string;
  role: "AGENT" | "ORGANIZATION_ADMIN";
  team: NonNullable<Awaited<ReturnType<typeof findTeamForShare>>> | null;
}

export async function acceptInvitation(input: AcceptanceInput): Promise<AcceptedInvitationUser> {
  const tokenHash = hashInvitationToken(input.token);
  if (!(await findInvitationByTokenHash(db, tokenHash))) {
    throw new AppError(400, "Invalid invitation token");
  }

  // Match tenant registration's Argon2id configuration without holding database locks.
  const passwordHash = await argon2.hash(input.password, {
    type: argon2.argon2id,
  });

  try {
    return await db.transaction().execute(async (trx) => {
      const invitation = await findInvitationForAcceptance(trx, tokenHash);
      if (!invitation) throw new AppError(400, "Invalid invitation token");
      if (invitation.consumedAt !== null)
        throw new AppError(409, "Invitation has already been used");
      if (invitation.revokedAt !== null)
        throw new AppError(410, "Invitation has been revoked");
      if (invitation.isExpired)
        throw new AppError(410, "Invitation has expired");

      const organizationId = invitation.organizationId;
      const organization = await findAcceptanceOrganizationForShare(
        trx,
        organizationId,
      );
      if (!organization) throw new Error("Invitation organization is missing");
      if (organization.deactivatedAt !== null)
        throw new AppError(409, "Organization is deactivated");
      if (await findExistingUser(trx, organizationId, invitation.email)) {
        throw new AppError(409, "A user with this email already exists");
      }

      let team: AcceptedInvitationUser["team"] = null;
      if (invitation.role === "AGENT") {
        if (invitation.targetTeamId !== null) {
          team = await findTeamForShare(trx, organizationId, invitation.targetTeamId) ?? null;
          if (!team) throw new Error("Invitation target team is missing");
        }
        if (!team || team.deactivatedAt !== null) {
          const general = await findGeneralTeam(trx, organizationId);
          if (!general) throw new Error("Organization General team is missing");
          team = await findTeamForShare(trx, organizationId, general.id) ?? null;
          if (!team || !team.isGeneral || team.deactivatedAt !== null) {
            throw new Error("Organization General team is invalid");
          }
        }
      } else if (invitation.role === "ORGANIZATION_ADMIN") {
        if (invitation.targetTeamId !== null) {
          throw new Error("Organization admin invitation must not have a target team");
        }
      } else {
        throw new Error("Unsupported invitation role");
      }

      const user = await createUser(trx, {
        organizationId,
        name: invitation.name,
        email: invitation.email,
        role: invitation.role,
        teamId: team?.id ?? null,
        passwordHash,
      });
      if (!(await consumeInvitation(trx, organizationId, invitation.id))) {
        // Expiry may pass while waiting on organization/team locks. Roll back the user too.
        throw new AppError(410, "Invitation is no longer available");
      }
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: invitation.role,
        team,
      };
    });
  } catch (error) {
    if (
      error instanceof DatabaseError &&
      error.code === "23505" &&
      error.constraint === "users_organization_id_email_unique"
    ) {
      throw new AppError(409, "A user with this email already exists");
    }
    throw error;
  }
}
