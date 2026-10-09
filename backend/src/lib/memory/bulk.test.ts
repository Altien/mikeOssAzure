import { describe, expect, it, vi } from "vitest";
import { deleteUserPrivateMemories } from "./bulk";

describe("deleteUserPrivateMemories", () => {
  it("delegates the complete private-memory wipe to one database transaction", async () => {
    const rpc = vi.fn(async () => ({ data: 2, error: null }));
    const db = { rpc };

    await expect(deleteUserPrivateMemories(db as never, "u1")).resolves.toEqual(
      { projectMemoriesDeleted: 2 },
    );
    expect(rpc).toHaveBeenCalledWith("delete_user_private_memories", {
      p_user_id: "u1",
    });
  });

  it("fails the request when the database transaction fails", async () => {
    const db = {
      rpc: vi.fn(async () => ({
        data: null,
        error: { message: "rolled back" },
      })),
    };

    await expect(deleteUserPrivateMemories(db as never, "u1")).rejects.toThrow(
      "Failed to delete private memories",
    );
  });
});
