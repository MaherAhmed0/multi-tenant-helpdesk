import argon2 from "argon2";
import { DatabaseError } from "pg";

import { db } from "../database/db.js";
import { AppError } from "../errors/app-error.js";
import { hashInvitationToken } from "../agent-invitations/invitation-token.js";
import { findExistingUser } from "../agent-invitations/invitation.repository.js";
import { createUser } from "../organization-registration/user.repository.js";
import { findGeneralTeam, findTeamForShare } from "../teams/team.repository.js";
import {
  consumeAgentInvitation,
  findAcceptanceOrganizationForShare,
  findAgentInvitationByTokenHash,
  findAgentInvitationForAcceptance,
} from "./acceptance.repository.js";
import type { AcceptanceInput } from "./acceptance.schema.js";

export async function acceptInvitation(input: AcceptanceInput) {
  const tokenHash = hashInvitationToken(input.token);
  if (!(await findAgentInvitationByTokenHash(db, tokenHash))) {
    throw new AppError(400, "Invalid invitation token");
  }

  // Match tenant registration's Argon2id configuration without holding database locks.
  const passwordHash = await argon2.hash(input.password, {
    type: argon2.argon2id,
  });

  try {
    return await db.transaction().execute(async (trx) => {
      const invitation = await findAgentInvitationForAcceptance(trx, tokenHash);
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

      let team;
      if (invitation.targetTeamId !== null) {
        team = await findTeamForShare(
          trx,
          organizationId,
          invitation.targetTeamId,
        );
        if (!team) throw new Error("Invitation target team is missing");
      }
      if (!team || team.deactivatedAt !== null) {
        const general = await findGeneralTeam(trx, organizationId);
        if (!general) throw new Error("Organization General team is missing");
        team = await findTeamForShare(trx, organizationId, general.id);
        if (!team || !team.isGeneral || team.deactivatedAt !== null) {
          throw new Error("Organization General team is invalid");
        }
      }

      const user = await createUser(trx, {
        organizationId,
        name: invitation.name,
        email: invitation.email,
        role: "AGENT",
        teamId: team.id,
        passwordHash,
      });
      if (!(await consumeAgentInvitation(trx, organizationId, invitation.id))) {
        // Expiry may pass while waiting on organization/team locks. Roll back the user too.
        throw new AppError(410, "Invitation is no longer available");
      }
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
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
