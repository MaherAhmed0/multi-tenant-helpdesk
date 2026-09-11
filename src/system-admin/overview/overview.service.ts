import { db } from "../../database/db.js";
import { countPlatformOverview } from "./platform-overview.repository.js";

export async function getPlatformOverview() {
  const counts = await countPlatformOverview(db);
  return {
    organizations: {
      total: Number(counts.organizationTotal),
      active: Number(counts.organizationActive),
      deactivated: Number(counts.organizationDeactivated),
    },
    tenantUsers: {
      total: Number(counts.userTotal),
      active: Number(counts.userActive),
      deactivated: Number(counts.userDeactivated),
      byRole: {
        ORGANIZATION_ADMIN: Number(counts.organizationAdmins),
        AGENT: Number(counts.agents),
        CUSTOMER: Number(counts.customers),
      },
    },
  };
}
