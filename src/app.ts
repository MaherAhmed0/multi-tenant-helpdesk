import express from "express";

import { healthRouter } from "./health/health.routes.js";
import { registrationRouter } from "./organization-registration/registration.routes.js";
import { errorMiddleware } from "./errors/error.middleware.js";
import { authRouter } from "./auth/auth.routes.js";
import cookieParser from "cookie-parser";

export const app = express();

app.use(express.json());
app.use(cookieParser());

app.use("/health", healthRouter);
app.use("/organization-registration", registrationRouter);
app.use("/auth", authRouter);

app.use(errorMiddleware);
