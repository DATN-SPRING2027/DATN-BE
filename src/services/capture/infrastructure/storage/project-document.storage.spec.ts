import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { R2Storage } from './r2.storage';
import { ProjectDocumentStorage } from './project-document.storage';

describe('Project Document local storage', () => {
  it('persists generated private object keys in development and rejects traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'work-note-storage-test-'));
    const storage = new ProjectDocumentStorage(
      { isConfigured: () => false } as unknown as R2Storage,
      { get: () => root } as unknown as ConfigService,
    );
    const key = `work-notes/${'a'.repeat(24)}/${'b'.repeat(24)}/${'c'.repeat(24)}/123e4567-e89b-42d3-a456-426614174000`;
    try {
      const bytes = Buffer.from('%PDF-1.4 test');
      await storage.put(key, bytes, 'application/pdf');
      expect(await storage.get(key)).toEqual(bytes);
      await expect(storage.get('../outside')).rejects.toThrow(
        'Invalid document storage key',
      );
      await storage.delete(key);
      await expect(storage.get(key)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
