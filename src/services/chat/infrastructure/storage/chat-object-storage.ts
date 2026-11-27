import type { Readable } from 'node:stream';

export interface StoredObjectMetadata {
  size: number | undefined;
  contentType: string | undefined;
}

export interface StoredObjectStream {
  stream: Readable;
  size: number | undefined;
  contentType: string | undefined;
}

export interface ChatObjectStorage {
  isConfigured(): boolean;
  putObject(
    key: string,
    body: Readable,
    contentType: string,
    size: number,
  ): Promise<void>;
  createDownloadUrl(
    key: string,
    expiresInSeconds?: number,
    response?: {
      contentType: string;
      contentDisposition: 'inline' | 'attachment';
      filename: string;
      localStreamUrl?: string;
    },
  ): Promise<string>;
  openReadStream(key: string): Promise<StoredObjectStream>;
  headObject(key: string): Promise<StoredObjectMetadata>;
  deleteObject(key: string): Promise<void>;
}
