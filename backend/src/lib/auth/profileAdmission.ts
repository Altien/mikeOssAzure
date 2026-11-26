import type { AuthPrincipal } from "./types";
import type { ErrorKind } from "../appError";
import { createServerSupabase } from "../supabase";
import { upsertUserProfile } from "../userLookup";

export type ProfileAdmissionError = {
  status: number;
  detail: string;
  /** A dependency failure the caller reports (static kind, upstream cause). */
  failure?: { kind: ErrorKind; cause: unknown };
};

/** Call only after active-tenant admission, inside that tenant's scope. */
export async function initializeAuthenticatedProfile(principal: AuthPrincipal): Promise<ProfileAdmissionError | undefined> {
  // A revoked cookie is insufficient for Entra: an already-issued bearer
  // token remains valid at the IdP. The durable tombstone blocks both token
  // transports before profile seeding or any application write can run.
  try {
    const { data, error } = await createServerSupabase().from("account_erasure_requests")
      .select("status").eq("user_id", principal.userId).maybeSingle();
    if (error) throw error;
    if (data) return { status: 410, detail: "This account has been closed." };
  } catch (error) {
    return { status: 503, detail: "Account status is unavailable", failure: { kind: "db.query_failed", cause: error } };
  }
  try {
    await upsertUserProfile(principal.userId, principal.email, principal.displayName);
  } catch (error) {
    return { status: 500, detail: "Unable to initialize user profile", failure: { kind: "db.query_failed", cause: error } };
  }

  // Upstream divergence (sync-log: 3ca82155): Dev owns profile creation
  // after validated Entra/local identity and session/tombstone checks. A
  // personal-org failure must not undo profile initialization or sign-in.
  try {
    const { error } = await createServerSupabase().rpc("ensure_personal_organization", {
      p_user_id: principal.userId,
    });
    if (error) console.warn("[auth/personal-org] initialization failed", { code: error.code });
  } catch {
    console.warn("[auth/personal-org] initialization unavailable");
  }
  return undefined;
}
