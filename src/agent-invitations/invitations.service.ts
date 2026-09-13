import { DatabaseError } from "pg";

import { db } from "../database/db.js";
import { AppError } from "../errors/app-error.js";
import { findTeam } from "../teams/team.repository.js";
import {
  findExistingUser,
  findInvitation,
  findInvitationForUpdate,
  findOpenInvitationForUpdate,
  closeExpiredOpenInvitation,
  insertInvitation,
  listInvitations as findInvitations,
  revokeOpenInvitation,
} from "./invitation.repository.js";
import type { InvitationListInput } from "./invitation.repository.js";
import {
  generateInvitationToken,
  INVITATION_LIFETIME_MS,
} from "./invitation-token.js";

function invitationRepresentation(
  row: Awaited<ReturnType<typeof findInvitation>>,
) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    state: row.state,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    consumedAt: row.consumedAt,
    targetTeam:
      row.targetTeamId === null
        ? null
        : {
            id: row.targetTeamId,
            name: row.targetTeamName,
            isGeneral: row.targetTeamIsGeneral,
            deactivatedAt: row.targetTeamDeactivatedAt,
          },
  };
}

export async function listInvitations(
  organizationId: string,
  input: InvitationListInput,
) {
  const { invitations, total } = await findInvitations(
    db,
    organizationId,
    input,
  );
  return {
    invitations: invitations.map(invitationRepresentation),
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      totalPages: Math.ceil(total / input.limit),
    },
  };
}

export async function createInvitation(
  organizationId: string,
  input: {
    name: string;
    email: string;
    teamId?: string | undefined;
  },
) {
  const { token, tokenHash } = generateInvitationToken();
  try {
    const invitation = await db.transaction().execute(async (trx) => {
      if (await findExistingUser(trx, organizationId, input.email)) {
        throw new AppError(409, "A user with this email already exists");
      }
      const open = await findOpenInvitationForUpdate(
        trx,
        organizationId,
        input.email,
      );
      if (open) {
        if (!open.isExpired)
          throw new AppError(409, "Email already has a pending invitation");
        await closeExpiredOpenInvitation(trx, organizationId, open.id);
      }
      if (input.teamId !== undefined) {
        // Team eligibility is checked again at future acceptance; no lifecycle lock is needed here.
        const team = await findTeam(trx, organizationId, input.teamId);
        if (!team) throw new AppError(404, "Team not found");
        if (team.deactivatedAt !== null)
          throw new AppError(
            409,
            "Cannot invite an agent to a deactivated team",
          );
      }
      const createdAt = new Date();
      const inserted = await insertInvitation(trx, {
        organizationId,
        name: input.name,
        email: input.email,
        targetTeamId: input.teamId ?? null,
        tokenHash,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + INVITATION_LIFETIME_MS),
      });
      return invitationRepresentation(
        await findInvitation(trx, organizationId, inserted.id),
      );
    });
    // Release the raw credential only after the entire replacement transaction commits.
    return { invitation, token };
  } catch (error) {
    if (
      error instanceof DatabaseError &&
      error.code === "23505" &&
      error.constraint === "tenant_user_invitations_open_email_unique"
    ) {
      throw new AppError(409, "Email already has a pending invitation");
    }
    throw error;
  }
}

export async function revokeInvitation(
  organizationId: string,
  invitationId: string,
) {
  return db.transaction().execute(async (trx) => {
    const invitation = await findInvitationForUpdate(
      trx,
      organizationId,
      invitationId,
    );
    if (!invitation) throw new AppError(404, "Invitation not found");
    if (invitation.consumedAt !== null)
      throw new AppError(409, "Invitation has already been used");
    if (invitation.revokedAt === null)
      await revokeOpenInvitation(trx, organizationId, invitationId);
    return invitationRepresentation(
      await findInvitation(trx, organizationId, invitationId),
    );
  });
}
