import { AsyncLocalStorage } from "node:async_hooks";

import type { TenantRole } from "../database/types.js";

export interface RequestContext {
  requestId: string;
  organizationId?: string;
  actorId?: string;
  actorRole?: TenantRole | "SYSTEM_ADMIN";
}

type RequestActor =
  | { actorId: string; actorRole: TenantRole; organizationId: string }
  | { actorId: string; actorRole: "SYSTEM_ADMIN" };

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  context: RequestContext,
  callback: () => T,
): T {
  return storage.run(context, callback);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

// Observability only: business authorization continues to use req.auth / req.systemAdminAuth.
export function setRequestActor(actor: RequestActor): void {
  const context = storage.getStore();
  if (!context) return;
  context.actorId = actor.actorId;
  context.actorRole = actor.actorRole;
  delete context.organizationId;
  if (actor.actorRole !== "SYSTEM_ADMIN")
    context.organizationId = actor.organizationId;
}
