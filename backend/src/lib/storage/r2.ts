import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl as createAwsSignedUrl } from "@aws-sdk/s3-request-presigner";
import { buildContentDisposition } from "./filenames";
import type { FileContent, StorageProvider } from "./types";
import { safeErrorLog } from "../safeError";

let cachedClient: S3Client | undefined;

function r2Enabled(): boolean {
  return Boolean(
    process.env.R2_ENDPOINT_URL?.trim() &&
    process.env.R2_ACCESS_KEY_ID?.trim() &&
    process.env.R2_SECRET_ACCESS_KEY?.trim(),
  );
}

function requireR2Config(): void {
  if (!r2Enabled()) {
    throw new Error(
      "R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY must be set when MIKE_STORAGE_PROVIDER=r2",
    );
  }
}

function getClient(): S3Client {
  requireR2Config();
  if (!cachedClient) {
    cachedClient = new S3Client({
      region: "auto",
      endpoint: process.env.R2_ENDPOINT_URL,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
  }
  return cachedClient;
}

function bucket(): string {
  return process.env.R2_BUCKET_NAME?.trim() || "mike";
}

function toBuffer(content: FileContent): Buffer {
  return ArrayBuffer.isView(content)
    ? Buffer.from(content.buffer, content.byteOffset, content.byteLength)
    : Buffer.from(content);
}

export const r2StorageProvider: StorageProvider = {
  get enabled() {
    return r2Enabled();
  },

  async uploadFile(key, content, contentType) {
    await getClient().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: toBuffer(content),
        ContentType: contentType,
      }),
    );
  },

  async downloadFile(key) {
    if (!r2Enabled()) return null;
    try {
      const response = await getClient().send(
        new GetObjectCommand({ Bucket: bucket(), Key: key }),
      );
      if (!response.Body) return null;
      const bytes = await response.Body.transformToByteArray();
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    } catch (error) {
      console.error("[storage] downloadFile failed", {
        key,
        error: safeErrorLog(error),
      });
      return null;
    }
  },

  async listFiles(prefix) {
    if (!r2Enabled()) return [];
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await getClient().send(
        new ListObjectsV2Command({
          Bucket: bucket(),
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const item of response.Contents ?? []) {
        if (item.Key) keys.push(item.Key);
      }
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);
    return keys;
  },

  async deleteFile(key) {
    if (!r2Enabled()) return;
    await getClient().send(
      new DeleteObjectCommand({ Bucket: bucket(), Key: key }),
    );
  },

  async getSignedUrl(key, expiresIn = 3600, downloadFilename) {
    if (!r2Enabled()) return null;
    try {
      const command = new GetObjectCommand({
        Bucket: bucket(),
        Key: key,
        ResponseContentDisposition: downloadFilename
          ? buildContentDisposition("attachment", downloadFilename)
          : undefined,
      });
      return await createAwsSignedUrl(getClient(), command, { expiresIn });
    } catch (error) {
      console.error("[storage] getSignedUrl failed", {
        key,
        error: safeErrorLog(error),
      });
      return null;
    }
  },
};
