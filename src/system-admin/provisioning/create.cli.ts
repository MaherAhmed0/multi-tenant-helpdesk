import { input, password as passwordPrompt } from "@inquirer/prompts";

import { db } from "../../database/db.js";
import { AppError } from "../../errors/app-error.js";
import { provisioningSchema } from "./provisioning.schema.js";
import { provisionSystemAdmin } from "./provisioning.service.js";
import {
  confirmTotpEnrollment,
  startTotpEnrollment,
} from "./totp-enrollment.js";

async function main(): Promise<void> {
  try {
    const email = (
      await input({
        message: "SYSTEM_ADMIN email:",
        validate: (value) => {
          const result = provisioningSchema.shape.email.safeParse(value);
          return (
            result.success ||
            "Enter a valid email address (maximum 254 characters)."
          );
        },
      })
    )
      .trim()
      .toLowerCase();

    const password = await passwordPrompt({
      message: "Password:",
      mask: false,
      toggleMask: false,
      validate: (value) => {
        const result = provisioningSchema.shape.password.safeParse(value);
        return (
          result.success ||
          result.error.issues[0]?.message ||
          "Invalid password."
        );
      },
    });

    await passwordPrompt({
      message: "Confirm password:",
      mask: false,
      toggleMask: false,
      validate: (value) =>
        value === password || "Passwords do not match. Try again.",
    });

    const enrollment = startTotpEnrollment(email);
    console.log(
      "\nAdd this account to your authenticator in a private terminal:",
    );
    console.log("Issuer: Multi-Tenant Helpdesk");
    console.log(`Account: ${email}`);
    console.log(`TOTP secret: ${enrollment.secret}`);
    console.log(`Setup URI: ${enrollment.uri}`);

    while (true) {
      const code = await passwordPrompt({
        message: "Current six-digit authenticator code:",
        mask: false,
        toggleMask: false,
      });
      if (await confirmTotpEnrollment(enrollment.secret, code)) {
        break;
      }
      console.error(
        "Invalid authenticator code. Enter a current six-digit code and try again.",
      );
    }

    const result = await provisionSystemAdmin({
      email,
      password,
      confirmedTotpSecret: enrollment.secret,
    });

    console.log(`\nSYSTEM_ADMIN created: ${result.systemAdmin.email}`);
    console.log(`ID: ${result.systemAdmin.id}`);
    console.log("Recovery codes are shown once. Store them securely:");
    for (const code of result.recoveryCodes) {
      console.log(code);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  if (error instanceof AppError) {
    console.error(error.message);
  } else if (error instanceof Error && error.name === "ExitPromptError") {
    console.error("SYSTEM_ADMIN creation cancelled.");
  } else {
    // Database errors may contain persistence values; do not print the error object.
    console.error("SYSTEM_ADMIN creation failed unexpectedly.");
  }
  process.exitCode = 1;
});
