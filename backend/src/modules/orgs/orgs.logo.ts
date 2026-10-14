// Adapted candidate for source d6356e3: private provider-backed org logos.
// Uses existing StorageProvider facade; no provider implementation changes.
import { randomUUID } from "node:crypto";
import { recordAudit } from "../../lib/audit";
import { getOrgRole, isOrgAdmin } from "../../lib/access";
import { deleteFileBestEffort, downloadFile, uploadFile } from "../../lib/storage";
import type { OrgResult } from "../../lib/orgs";
import type { Db } from "../../lib/supabase";

import { MAX_PROFILE_IMAGE_BYTES, parseProfileImageDataUrl } from "../../lib/profileImage";

export const MAX_ORG_LOGO_BYTES = MAX_PROFILE_IMAGE_BYTES;
<<<<<<< HEAD
export function parseOrgLogoDataUrl(value: unknown): {ok:true; contentType:"image/png"|"image/jpeg"|"image/webp"; bytes:Buffer}|{ok:false;detail:string} {
    const parsed = parseProfileImageDataUrl(value, "logo");
    return parsed.ok ? { ok:true, contentType:parsed.contentType, bytes:Buffer.from(parsed.base64,"base64") } : parsed;
=======
/** Applies shared raster size, encoding, and signature validation with logo-specific error messages. */
export function parseOrgLogoDataUrl(value: unknown) {
    return parseProfileImageDataUrl(value, "logo");
>>>>>>> 5ed055e3 (docs: document profile photo and roster contracts)
}


export async function saveOrgLogo(db:Db, params:{actorId:string;actorEmail?:string|null;orgId:string;dataUrl:unknown}):Promise<OrgResult<{logo_updated_at:string}>> {
  const role=await getOrgRole(params.actorId,params.orgId,db); if(!role) return {ok:false,kind:"not_found"}; if(!isOrgAdmin(role)) return {ok:false,kind:"forbidden"};
  const parsed=parseOrgLogoDataUrl(params.dataUrl); if(!parsed.ok) return {ok:false,kind:"validation",detail:parsed.detail};
  const {data:old,error:readError}=await db.from("org_logos").select("object_key").eq("org_id",params.orgId).maybeSingle();
  if(readError) return {ok:false,kind:"db_error",detail:readError.message};
  const key=logoKey(params.orgId,randomUUID());
  try { const image=parsed.bytes; await uploadFile(key,image.buffer.slice(image.byteOffset,image.byteOffset+image.byteLength) as ArrayBuffer,parsed.contentType); }
  catch { return {ok:false,kind:"db_error",detail:"Could not store organization logo"}; }
  const updatedAt=new Date().toISOString();
  const {error}=await db.from("org_logos").upsert({org_id:params.orgId,object_key:key,content_type:parsed.contentType,updated_by:params.actorId,updated_at:updatedAt},{onConflict:"org_id"});
  if(error) { await deleteFileBestEffort(key,"org-logo-upsert-rollback"); return {ok:false,kind:"db_error",detail:error.message}; }
  const oldKey=(old as {object_key?:string}|null)?.object_key; if(oldKey && oldKey!==key) await deleteFileBestEffort(oldKey,"org-logo-replaced");
  await recordAudit(db,{userId:params.actorId,userEmail:params.actorEmail??null,action:"org.logo.updated",detail:{org_id:params.orgId,content_type:parsed.contentType}});
  return {ok:true,logo_updated_at:updatedAt};
}

export async function removeOrgLogo(db:Db,params:{actorId:string;actorEmail?:string|null;orgId:string}):Promise<OrgResult<{logo_updated_at:null}>> {
  const role=await getOrgRole(params.actorId,params.orgId,db); if(!role) return {ok:false,kind:"not_found"}; if(!isOrgAdmin(role)) return {ok:false,kind:"forbidden"};
  const {data,error}=await db.from("org_logos").delete().eq("org_id",params.orgId).select("object_key");
  if(error) return {ok:false,kind:"db_error",detail:error.message};
  const rows=(data??[]) as {object_key?:string}[];
  for(const row of rows) if(row.object_key) await deleteFileBestEffort(row.object_key,"org-logo-removed");
  if(rows.length) await recordAudit(db,{userId:params.actorId,userEmail:params.actorEmail??null,action:"org.logo.removed",detail:{org_id:params.orgId}});
  return {ok:true,logo_updated_at:null};
}
