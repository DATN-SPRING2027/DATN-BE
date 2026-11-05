import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { R2Storage } from './r2.storage';
import { ProjectDocumentStorage } from './project-document.storage';

describe('Project Document local storage', () => {
  it('persists generated private object keys atomically via .staging, inspects magic prefix, and rejects traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'work-note-storage-test-'));
    const storage = new ProjectDocumentStorage(
      { isConfigured: () => false } as unknown as R2Storage,
      { get: () => root } as unknown as ConfigService,
    );
    const key = `work-notes/${'a'.repeat(24)}/${'b'.repeat(24)}/${'c'.repeat(24)}/123e4567-e89b-42d3-a456-426614174000`;
    const reportKey = `work-reports/${'a'.repeat(24)}/${'b'.repeat(24)}/${'d'.repeat(24)}/123e4567-e89b-42d3-a456-426614174001`;
    try {
      const bytes = Buffer.from('%PDF-1.4 test');
      const mdBytes = Buffer.from(
        '# Periodic Report\n\nApproved content.',
        'utf-8',
      );
      await storage.put(key, bytes, 'application/pdf');
      await storage.put(reportKey, mdBytes, 'text/markdown');
      expect(await storage.get(key)).toEqual(bytes);
      expect(await storage.get(reportKey)).toEqual(mdBytes);

      // Verify staging directory has no leftover .part files after atomic rename
      const stagingEntries = await readdir(join(root, '.staging'));
      expect(stagingEntries).toHaveLength(0);

      // Verify prefix inspection reads size, contentType sidecar, and magic prefix
      const inspected = await storage.inspectStoredPrefix(key, 8);
      expect(inspected).toEqual({
        size: bytes.length,
        contentType: 'application/pdf',
        prefix: Buffer.from('%PDF-1.4'),
      });

      // Verify immutable write (EEXIST on duplicate key)
      await expect(
        storage.put(key, bytes, 'application/pdf'),
      ).rejects.toMatchObject({ code: 'EEXIST' });

      await expect(storage.get('../outside')).rejects.toThrow(
        'Invalid document storage key',
      );
      await storage.delete(key);
      await storage.delete(reportKey);
      await expect(storage.get(key)).rejects.toThrow();
      await expect(storage.get(reportKey)).rejects.toThrow();

      // Verify empty parent directories (<docId>/<projectId>/<orgId>) are pruned while top-level buckets remain
      const workNotesEntries = await readdir(join(root, 'work-notes'));
      expect(workNotesEntries).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('defaults to ../.data/continuum-vault and always stores in Local Vault without .env overrides even when R2 is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-vault-override-'));
    try {
      const defaultStorage = new ProjectDocumentStorage(
        { isConfigured: () => true } as unknown as R2Storage,
        { get: () => undefined } as unknown as ConfigService,
      );
      expect(defaultStorage.getLocalRoot()).toBe(
        resolve(process.cwd(), '..', '.data', 'continuum-vault'),
      );
      expect(defaultStorage.isDirectCloudEnabled()).toBe(false);

      const putObjectSpy = jest.fn();
      const deleteObjectSpy = jest.fn().mockResolvedValue(undefined);
      const getObjectSpy = jest
        .fn()
        .mockResolvedValue(Buffer.from('# Legacy R2 Content\n', 'utf-8'));
      const forcedLocalStorage = new ProjectDocumentStorage(
        {
          isConfigured: () => true,
          putObject: putObjectSpy,
          deleteObject: deleteObjectSpy,
          getObject: getObjectSpy,
        } as unknown as R2Storage,
        {
          get: (cfgKey: string) => {
            if (cfgKey === 'WORK_NOTE_LOCAL_STORAGE_DIR') return root;
            return undefined;
          },
        } as unknown as ConfigService,
      );

      expect(forcedLocalStorage.isDirectCloudEnabled()).toBe(false);
      const key = `work-notes/${'1'.repeat(24)}/${'2'.repeat(24)}/${'3'.repeat(24)}/v1-abcdef012345.md`;
      const payload = Buffer.from('# Confidential Enterprise Note\n', 'utf-8');
      await forcedLocalStorage.put(key, payload, 'text/markdown');
      expect(putObjectSpy).not.toHaveBeenCalled();
      expect(await forcedLocalStorage.get(key)).toEqual(payload);

      // Legacy R2 read-through lazy migration into Local Vault
      const legacyKey = `work-notes/${'1'.repeat(24)}/${'2'.repeat(24)}/${'4'.repeat(24)}/123e4567-e89b-42d3-a456-426614174088`;
      const migrated = await forcedLocalStorage.get(legacyKey);
      expect(migrated.toString('utf-8')).toBe('# Legacy R2 Content\n');
      expect(getObjectSpy).toHaveBeenCalledWith(legacyKey);

      // Permanent deletion removes local file, prunes empty folders, and cleans up legacy R2 object
      await forcedLocalStorage.delete(legacyKey);
      expect(deleteObjectSpy).toHaveBeenCalledWith(legacyKey);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
