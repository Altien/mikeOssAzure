// Adapted candidate for source d6356e3: private provider-backed org logos.
// Uses existing StorageProvider facade; no provider implementation changes.
import { randomUUID } from "node:crypto";
import { recordAudit } from "../../lib/audit";
import { getOrgRole, isOrgAdmin } from "../../lib/access";
import { deleteFileBestEffort, downloadFile, uploadFile } from "../../lib/storage";
import type { OrgResult } from "../../lib/orgs";
import type { Db } from "../../lib/supabase";

export const MAX_ORG_LOGO_BYTES = 512 * 1024;
type LogoContentType = "image/png" | "image/jpeg" | "image/webp";
const SIGNATURES: Record<LogoContentType, (bytes: Buffer) => boolean> = {
  "image/png": b => b.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])),
  "image/jpeg": b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/webp": b => b.subarray(0,4).toString("latin1") === "RIFF" && b.subarray(8,12).toString("latin1") === "WEBP",
};
const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const UNSUPPORTED = "The logo must be a PNG, JPEG or WebP image.";
export function parseOrgLogoDataUrl(value: unknown): {ok:true; contentType:LogoContentType; bytes:Buffer}|{ok:false;detail:string} {
  if (typeof value !== "string" || !value) return {ok:false,detail:"data_url is required"};
  if (value.length > Math.ceil(MAX_ORG_LOGO_BYTES / 3) * 4 + 64) return {ok:false,detail:"The logo is too large. Use an image under 512 KB."};
  const m=DATA_URL.exec(value); if (!m) return {ok:false,detail:UNSUPPORTED};
  const contentType=m[1] as LogoContentType, bytes=Buffer.from(m[2],"base64");
  if (!bytes.length || bytes.length > MAX_ORG_LOGO_BYTES) return {ok:false,detail:bytes.length ? "The logo is too large. Use an image under 512 KB." : UNSUPPORTED};
  if (!SIGNATURES[contentType](bytes)) return {ok:false,detail:UNSUPPORTED};
  return {ok:true,contentType,bytes};
}
function logoKey(orgId:string, objectId:string) { return `orgs/${orgId}/logos/${objectId}`; }

/** Members may read; each request rechecks membership before touching private storage. */
export async function getOrgLogo(db:Db, params:{userId:string;orgId:string}):Promise<OrgResult<{logo:{data_url:string;updated_at:string}}>> {
  if (!await getOrgRole(params.userId,params.orgId,db)) return {ok:false,kind:"not_found"};
  const {data,error}=await db.from("org_logos").select("object_key,content_type,updated_at").eq("org_id",params.orgId).maybeSingle();
  if(error) return {ok:false,kind:"db_error",detail:error.message};
  const row=data as {object_key?:string;content_type?:string;updated_at?:string}|null;
  if(!row?.object_key || !row.content_type) return {ok:false,kind:"not_found"};
  const bytes=await downloadFile(row.object_key);
  if(!bytes) return {ok:false,kind:"db_error",detail:"Organization logo storage object is unavailable"};
  return {ok:true,logo:{data_url:`data:${row.content_type};base64,${Buffer.from(bytes).toString("base64")}`,updated_at:row.updated_at??""}};
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
