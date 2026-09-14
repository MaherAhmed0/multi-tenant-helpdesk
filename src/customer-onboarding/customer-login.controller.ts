import type { Request, Response } from "express";

import { login } from "../auth/login/login.service.js";
import {
  getSessionCookieOptions,
  SESSION_COOKIE_NAME,
} from "../auth/sessions/session-cookie.js";
import { AppError } from "../errors/app-error.js";
import { customerLoginSchema } from "./customer-login.schema.js";
import { publicOrganizationParamsSchema } from "./onboarding.schema.js";

export async function customerLoginController(req: Request, res: Response) {
  res.set("Cache-Control", "no-store");
  const params = publicOrganizationParamsSchema.safeParse(req.params);
  const body = customerLoginSchema.safeParse(req.body);
  if (!params.success || !body.success) {
    throw new AppError(400, "Invalid login data");
  }

  const result = await login(
    {
      organizationSlug: params.data.slug,
      email: body.data.email,
      password: body.data.password,
    },
    {
      userAgent: req.get("user-agent") ?? null,
      requiredRole: "CUSTOMER",
    },
  );

  res.cookie(SESSION_COOKIE_NAME, result.token, getSessionCookieOptions());
  res.status(200).json({ user: result.user, session: result.session });
}
