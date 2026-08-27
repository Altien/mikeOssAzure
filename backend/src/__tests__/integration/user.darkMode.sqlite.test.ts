import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../app";
import { createServerSQLite } from "../../lib/sqlite";

let token = "";
let userId = "";

beforeAll(async () => {
    const response = await request(app).post("/user/auth/signup").send({
        email: `dark-mode-${crypto.randomUUID()}@test.local`,
        password: "test-password",
    });
    expect(response.status).toBe(200);
    token = response.body.token;
    userId = response.body.user.id;
});

afterAll(async () => {
    if (!userId) return;
    const db = createServerSQLite();
    await db.from("user_profiles").delete().eq("user_id", userId);
    await db.auth.admin.deleteUser(userId);
});

describe("dark mode profile preference with SQLite", () => {
    it("persists through the profile API and reload", async () => {
        const auth = { Authorization: `Bearer ${token}` };
        const updated = await request(app)
            .patch("/user/profile")
            .set(auth)
            .send({ darkMode: true })
            .expect(200);
        expect(updated.body.darkMode).toBe(true);

        const reloaded = await request(app)
            .get("/user/profile")
            .set(auth)
            .expect(200);
        expect(reloaded.body.darkMode).toBe(true);

        const db = createServerSQLite();
        const { data } = await db
            .from("user_profiles")
            .select("dark_mode")
            .eq("user_id", userId)
            .maybeSingle();
        expect(data?.dark_mode).toBe(true);
    });
});
