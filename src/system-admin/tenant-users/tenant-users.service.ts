import { db } from "../../database/db.js";
import { AppError } from "../../errors/app-error.js";
import {
  deactivatePlatformTenantUser,
  findOtherActiveOrganizationAdmin,
  findPlatformTenantUser,
  lockOrganizationForAdminDeactivation,
  lockOrganizationForUserReactivation,
  reactivatePlatformTenantUser,
} from "./platform-tenant-users.repository.js";
import { revokePlatformTenantUserSessions } from "./platform-tenant-user-sessions.repository.js";
import { clearAgentTicketAssignments } from "../../tickets/ticket-assignment.repository.js";

export async function deactivateTenantUser(userId: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    let user = await findPlatformTenantUser(trx, userId);
    if (!user) throw new AppError(404, "Tenant user not found");

    if (user.role === "ORGANIZATION_ADMIN") {
      const organization = await lockOrganizationForAdminDeactivation(
        trx,
        user.organizationId,
      );
      if (!organization) throw new AppError(404, "Organization not found");

      // After waiting for the organization lock, use new READ COMMITTED statements.
      // Every admin deactivation holds this lock until its user/session writes commit.
      user = await findPlatformTenantUser(trx, userId);
      if (!user) throw new AppError(404, "Tenant user not found");
      if (
        organization.deactivatedAt === null &&
        user.deactivatedAt === null &&
        user.role === "ORGANIZATION_ADMIN"
      ) {
        const otherAdmin = await findOtherActiveOrganizationAdmin(
          trx,
          organization.id,
          user.id,
        );
        if (!otherAdmin) {
          throw new AppError(
            409,
            "Cannot deactivate the last active organization admin",
          );
        }
      }
    }

    const deactivated = await deactivatePlatformTenantUser(
      trx,
      user.organizationId,
      user.id,
    );
    if (!deactivated) throw new AppError(404, "Tenant user not found");
    await revokePlatformTenantUserSessions(trx, user.organizationId, user.id);
    if (user.role === "AGENT") await clearAgentTicketAssignments(trx, user.organizationId, user.id);
  });
}

export async function reactivateTenantUser(userId: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const user = await findPlatformTenantUser(trx, userId);
    if (!user) throw new AppError(404, "Tenant user not found");
    // Hold parent state stable through the user UPDATE, including idempotent calls.
    const organization = await lockOrganizationForUserReactivation(
      trx,
      user.organizationId,
    );
    if (!organization) throw new AppError(404, "Organization not found");
    if (organization.deactivatedAt !== null) {
      throw new AppError(
        409,
        "Cannot reactivate a user in a deactivated organization",
      );
    }
    const reactivated = await reactivatePlatformTenantUser(
      trx,
      user.organizationId,
      user.id,
    );
    if (!reactivated) throw new AppError(404, "Tenant user not found");
  });
}

export async function revokeTenantUserSessions(userId: string): Promise<void> {
  const user = await findPlatformTenantUser(db, userId);
  if (!user) throw new AppError(404, "Tenant user not found");
  await revokePlatformTenantUserSessions(db, user.organizationId, user.id);
}
