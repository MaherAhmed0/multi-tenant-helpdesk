import request from "supertest";
import { describe, expect, it } from "vitest";

import { app } from "../app.js";

describe("GET /health", () => {
  it("returns a healthy response", async () => {
    const response = await request(app).get("/health").expect(200);

    expect(response.body).toEqual({
      status: "ok",
    });
  });
});
