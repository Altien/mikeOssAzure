import crypto from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../app";
import { createServerSQLite } from "../../lib/sqlite";

const createdUserIds: string[] = [];

afterAll(async () => {
  const db = createServerSQLite();
  for (const id of createdUserIds) {
    await db.from("user_profiles").delete().eq("user_id", id);
    await db.auth.admin.deleteUser(id);
  }
});

describe("auth email normalization with SQLite", () => {
  it("trims whitespace from signup email and rejects padded duplicates", async () => {
    const unique = crypto.randomUUID();
    const email = `trim-${unique}@test.local`;

    const first = await request(app)
      .post("/user/auth/signup")
      .send({
        email: `  ${email}  `,
        password: "test-password",
      });
    expect(first.status).toBe(200);
    expect(first.body.user.email).toBe(email);
    createdUserIds.push(first.body.user.id);

    const duplicate = await request(app)
      .post("/user/auth/signup")
      .send({
        email: `${email} `,
        password: "test-password",
      });
    expect(duplicate.status).toBe(409);
  });

  it("logs in with whitespace-padded email", async () => {
    const unique = crypto.randomUUID();
    const email = `login-${unique}@test.local`;

    const signup = await request(app).post("/user/auth/signup").send({
      email,
      password: "test-password",
    });
    expect(signup.status).toBe(200);
    createdUserIds.push(signup.body.user.id);

    const login = await request(app)
      .post("/user/auth/login")
      .send({
        email: ` ${email} `,
        password: "test-password",
      });
    expect(login.status).toBe(200);
    expect(login.body.user.email).toBe(email);
  });
});
