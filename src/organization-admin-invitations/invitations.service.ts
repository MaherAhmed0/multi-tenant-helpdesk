import { DatabaseError } from "pg";

import { db } from "../database/db.js";
import { AppError } from "../errors/app-error.js";
import {
  closeExpiredOpenInvitation,
  findExistingUser,
  findOpenInvitationForUpdate,
} from "../agent-invitations/invitation.repository.js";
import type { InvitationListInput } from "../agent-invitations/invitation.repository.js";
import {
  generateInvitationToken,
  INVITATION_LIFETIME_MS,
} from "../agent-invitations/invitation-token.js";
import {
  findAdminInvitation,
  findAdminInvitationForUpdate,
  insertAdminInvitation,
  listAdminInvitations as findAdminInvitations,
  revokeOpenAdminInvitation,
} from "./invitation.repository.js";

export async function listAdminInvitations(
  organizationId: string,
  input: InvitationListInput,
) {
  const { invitations, total } = await findAdminInvitations(
    db,
    organizationId,
    input,
  );
  return {
    invitations,
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      totalPages: Math.ceil(total / input.limit),
    },
  };
}

export async function createAdminInvitation(
  organizationId: string,
  input: { name: string; email: string },
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
      const createdAt = new Date();
      const inserted = await insertAdminInvitation(trx, {
        organizationId,
        name: input.name,
        email: input.email,
        tokenHash,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + INVITATION_LIFETIME_MS),
      });
      return findAdminInvitation(trx, organizationId, inserted.id);
    });
    // Only the successful, committed creation returns the raw credential.
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

export async function revokeAdminInvitation(
  organizationId: string,
  invitationId: string,
) {
  return db.transaction().execute(async (trx) => {
    const invitation = await findAdminInvitationForUpdate(
      trx,
      organizationId,
      invitationId,
    );
    if (!invitation) throw new AppError(404, "Invitation not found");
    if (invitation.consumedAt !== null)
      throw new AppError(409, "Invitation has already been used");
    if (invitation.revokedAt === null) {
      await revokeOpenAdminInvitation(trx, organizationId, invitationId);
    }
    return findAdminInvitation(trx, organizationId, invitationId);
  });
}
