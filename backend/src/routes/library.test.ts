import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  validateSupabaseTokenMock,
  upsertUserProfileMock,
  createServerSupabaseMock,
  deleteFileMock,
} = vi.hoisted(() => ({
  validateSupabaseTokenMock: vi.fn(),
  upsertUserProfileMock: vi.fn(),
  createServerSupabaseMock: vi.fn(),
  deleteFileMock: vi.fn(),
}));

vi.mock("../lib/auth/providers/supabase.js", () => ({
  validateSupabaseToken: validateSupabaseTokenMock,
}));
vi.mock("../lib/userSettings.js", () => ({
  upsertUserProfile: upsertUserProfileMock,
}));
vi.mock("../lib/supabase", () => ({
  createServerSupabase: createServerSupabaseMock,
}));
vi.mock("../lib/storage", () => ({
  deleteFile: deleteFileMock,
}));

import { libraryRouter } from "./library";

const ORIGINAL_AUTH_PROVIDER = process.env.AUTH_PROVIDER;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/library", libraryRouter);
  return app;
}

function fakeLibraryDeleteDb(documentDeleteError: Error | null) {
  const events: string[] = [];

  const db = {
    from: vi.fn((table: string) => {
      let operation: "select" | "delete" | null = null;
      const builder: Record<string, unknown> = {};
      builder.select = () => {
        operation = "select";
        return builder;
      };
      builder.delete = () => {
        operation = "delete";
        return builder;
      };
      builder.eq = () => builder;
      builder.is = () => builder;
      builder.or = () => builder;
      builder.in = () => builder;
      builder.then = (
        resolve: (value: { data: unknown; error: Error | null }) => unknown,
      ) => {
        if (table === "library_folders" && operation === "select") {
          return resolve({
            data: [{ id: "folder-1", parent_folder_id: null }],
            error: null,
          });
        }
        if (table === "documents" && operation === "select") {
          return resolve({ data: [{ id: "document-1" }], error: null });
        }
        if (table === "document_versions" && operation === "select") {
          return resolve({
            data: [
              {
                storage_path: "user-1/document-1/source.docx",
                pdf_storage_path: "user-1/document-1/rendered.pdf",
              },
            ],
            error: null,
          });
        }
        if (table === "documents" && operation === "delete") {
          events.push("db:delete-documents");
          return resolve({ data: null, error: documentDeleteError });
        }
        if (table === "library_folders" && operation === "delete") {
          events.push("db:delete-folder");
          return resolve({ data: null, error: null });
        }
        throw new Error(`Unexpected fake DB operation: ${operation} ${table}`);
      };
      return builder;
    }),
  };

  return { db, events };
}

beforeEach(() => {
  process.env.AUTH_PROVIDER = "supabase";
  validateSupabaseTokenMock.mockReset().mockResolvedValue({
    ok: true,
    principal: {
      userId: "user-1",
      email: "user@example.com",
      groups: [],
      roles: [],
      provider: "supabase",
    },
  });
  upsertUserProfileMock.mockReset().mockResolvedValue(undefined);
  createServerSupabaseMock.mockReset();
  deleteFileMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  if (ORIGINAL_AUTH_PROVIDER === undefined) delete process.env.AUTH_PROVIDER;
  else process.env.AUTH_PROVIDER = ORIGINAL_AUTH_PROVIDER;
});

describe("DELETE /api/library/:kind/folders/:folderId", () => {
  it("does not delete blobs when deleting the document rows fails", async () => {
    const { db } = fakeLibraryDeleteDb(new Error("database unavailable"));
    createServerSupabaseMock.mockReturnValue(db);

    const response = await request(makeApp())
      .delete("/api/library/files/folders/folder-1")
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ detail: "database unavailable" });
    expect(deleteFileMock).not.toHaveBeenCalled();
  });

  it("deletes document rows before starting best-effort blob cleanup", async () => {
    const { db, events } = fakeLibraryDeleteDb(null);
    createServerSupabaseMock.mockReturnValue(db);
    deleteFileMock.mockImplementation(async (path: string) => {
      events.push(`storage:delete:${path}`);
    });

    const response = await request(makeApp())
      .delete("/api/library/files/folders/folder-1")
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(204);
    expect(events).toEqual([
      "db:delete-documents",
      "storage:delete:user-1/document-1/source.docx",
      "storage:delete:user-1/document-1/rendered.pdf",
      "db:delete-folder",
    ]);
  });
});
