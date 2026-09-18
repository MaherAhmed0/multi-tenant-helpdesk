import { Router } from "express";
import swaggerUi from "swagger-ui-express";

import { openapi } from "./openapi.js";

export const docsRouter = Router();

docsRouter.get("/openapi.json", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(openapi);
});

docsRouter.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(null, {
    customSiteTitle: "Multi-Tenant Helpdesk API",
    swaggerOptions: {
      url: "/openapi.json",
      validatorUrl: null,
      withCredentials: true,
      persistAuthorization: false,
    },
  }),
);
