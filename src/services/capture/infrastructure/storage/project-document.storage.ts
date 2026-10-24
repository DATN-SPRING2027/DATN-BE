import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { R2Storage } from './r2.storage';

@Injectable()
export class ProjectDocumentStorage {
  private readonly localRoot: string;

  constructor(
    private readonly r2: R2Storage,
    config: ConfigService,
  ) {
    this.localRoot = resolve(
      config.get<string>('WORK_NOTE_LOCAL_STORAGE_DIR') ||
        join(tmpdir(), 'continuum-work-notes'),
    );
  }

  private localPath(key: string): string {
    if (
      !/^work-notes\/[a-f\d]{24}\/[a-f\d]{24}\/[a-f\d]{24}\/[0-9a-f-]{36}$/i.test(
        key,
      )
    )
      throw new Error('Invalid document storage key');
    const path = resolve(this.localRoot, key);
    if (!path.startsWith(this.localRoot + sep))
      throw new Error('Invalid document storage key');
    return path;
  }

  private useLocal(): boolean {
    if (this.r2.isConfigured()) return false;
    if (process.env.NODE_ENV === 'production')
      throw new ServiceUnavailableException({
        code: 'DOCUMENT_STORAGE_UNAVAILABLE',
        message: 'Project Document storage is unavailable.',
      });
    return true;
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    if (!this.useLocal()) return this.r2.putObject(key, bytes, contentType);
    const path = this.localPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' });
  }

  async get(key: string): Promise<Buffer> {
    if (!this.useLocal()) return this.r2.getObject(key);
    return readFile(this.localPath(key));
  }

  async delete(key: string): Promise<void> {
    if (!this.useLocal()) return this.r2.deleteObject(key);
    await rm(this.localPath(key), { force: true });
  }
}
