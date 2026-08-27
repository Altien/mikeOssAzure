export type FileContent = ArrayBuffer | ArrayBufferView;

export interface StorageProvider {
  readonly enabled: boolean;
  uploadFile(
    key: string,
    content: FileContent,
    contentType: string,
  ): Promise<void>;
  downloadFile(key: string): Promise<ArrayBuffer | null>;
  listFiles(prefix: string): Promise<string[]>;
  deleteFile(key: string): Promise<void>;
  getSignedUrl(
    key: string,
    expiresIn?: number,
    downloadFilename?: string,
  ): Promise<string | null>;
}
