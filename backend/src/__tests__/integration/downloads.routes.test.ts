import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../app";
import { signDownload } from "../../lib/downloadTokens";

const ORIGINAL_SECRET = process.env.DOWNLOAD_SIGNING_SECRET;

beforeAll(() => {
    process.env.DOWNLOAD_SIGNING_SECRET = "word-addin-download-test-secret";
});

afterAll(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.DOWNLOAD_SIGNING_SECRET;
    else process.env.DOWNLOAD_SIGNING_SECRET = ORIGINAL_SECRET;
});

describe("Word Office download exchange", () => {
    it("requires authentication to mint an Office link", async () => {
        const token = signDownload("documents/u/file.docx", "file.docx");
        const response = await request(app).post(`/download/office-link/${token}`);
        expect(response.status).toBe(401);
    });

    it("does not accept an ordinary non-expiring download token", async () => {
        const token = signDownload("documents/u/file.docx", "file.docx");
        const response = await request(app).get(`/download/office/${token}`);
        expect(response.status).toBe(404);
        expect(response.body.detail).toBe("Invalid link");
    });

    it("does not accept a token with an expiry beyond the Office window", async () => {
        const token = signDownload("documents/u/file.docx", "file.docx", 3600);
        const response = await request(app).get(`/download/office/${token}`);
        expect(response.status).toBe(404);
        expect(response.body.detail).toBe("Invalid link");
    });
});
