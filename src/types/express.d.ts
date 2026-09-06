import type { AuthContext } from "../auth/session-auth.service.js";

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export {};
