import type { Db } from "../dbq/types";

/**
 * Delete personal memory without reaching into an organization's data or a
 * project that merely happens to be shared with this user.
 */
export async function deleteUserPrivateMemories(
  db: Db,
  userId: string,
): Promise<{ projectMemoriesDeleted: number }> {
  const { data, error } = await db.rpc("delete_user_private_memories", {
    p_user_id: userId,
  });
  if (error) throw new Error("Failed to delete private memories");
  return {
    projectMemoriesDeleted:
      typeof data === "number" && Number.isSafeInteger(data) ? data : 0,
  };
}
