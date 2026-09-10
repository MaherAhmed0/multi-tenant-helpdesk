import type { AuthContext } from "../auth/session-auth.service.js";
import type { SystemAdminAuthContext } from "../system-admin/auth.middleware.js";

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      systemAdminAuth?: SystemAdminAuthContext;
    }
  }
}

export {};
