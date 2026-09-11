import { db } from "../../database/db.js";
import { AppError } from "../../errors/app-error.js";
import {
  deactivatePlatformOrganization,
  reactivatePlatformOrganization,
  findPlatformOrganization,
  findPlatformOrganizationAdmins,
  listPlatformOrganizations,
} from "./platform-organizations.repository.js";
import type { OrganizationListInput } from "./organizations.schema.js";
import { revokePlatformOrganizationSessions } from "./platform-organization-sessions.repository.js";

export async function deactivateOrganization(
  organizationId: string,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const organization = await deactivatePlatformOrganization(
      trx,
      organizationId,
    );
    if (!organization) throw new AppError(404, "Organization not found");
    // Run even when already inactive; both state changes must commit together.
    await revokePlatformOrganizationSessions(trx, organizationId);
  });
}

export async function reactivateOrganization(
  organizationId: string,
): Promise<void> {
  const organization = await reactivatePlatformOrganization(db, organizationId);
  if (!organization) throw new AppError(404, "Organization not found");
}

export async function revokeOrganizationSessions(
  organizationId: string,
): Promise<void> {
  await getOrganization(organizationId);
  await revokePlatformOrganizationSessions(db, organizationId);
}

export async function listOrganizations(input: OrganizationListInput) {
  const { organizations, total } = await listPlatformOrganizations(db, input);
  return {
    organizations,
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      totalPages: Math.ceil(total / input.limit),
    },
  };
}

export async function getOrganization(organizationId: string) {
  const organization = await findPlatformOrganization(db, organizationId);
  if (!organization) throw new AppError(404, "Organization not found");
  return organization;
}

export async function getOrganizationAdmins(organizationId: string) {
  await getOrganization(organizationId);
  return { admins: await findPlatformOrganizationAdmins(db, organizationId) };
}
