import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Types } from 'mongoose';
import { NotificationCenterRepository } from './infrastructure/mongodb/notification-center.repository';
import { NOTIFICATION_PERSISTENCE } from './infrastructure/persistence';
import { NotificationCenterController } from './notification.controller';
import { NotificationRealtimeBus } from './notification-realtime.bus';
import { NotificationService } from './notification.service';
import { TaskDeadlineNotificationScheduler } from './task-deadline-notification.scheduler';
import { createCollectionSchema as createIngestionSchema } from '../ingestion/infrastructure/mongodb/mongodb.schemas';
import { INGESTION_PERSISTENCE } from '../ingestion/infrastructure/persistence';
import { R2Storage as IngestionR2Storage } from '../ingestion/infrastructure/storage/r2.storage';

describe('Notification, Scheduler & Ingestion Security/Performance Audit Regressions', () => {
  const oid = () => new Types.ObjectId().toHexString();

  describe('SEC-AUTH-011: markAsRead redaction, metadata stripping & fail-closed resolveTargetAccess', () => {
    it('redacts title, message, actorId, resource IDs, and target URL on markAsRead after membership revocation', async () => {
      const orgId = oid();
      const projectId = oid();
      const taskId = oid();
      const actorId = oid();
      const userId = oid();

      let hasProjectMembership = false;
      const mockCollections: Record<string, { findOne: jest.Mock }> = {
        projects: {
          findOne: jest.fn(() =>
            Promise.resolve({
              _id: new Types.ObjectId(projectId),
              organizationId: new Types.ObjectId(orgId),
              visibility: 'PRIVATE',
              status: 'ACTIVE',
              deletedAt: null,
            }),
          ),
        },
        organization_memberships: {
          findOne: jest.fn(() =>
            Promise.resolve({
              organizationId: new Types.ObjectId(orgId),
              userId: new Types.ObjectId(userId),
              status: 'ACTIVE',
            }),
          ),
        },
        project_memberships: {
          findOne: jest.fn(() =>
            Promise.resolve(
              hasProjectMembership
                ? {
                    organizationId: new Types.ObjectId(orgId),
                    projectId: new Types.ObjectId(projectId),
                    userId: new Types.ObjectId(userId),
                    status: 'ACTIVE',
                  }
                : null,
            ),
          ),
        },
      };

      const mockConn = {
        useDb: jest.fn(() => ({
          models: {},
          model: undefined,
          db: {
            collection: (name: string) => mockCollections[name] ?? null,
          },
        })),
      };

      const repo = new NotificationCenterRepository(
        mockConn as never,
        undefined,
        undefined,
        {
          isTaskAvailableForNotificationTarget: () => Promise.resolve(true),
        } as never,
      );
      const service = new NotificationService(
        repo,
        new NotificationRealtimeBus(),
      );

      const [created] = await service.notifyTaskAssigned({
        actorId,
        assigneeUserId: userId,
        organizationId: orgId,
        projectId,
        taskId,
        taskTitle: 'Confidential Layoff Plan',
        eventId: 'evt-mark-read-1',
      });

      hasProjectMembership = false;
      const readDto = await service.markAsRead(userId, created.id, orgId);

      expect(readDto.readAt).not.toBeNull();
      expect(readDto.title).toBe('Notification unavailable');
      expect(readDto.message).toBe('This content is no longer available');
      expect(readDto.actorId).toBeNull();
      expect(readDto.projectId).toBeNull();
      expect(readDto.taskId).toBeNull();
      expect(readDto.target?.url).toBe('/notifications');
      expect(readDto.target?.projectId).toBeNull();
      expect(readDto.target?.taskId).toBeNull();
      expect(JSON.stringify(readDto)).not.toContain('Confidential Layoff Plan');
    });

    it('fails closed when DB connection or collection handles are missing, drops legacy user_role_assignments, and blocks Org ADMIN on TASK/private PROJECT', async () => {
      const orgId = oid();
      const projectId = oid();
      const taskId = oid();
      const noteId = oid();
      const convId = oid();
      const userId = oid();

      const taskNotif = {
        id: oid(),
        recipientId: userId,
        actorId: oid(),
        organizationId: orgId,
        projectId,
        taskId,
        noteId: null,
        conversationId: null,
        type: 'TASK_ASSIGNED' as const,
        title: 'Task assigned',
        message: 'Task Secret',
        target: {
          kind: 'TASK' as const,
          url: `/projects/${projectId}/work?taskId=${taskId}`,
          organizationId: orgId,
          projectId,
          taskId,
        },
        readAt: null,
        createdAt: new Date().toISOString(),
      };

      // 1. Null DB connection -> fail closed (FORBIDDEN)
      const disconnectedRepo = new NotificationCenterRepository();
      const disconnectedRes = await disconnectedRepo.resolveTargetAccess(
        userId,
        taskNotif,
      );
      expect(disconnectedRes.available).toBe(false);
      expect(disconnectedRes.reason).toBe('FORBIDDEN');

      // 2. Missing chat_members collection -> fail closed (FORBIDDEN)
      const missingChatMembersConn = {
        useDb: () => ({
          db: {
            collection: (name: string) => {
              if (name === 'chat_conversations') {
                return {
                  findOne: () =>
                    Promise.resolve({
                      _id: new Types.ObjectId(convId),
                      organizationId: new Types.ObjectId(orgId),
                      deletedAt: null,
                    }),
                };
              }
              if (name === 'organization_memberships') {
                return {
                  findOne: () =>
                    Promise.resolve({
                      organizationId: new Types.ObjectId(orgId),
                      userId: new Types.ObjectId(userId),
                      status: 'ACTIVE',
                    }),
                };
              }
              return null; // chat_members missing
            },
          },
        }),
      };
      const chatRepo = new NotificationCenterRepository(
        missingChatMembersConn as never,
      );
      const chatRes = await chatRepo.resolveTargetAccess(userId, {
        ...taskNotif,
        type: 'CHAT_MENTION',
        projectId: null,
        taskId: null,
        conversationId: convId,
        target: {
          kind: 'CHAT',
          url: `/chat?conversation=${convId}`,
          organizationId: orgId,
          conversationId: convId,
        },
      });
      expect(chatRes.available).toBe(false);
      expect(chatRes.reason).toBe('FORBIDDEN');

      // 3. Org ADMIN without project membership MUST NOT access TASK, and revoked role_assignments MUST NOT access WORK_NOTE
      let roleDoc: Record<string, unknown> | null = {
        organizationId: new Types.ObjectId(orgId),
        userId: new Types.ObjectId(userId),
        roleCode: 'ADMIN',
        status: 'ACTIVE',
      };
      const adminConn = {
        useDb: () => ({
          db: {
            collection: (name: string) => {
              if (name === 'projects') {
                return {
                  findOne: () =>
                    Promise.resolve({
                      _id: new Types.ObjectId(projectId),
                      organizationId: new Types.ObjectId(orgId),
                      visibility: 'PRIVATE',
                      status: 'ACTIVE',
                      deletedAt: null,
                    }),
                };
              }
              if (name === 'organization_memberships') {
                return { findOne: () => Promise.resolve({ status: 'ACTIVE' }) };
              }
              if (name === 'project_memberships') {
                return { findOne: () => Promise.resolve(null) };
              }
              if (name === 'role_assignments') {
                return { findOne: () => Promise.resolve(roleDoc) };
              }
              if (name === 'user_role_assignments') {
                return {
                  findOne: () =>
                    Promise.reject(
                      new Error(
                        'Legacy user_role_assignments must not be queried',
                      ),
                    ),
                };
              }
              if (name === 'work_notes') {
                return {
                  findOne: () =>
                    Promise.resolve({
                      _id: new Types.ObjectId(noteId),
                      organizationId: new Types.ObjectId(orgId),
                      projectId: new Types.ObjectId(projectId),
                      status: 'CONFIRMED',
                      deletedAt: null,
                    }),
                };
              }
              return null;
            },
          },
        }),
      };
      const adminRepo = new NotificationCenterRepository(
        adminConn as never,
        undefined,
        undefined,
        {
          isTaskAvailableForNotificationTarget: () => Promise.resolve(true),
        } as never,
      );

      const adminTaskRes = await adminRepo.resolveTargetAccess(
        userId,
        taskNotif,
      );
      expect(adminTaskRes.available).toBe(false);
      expect(adminTaskRes.reason).toBe('FORBIDDEN');

      const workNoteNotif = {
        ...taskNotif,
        type: 'WORK_NOTE_MENTION' as const,
        taskId: null,
        noteId,
        target: {
          kind: 'WORK_NOTE' as const,
          url: `/projects/${projectId}/work-notes?noteId=${noteId}`,
          organizationId: orgId,
          projectId,
          noteId,
        },
      };
      // Active Org ADMIN can read WORK_NOTE
      const activeAdminNote = await adminRepo.resolveTargetAccess(
        userId,
        workNoteNotif,
      );
      expect(activeAdminNote.available).toBe(true);

      // Revoked Org ADMIN role assignment MUST fail closed on WORK_NOTE
      roleDoc = {
        ...roleDoc,
        revokedAt: new Date(Date.now() - 1000),
      };
      const revokedAdminNote = await adminRepo.resolveTargetAccess(
        userId,
        workNoteNotif,
      );
      expect(revokedAdminNote.available).toBe(false);
      expect(revokedAdminNote.reason).toBe('FORBIDDEN');
    });
  });

  describe('BE-PERF-008 & SEC-AUTH-016: batched listing prefetch & scheduler dedupe + membership filter', () => {
    it('prefetches ACL data in <= 6 batched $in queries for 15 project notifications', async () => {
      const orgId = oid();
      const userId = oid();
      const projectIds = Array.from({ length: 15 }, () => oid());

      let totalDbCalls = 0;
      const collectionMocks: Record<
        string,
        { find: jest.Mock; findOne: jest.Mock }
      > = {
        projects: {
          find: jest.fn(() => {
            totalDbCalls += 1;
            return {
              toArray: () =>
                Promise.resolve(
                  projectIds.map((pid) => ({
                    _id: new Types.ObjectId(pid),
                    organizationId: new Types.ObjectId(orgId),
                    visibility: 'PRIVATE',
                    status: 'ACTIVE',
                    deletedAt: null,
                  })),
                ),
            };
          }),
          findOne: jest.fn(() => {
            totalDbCalls += 1;
            return Promise.resolve(null);
          }),
        },
        organization_memberships: {
          find: jest.fn(() => {
            totalDbCalls += 1;
            return {
              toArray: () =>
                Promise.resolve([
                  {
                    organizationId: new Types.ObjectId(orgId),
                    userId: new Types.ObjectId(userId),
                    status: 'ACTIVE',
                  },
                ]),
            };
          }),
          findOne: jest.fn(() => {
            totalDbCalls += 1;
            return Promise.resolve(null);
          }),
        },
        project_memberships: {
          find: jest.fn(() => {
            totalDbCalls += 1;
            return {
              toArray: () =>
                Promise.resolve(
                  projectIds.slice(0, 10).map((pid) => ({
                    organizationId: new Types.ObjectId(orgId),
                    projectId: new Types.ObjectId(pid),
                    userId: new Types.ObjectId(userId),
                    status: 'ACTIVE',
                  })),
                ),
            };
          }),
          findOne: jest.fn(() => {
            totalDbCalls += 1;
            return Promise.resolve(null);
          }),
        },
      };

      const mockConn = {
        useDb: () => ({
          db: {
            collection: (name: string) => collectionMocks[name] ?? null,
          },
        }),
      };

      const repo = new NotificationCenterRepository(mockConn as never);
      const items = projectIds.map((pid, idx) => ({
        id: oid(),
        recipientId: userId,
        actorId: oid(),
        organizationId: orgId,
        projectId: pid,
        taskId: null,
        noteId: null,
        conversationId: null,
        type: 'PROJECT_MEMBER_ADDED' as const,
        title: `Project ${idx}`,
        message: `You were added to Project ${idx}`,
        target: {
          kind: 'PROJECT' as const,
          url: `/projects/${pid}`,
          organizationId: orgId,
          projectId: pid,
        },
        readAt: null,
        createdAt: new Date().toISOString(),
      }));

      const sanitized = await repo.sanitizeItemsForListing(
        userId,
        items,
        orgId,
      );
      expect(totalDbCalls).toBeLessThanOrEqual(6);
      expect(collectionMocks.projects.findOne).not.toHaveBeenCalled();
      expect(
        collectionMocks.project_memberships.findOne,
      ).not.toHaveBeenCalled();
      expect(
        sanitized.slice(0, 10).every((i) => i.title.startsWith('Project')),
      ).toBe(true);
      expect(
        sanitized
          .slice(10)
          .every((i) => i.title === 'Notification unavailable'),
      ).toBe(true);
    });

    it('suppresses deadline notifications for removed project members and batches dedupe/membership checks', async () => {
      const orgId = oid();
      const projectId = oid();
      const activeUserId = oid();
      const removedUserId = oid();
      const now = new Date('2026-10-24T10:00:00.000Z');
      const dueDate = new Date(now.getTime() - 3600_000);
      const activeTaskId = new Types.ObjectId();
      const removedTaskId = new Types.ObjectId();
      const alreadyNotifiedTaskId = new Types.ObjectId();

      const alreadyKey = `${activeUserId}::task_deadline_overdue:${alreadyNotifiedTaskId.toHexString()}:${dueDate.toISOString()}`;
      const notifyOverdue = jest.fn().mockResolvedValue([]);
      const findExistingDeadlineEventKeys = jest
        .fn()
        .mockResolvedValue(new Set([alreadyKey]));
      const filterActiveTaskDeadlineMemberships = jest
        .fn()
        .mockResolvedValue(new Set([`${orgId}:${projectId}:${activeUserId}`]));

      const scheduler = new TaskDeadlineNotificationScheduler(
        {
          findExistingDeadlineEventKeys,
          filterActiveTaskDeadlineMemberships,
          notifyTaskDeadlineOverdue: notifyOverdue,
          notifyTaskDeadlineApproaching: jest.fn(),
        } as never,
        {
          listTasksForDeadlineNotifications: jest.fn().mockResolvedValue([
            {
              _id: activeTaskId,
              organizationId: new Types.ObjectId(orgId),
              projectId: new Types.ObjectId(projectId),
              title: 'Active Member Task',
              status: 'IN_PROGRESS',
              assigneeId: new Types.ObjectId(activeUserId),
              dueDate,
              deletedAt: null,
            },
            {
              _id: removedTaskId,
              organizationId: new Types.ObjectId(orgId),
              projectId: new Types.ObjectId(projectId),
              title: 'Removed Member Task',
              status: 'IN_PROGRESS',
              assigneeId: new Types.ObjectId(removedUserId),
              dueDate,
              deletedAt: null,
            },
            {
              _id: alreadyNotifiedTaskId,
              organizationId: new Types.ObjectId(orgId),
              projectId: new Types.ObjectId(projectId),
              title: 'Already Notified Task',
              status: 'IN_PROGRESS',
              assigneeId: new Types.ObjectId(activeUserId),
              dueDate,
              deletedAt: null,
            },
          ]),
        } as never,
      );

      const processed = await scheduler.evaluateTaskDeadlines({ now });
      expect(processed).toBe(3);
      expect(findExistingDeadlineEventKeys).toHaveBeenCalledTimes(1);
      expect(filterActiveTaskDeadlineMemberships).toHaveBeenCalledTimes(1);
      expect(notifyOverdue).toHaveBeenCalledTimes(1);
      expect(notifyOverdue).toHaveBeenCalledWith(
        expect.objectContaining({
          assigneeUserId: activeUserId,
          taskId: activeTaskId.toHexString(),
          skipMembershipCheck: true,
        }),
      );
    });
  });

  describe('BE-REL-007, SEC-BE-008, SEC-BE-012, BE-PERF-002 & Ingestion SEC-BE-017', () => {
    it('throws 503 NOTIFICATION_DATABASE_UNAVAILABLE outside test env when Mongo handle is absent (BE-REL-007)', async () => {
      const repo = new NotificationCenterRepository();
      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        await expect(repo.countUnread(oid(), oid())).rejects.toThrow(
          ServiceUnavailableException,
        );
        await expect(repo.listByRecipient(oid(), {}, oid())).rejects.toThrow(
          ServiceUnavailableException,
        );
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    });

    it('removes internal/notifications route alias (SEC-BE-008), enforces pre-auth CSRF without cookie+bearer bypass, and rate-limits mutations (SEC-BE-012)', async () => {
      const routeMeta: unknown = Reflect.getMetadata(
        PATH_METADATA,
        NotificationCenterController,
      );
      expect(routeMeta).toBe('notifications');

      const getCurrentSessionIdentity = jest.fn().mockResolvedValue({
        id: oid(),
        organizationId: oid(),
      });
      const consumeRateLimit = jest.fn().mockResolvedValue(false);
      const controller = new NotificationCenterController(
        {
          markAllAsRead: jest.fn(),
          markAsRead: jest.fn(),
          listForUser: jest.fn(),
        } as never,
        { getCurrentSessionIdentity } as never,
        { consumeRateLimit },
      );

      // Missing CSRF with cookie session fails BEFORE auth is even called
      await expect(
        controller.markAllAsRead(undefined, 'continuum_session=abc', undefined),
      ).rejects.toThrow(ForbiddenException);
      expect(getCurrentSessionIdentity).not.toHaveBeenCalled();

      // Bearer + session cookie WITHOUT valid CSRF MUST NOT bypass CSRF
      await expect(
        controller.markAsRead(
          'Bearer some-jwt',
          'continuum_session=abc',
          undefined,
          oid(),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(getCurrentSessionIdentity).not.toHaveBeenCalled();

      // Pure Bearer call passes CSRF and hits rate limiter -> 429 RATE_LIMIT_EXCEEDED
      let caught: unknown;
      try {
        await controller.markAllAsRead('Bearer some-jwt', undefined, undefined);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      expect(getCurrentSessionIdentity).toHaveBeenCalledTimes(1);
      expect(consumeRateLimit).toHaveBeenCalledTimes(1);
    });

    it('declares compound notifications organizationId index (BE-PERF-002), removes presignedPutUrl from file_upload_tickets, and blocks R2 key traversal (SEC-BE-017)', () => {
      const notifCol = NOTIFICATION_PERSISTENCE.collections.find(
        (c) => c.name === 'notifications',
      )!;
      expect(
        notifCol.indexes?.some(
          (idx) =>
            idx.fields.recipientId === 1 &&
            idx.fields.organizationId === 1 &&
            idx.fields.readAt === 1 &&
            idx.fields.createdAt === -1,
        ),
      ).toBe(true);

      const ticketDef = INGESTION_PERSISTENCE.collections.find(
        (c) => c.name === 'file_upload_tickets',
      )!;
      const ticketSchema = createIngestionSchema(ticketDef);
      expect(ticketSchema.path('presignedPutUrl')).toBeUndefined();

      const r2 = new IngestionR2Storage({
        get: (k: string) =>
          ({
            R2_ENDPOINT: 'https://r2.example.com',
            R2_ACCESS_KEY_ID: 'key',
            R2_SECRET_ACCESS_KEY: 'secret',
            R2_BUCKET: 'bucket',
          })[k],
      } as never);
      expect(() => r2.createDownloadUrl('../etc/passwd')).toThrow(
        'Invalid R2 object key',
      );
      expect(() => r2.createUploadUrl('/absolute/key', 'text/plain')).toThrow(
        'Invalid R2 object key',
      );
    });
  });
});
