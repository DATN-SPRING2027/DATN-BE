/* eslint-disable @typescript-eslint/require-await */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { NotificationCenterRepository } from './infrastructure/mongodb/notification-center.repository';
import { NotificationRealtimeBus } from './notification-realtime.bus';
import { NotificationService } from './notification.service';
import { NotificationCenterController } from './notification.controller';
import { TaskDeadlineNotificationScheduler } from './task-deadline-notification.scheduler';
import { OrganizationMembershipCommandService } from '../iam/application/organizations/organization-membership-command.service';
import { OrganizationInvitationService } from '../iam/application/organizations/organization-invitation.service';
import { ProjectService } from '../iam/application/projects/project.service';
import { ProjectAccessService } from '../iam/application/projects/project-access.service';
import { TaskWorkspaceService } from '../task/workspace/task-workspace.service';
import { ProjectWorkNotesService } from '../capture/work-notes.service';
import { ChatApplicationService } from '../chat/application/chat.service';
import type { ConfigService } from '@nestjs/config';

describe('Notification MVP — End-to-End Business Rules & 13 Event Types', () => {
  const orgId = new Types.ObjectId().toHexString();
  const projectId = new Types.ObjectId().toHexString();
  const taskId = new Types.ObjectId().toHexString();
  const conversationId = new Types.ObjectId().toHexString();
  const messageId = new Types.ObjectId().toHexString();

  const adminId = new Types.ObjectId().toHexString();
  const userBId = new Types.ObjectId().toHexString();
  const userCId = new Types.ObjectId().toHexString();

  let repository: NotificationCenterRepository;
  let realtimeBus: NotificationRealtimeBus;
  let service: NotificationService;
  let scheduler: TaskDeadlineNotificationScheduler;
  let controller: NotificationCenterController;

  beforeEach(() => {
    repository = new NotificationCenterRepository();
    realtimeBus = new NotificationRealtimeBus();
    service = new NotificationService(repository, realtimeBus);
    scheduler = new TaskDeadlineNotificationScheduler(service);
    const mockAuth = {
      getCurrentSessionIdentity: jest.fn(async (authHeader?: string) => {
        const userId = authHeader?.replace('Bearer ', '') || userBId;
        return {
          id: userId,
          email: `${userId}@example.test`,
          name: `User ${userId}`,
          organizationId: orgId,
          roles: ['MEMBER'],
        };
      }),
    };
    controller = new NotificationCenterController(
      service,
      mockAuth as never,
      scheduler,
    );
  });

  describe('Rule 1 & Rule 2: No self-notification and recipient deduplication', () => {
    it('does not notify the actor even when actor is in recipient list', async () => {
      const items = await service.notifyProjectMemberAdded({
        actorId: adminId,
        recipientUserIds: [adminId, userBId],
        organizationId: orgId,
        projectId,
        projectName: 'Alpha',
        eventId: 'evt-1',
      });

      expect(items).toHaveLength(1);
      expect(items[0].recipientId).toBe(userBId);

      const adminList = await service.listForUser(adminId);
      expect(adminList.items).toHaveLength(0);
    });

    it('deduplicates recipients when the same userId appears multiple times in a single event', async () => {
      const items = await service.notifyProjectLeaderAssigned({
        actorId: adminId,
        recipientUserIds: [userBId, userBId, userBId],
        organizationId: orgId,
        projectId,
        projectName: 'Alpha',
        eventId: 'evt-dedup',
      });

      expect(items).toHaveLength(1);
      const userBList = await service.listForUser(userBId);
      expect(userBList.items).toHaveLength(1);
      expect(userBList.unreadCount).toBe(1);
    });
  });

  describe('Rule 3: Created after successful mutation & NOT created when mutation fails', () => {
    it('emits ORGANIZATION_MEMBER_INVITED, ORGANIZATION_MEMBER_ADDED, ORGANIZATION_MEMBER_REMOVED only on success', async () => {
      const invitationId = new Types.ObjectId().toHexString();
      const membershipId = new Types.ObjectId().toHexString();

      let shouldFail = false;
      const mockOrgCommandRepo = {
        hasPermission: jest.fn(async () => true),
        execute: jest.fn(
          async ({ command }: { command: { command: string } }) => {
            if (shouldFail) {
              throw new ConflictException({ code: 'ALREADY_PENDING' });
            }
            return {
              httpStatus: 200,
              replayed: false,
              body: {
                operationId: new Types.ObjectId().toHexString(),
                membership: {
                  id: membershipId,
                  organizationId: orgId,
                  userId: userBId,
                  status: command.command === 'REMOVE' ? 'REMOVED' : 'ACTIVE',
                  version: 2,
                },
                invitation: {
                  id: invitationId,
                  status: 'PENDING',
                  version: 1,
                  expiresAt: new Date(Date.now() + 86400000).toISOString(),
                },
              },
            };
          },
        ),
      };

      const orgCommandService = new OrganizationMembershipCommandService(
        mockOrgCommandRepo as never,
        { checkGate: async () => ({ ready: true }) } as never,
        service,
      );

      const actor = {
        id: adminId,
        email: 'admin@example.test',
        name: 'Admin',
        organizationId: orgId,
        roles: ['ADMIN'],
      };

      // 1. Failed mutation -> 0 notifications
      shouldFail = true;
      await expect(
        orgCommandService.execute(actor, orgId, 'idem-key-failed-0001', {
          command: 'INVITE',
          email: 'userb@example.test',
          reasonCode: 'ACCESS_REQUEST',
        }),
      ).rejects.toThrow(ConflictException);
      expect((await service.listForUser(userBId)).items).toHaveLength(0);

      // 2. Successful INVITE -> ORGANIZATION_MEMBER_INVITED
      shouldFail = false;
      await orgCommandService.execute(actor, orgId, 'idem-key-invite-0001', {
        command: 'INVITE',
        email: 'userb@example.test',
        reasonCode: 'ACCESS_REQUEST',
      });

      // 3. Successful RESUME -> ORGANIZATION_MEMBER_ADDED
      await orgCommandService.execute(actor, orgId, 'idem-key-resume-0001', {
        command: 'RESUME',
        membershipId,
        expectedMembershipVersion: 1,
        reasonCode: 'ACCESS_REQUEST',
      });

      // 4. Successful REMOVE -> ORGANIZATION_MEMBER_REMOVED
      await orgCommandService.execute(actor, orgId, 'idem-key-remove-0001', {
        command: 'REMOVE',
        membershipId,
        expectedMembershipVersion: 2,
        reasonCode: 'ACCESS_REVIEW',
      });

      const list = await service.listForUser(userBId);
      const types = list.items.map((i) => i.type);
      expect(types).toEqual([
        'ORGANIZATION_MEMBER_REMOVED',
        'ORGANIZATION_MEMBER_ADDED',
        'ORGANIZATION_MEMBER_INVITED',
      ]);

      // Also verify invitation acceptance creates ORGANIZATION_MEMBER_ADDED
      const acceptInvitationId = new Types.ObjectId().toHexString();
      const mockInvitationRepo = {
        acceptForRecipient: jest.fn(async () => ({
          replayed: false,
          acknowledgement: {
            operationId: new Types.ObjectId().toHexString(),
            membership: {
              id: membershipId,
              organizationId: orgId,
              userId: userCId,
              status: 'ACTIVE' as const,
              version: 1,
            },
            invitation: {
              id: acceptInvitationId,
              status: 'ACCEPTED' as const,
              version: 2,
              expiresAt: new Date(Date.now() + 86400000).toISOString(),
            },
          },
        })),
      };
      const invitationService = new OrganizationInvitationService(
        mockInvitationRepo as never,
        { checkGate: async () => ({ ready: true }) } as never,
        service,
      );
      await invitationService.accept(
        {
          id: userCId,
          email: 'userc@example.test',
          name: 'User C',
          context: 'ACCOUNT',
        },
        acceptInvitationId,
        0,
        1,
        'idem-accept-invitation-001',
      );
      const userCList = await service.listForUser(userCId);
      expect(userCList.items).toHaveLength(1);
      expect(userCList.items[0].type).toBe('ORGANIZATION_MEMBER_ADDED');
    });

    it('emits all 5 PROJECT notification types (MEMBER_ADDED, MEMBER_REMOVED, LEADER_ASSIGNED, LEADER_CHANGED, LEADER_REVOKED)', async () => {
      const mockProjectRepo = {
        create: jest.fn(async () => ({
          id: projectId,
          organizationId: orgId,
          code: 'PRJ',
          name: 'Phoenix',
          description: null,
          visibility: 'PRIVATE' as const,
          status: 'ACTIVE' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })),
      };
      const projectService = new ProjectService(
        mockProjectRepo as never,
        service,
      );
      const actor = {
        id: adminId,
        email: 'admin@example.test',
        name: 'Admin',
        organizationId: orgId,
        roles: ['ADMIN'],
      };

      await projectService.create(actor, {
        code: 'PRJ',
        name: 'Phoenix',
        visibility: 'PRIVATE',
        initialLeaderUserIds: [adminId, userBId],
        initialMemberUserIds: [userBId, userCId],
      });

      // userB was in both initialLeaderUserIds and initialMemberUserIds -> gets PROJECT_LEADER_ASSIGNED once
      // userC was in initialMemberUserIds -> gets PROJECT_MEMBER_ADDED
      // adminId was actor -> gets nothing
      expect((await service.listForUser(adminId)).items).toHaveLength(0);
      expect((await service.listForUser(userBId)).items[0].type).toBe(
        'PROJECT_LEADER_ASSIGNED',
      );
      expect((await service.listForUser(userCId)).items[0].type).toBe(
        'PROJECT_MEMBER_ADDED',
      );

      const mockAccessRepo = {
        addMember: jest.fn(async () => ({
          id: new Types.ObjectId().toHexString(),
          projectId,
          userId: userBId,
          role: 'MEMBER' as const,
          status: 'ACTIVE' as const,
          joinedAt: new Date().toISOString(),
        })),
        removeMember: jest.fn(async () => undefined),
        assignLeader: jest.fn(async () => ({
          projectId,
          userId: userBId,
          role: 'TEAM_LEADER' as const,
        })),
        changeLeader: jest.fn(async () => ({
          projectId,
          previousUserId: userBId,
          nextUserId: userCId,
          role: 'TEAM_LEADER' as const,
        })),
        revokeLeader: jest.fn(async () => undefined),
      };
      const accessService = new ProjectAccessService(
        mockAccessRepo as never,
        service,
      );

      await accessService.changeLeader(actor, projectId, userBId, userCId);
      await accessService.revokeLeader(actor, projectId, userCId);
      await accessService.removeMember(actor, projectId, userBId);

      const userBTypes = (await service.listForUser(userBId)).items.map(
        (i) => i.type,
      );
      expect(userBTypes).toContain('PROJECT_LEADER_CHANGED');
      expect(userBTypes).toContain('PROJECT_MEMBER_REMOVED');

      const userCTypes = (await service.listForUser(userCId)).items.map(
        (i) => i.type,
      );
      expect(userCTypes).toContain('PROJECT_LEADER_CHANGED');
      expect(userCTypes).toContain('PROJECT_LEADER_REVOKED');
    });
  });

  describe('Task Assigned & Deadline Scheduler Idempotency', () => {
    it('emits TASK_ASSIGNED when task is assigned to another user and deduplicates scheduler runs for TASK_DEADLINE_APPROACHING and TASK_DEADLINE_OVERDUE', async () => {
      const createdTaskDoc = {
        _id: new Types.ObjectId(taskId),
        organizationId: new Types.ObjectId(orgId),
        projectId: new Types.ObjectId(projectId),
        key: 'PRJ-1',
        sequenceNumber: 1,
        title: 'Ship Notification MVP',
        description: null,
        type: 'TASK' as const,
        status: 'TODO' as const,
        priority: 'HIGH' as const,
        assigneeId: new Types.ObjectId(userBId),
        createdBy: new Types.ObjectId(adminId),
        parentId: null,
        sprintId: null,
        labels: [],
        steps: [],
        dueDate: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2h from now -> approaching
        startDate: null,
        completedAt: null,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockTaskRepo = {
        claimIdempotency: jest.fn(async () => ({
          kind: 'CLAIMED' as const,
          claimId: 'claim-1',
        })),
        createTaskWithEvent: jest.fn(async () => createdTaskDoc),
        releaseIdempotency: jest.fn(async () => undefined),
      };
      const mockIamBridge = {
        resolveProjectContext: jest.fn(async () => ({
          actorId: adminId,
          actorName: 'Admin',
          organizationId: orgId,
          projectId,
          projectCode: 'PRJ',
          projectName: 'Phoenix',
          actorRole: 'ADMIN' as const,
        })),
        isActiveProjectMember: jest.fn(async () => true),
      };

      const taskService = new TaskWorkspaceService(
        mockTaskRepo as never,
        mockIamBridge as never,
        service,
        scheduler,
      );

      await taskService.createProjectTask({
        cookieHeader: '__Host-csrf=token123',
        csrfHeader: 'token123',
        idempotencyKeyHeader: 'idem-task-create-001',
        projectId,
        body: {
          title: 'Ship Notification MVP',
          assigneeId: userBId,
          dueDate: createdTaskDoc.dueDate.toISOString(),
        },
      });

      // Running evaluateSingleTask multiple times for the same approaching deadline must NOT create duplicates
      await scheduler.evaluateSingleTask({
        id: taskId,
        organizationId: orgId,
        projectId,
        title: 'Ship Notification MVP',
        status: 'TODO',
        assigneeId: userBId,
        dueDate: createdTaskDoc.dueDate,
      });
      await scheduler.evaluateSingleTask({
        id: taskId,
        organizationId: orgId,
        projectId,
        title: 'Ship Notification MVP',
        status: 'TODO',
        assigneeId: userBId,
        dueDate: createdTaskDoc.dueDate,
      });

      let bNotifications = (await service.listForUser(userBId)).items;
      expect(
        bNotifications.filter((n) => n.type === 'TASK_ASSIGNED'),
      ).toHaveLength(1);
      expect(
        bNotifications.filter((n) => n.type === 'TASK_DEADLINE_APPROACHING'),
      ).toHaveLength(1);

      // Now simulate time passing past dueDate -> TASK_DEADLINE_OVERDUE (idempotent across multiple runs)
      const afterDue = new Date(
        createdTaskDoc.dueDate.getTime() + 60 * 60 * 1000,
      );
      await scheduler.evaluateSingleTask(
        {
          id: taskId,
          organizationId: orgId,
          projectId,
          title: 'Ship Notification MVP',
          status: 'IN_PROGRESS',
          assigneeId: userBId,
          dueDate: createdTaskDoc.dueDate,
        },
        afterDue,
      );
      await scheduler.evaluateSingleTask(
        {
          id: taskId,
          organizationId: orgId,
          projectId,
          title: 'Ship Notification MVP',
          status: 'IN_PROGRESS',
          assigneeId: userBId,
          dueDate: createdTaskDoc.dueDate,
        },
        afterDue,
      );

      bNotifications = (await service.listForUser(userBId)).items;
      expect(
        bNotifications.filter((n) => n.type === 'TASK_DEADLINE_OVERDUE'),
      ).toHaveLength(1);
    });
  });

  describe('Work Note Mention & Chat Mention Rules', () => {
    it('creates WORK_NOTE_MENTION for mentioned users (excluding author) and enforces deleted note state', async () => {
      const mockIamBridge = {
        resolveProjectContext: jest.fn(async () => ({
          actorId: adminId,
          actorName: 'Admin',
          organizationId: orgId,
          projectId,
          projectCode: 'PRJ',
          projectName: 'Phoenix',
          actorRole: 'ADMIN' as const,
        })),
        isActiveProjectMember: jest.fn(async () => true),
        resolveUsersById: jest.fn(async () => new Map()),
      };
      const workNotesService = new ProjectWorkNotesService(
        mockIamBridge as never,
        service,
      );

      const note = await workNotesService.createProjectWorkNote({
        authorizationHeader: `Bearer ${adminId}`,
        projectId,
        body: {
          title: 'Architecture Sync Note',
          content: 'Discussed notification center with team.',
          summary: 'Notification MVP design',
          mentionUserIds: [adminId, userBId, userBId],
        },
      });

      // Author (adminId) does not receive self-mention; userB receives exactly 1 WORK_NOTE_MENTION
      expect((await service.listForUser(adminId)).items).toHaveLength(0);
      const userBList = await service.listForUser(userBId);
      expect(userBList.items).toHaveLength(1);
      expect(userBList.items[0].type).toBe('WORK_NOTE_MENTION');
      expect(userBList.items[0].target?.url).toBe(
        `/projects/${projectId}/work-notes?noteId=${encodeURIComponent(note.id)}`,
      );

      // Delete the work note -> getProjectWorkNote throws 404 WORK_NOTE_NOT_FOUND with safe message
      await workNotesService.deleteProjectWorkNote({
        authorizationHeader: `Bearer ${adminId}`,
        projectId,
        noteId: note.id,
      });

      await expect(
        workNotesService.getProjectWorkNote({
          authorizationHeader: `Bearer ${userBId}`,
          projectId,
          noteId: note.id,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('creates CHAT_MENTION when a chat message mentions a user, and does NOT create notification for normal chat messages', async () => {
      const mockChatRepo = {
        isMember: jest.fn(async () => true),
        memberIds: jest.fn(async () => [adminId, userBId, userCId]),
        sendMessage: jest.fn(
          async (
            _actor: unknown,
            convId: string,
            _clientMsgId: string,
            content: string,
            _attachments: string[],
            _replyTo: string | undefined,
            mentionUserIds?: string[],
          ) => ({
            recipientIds: [adminId, userBId, userCId],
            message: {
              id: messageId,
              conversationId: convId,
              senderId: adminId,
              senderName: 'Admin',
              senderAvatarUrl: null,
              content,
              mentionUserIds: mentionUserIds ?? [],
              createdAt: new Date().toISOString(),
              editedAt: null,
              deletedAt: null,
              replyToMessageId: null,
              replyTo: null,
              attachments: [],
              reactions: [],
            },
          }),
        ),
      };
      const mockChatIam = {
        getActor: jest.fn(async () => ({
          id: adminId,
          organizationId: orgId,
          displayName: 'Admin',
          avatarUrl: null,
        })),
      };
      const mockRedis = {
        consumeRateLimit: jest.fn(async () => true),
        incr: jest.fn(async () => 1),
      };
      const mockRealtime = {
        publishConversationEvent: jest.fn(async () => undefined),
      };
      const mockConfig = {
        get: jest.fn(() => 'continuum'),
      } as unknown as ConfigService;

      const chatService = new ChatApplicationService(
        mockChatRepo as never,
        mockChatIam as never,
        mockRedis as never,
        mockRealtime as never,
        {} as never,
        {} as never,
        mockConfig,
        service,
      );

      // 1. Normal chat message without mentions -> 0 Notification Center items
      await chatService.sendMessage({}, conversationId, {
        clientMessageId: '11111111-1111-4111-8111-111111111111',
        content: 'Hello everyone, normal message!',
      });
      expect((await service.listForUser(userBId)).items).toHaveLength(0);
      expect((await service.listForUser(userCId)).items).toHaveLength(0);

      // 2. Chat message with mentionUserIds -> creates CHAT_MENTION only for mentioned user (not sender, not unmentioned member)
      await chatService.sendMessage({}, conversationId, {
        clientMessageId: '22222222-2222-4222-8222-222222222222',
        content: 'Hey @UserB please check this!',
        mentionUserIds: [userBId],
      });

      const userBList = await service.listForUser(userBId);
      expect(userBList.items).toHaveLength(1);
      expect(userBList.items[0].type).toBe('CHAT_MENTION');
      expect(userBList.items[0].message).toBe('You were mentioned in a chat');
      expect((await service.listForUser(userCId)).items).toHaveLength(0);
      expect((await service.listForUser(adminId)).items).toHaveLength(0);
    });
  });

  describe('Ownership, Read/Unread State & Realtime Failure Resilience', () => {
    it('prevents User A from reading or marking User B notifications, and supports markAsRead & markAllAsRead', async () => {
      const [notif1] = await service.notifyTaskAssigned({
        actorId: adminId,
        assigneeUserId: userBId,
        organizationId: orgId,
        projectId,
        taskId,
        taskTitle: 'Task 1',
        eventId: 'e1',
      });
      await service.notifyTaskAssigned({
        actorId: adminId,
        assigneeUserId: userBId,
        organizationId: orgId,
        projectId,
        taskId,
        taskTitle: 'Task 2',
        eventId: 'e2',
      });

      // User C cannot see User B's notifications
      const userCList = await controller.listNotifications(
        `Bearer ${userCId}`,
        undefined,
        undefined,
        undefined,
        undefined,
      );
      expect(userCList.items).toHaveLength(0);
      expect(userCList.unreadCount).toBe(0);

      // User C cannot mark User B's notification as read (IDOR protection)
      await expect(
        controller.markAsRead(
          `Bearer ${userCId}`,
          undefined,
          undefined,
          notif1.id,
        ),
      ).rejects.toThrow(NotFoundException);

      // User C cannot resolve User B's notification target
      await expect(
        controller.resolveTarget(`Bearer ${userCId}`, undefined, notif1.id),
      ).rejects.toThrow(NotFoundException);

      // User B sees unreadCount = 2
      const countBefore = await controller.getUnreadCount(
        `Bearer ${userBId}`,
        undefined,
      );
      expect(countBefore.count).toBe(2);

      // User B marks 1 notification as read
      const marked = await controller.markAsRead(
        `Bearer ${userBId}`,
        undefined,
        undefined,
        notif1.id,
      );
      expect(marked.readAt).not.toBeNull();

      const countAfterOne = await controller.getUnreadCount(
        `Bearer ${userBId}`,
        undefined,
      );
      expect(countAfterOne.count).toBe(1);

      // User B marks all as read
      const markAll = await controller.markAllAsRead(
        `Bearer ${userBId}`,
        undefined,
        undefined,
      );
      expect(markAll.updatedCount).toBe(1);

      const countAfterAll = await controller.getUnreadCount(
        `Bearer ${userBId}`,
        undefined,
      );
      expect(countAfterAll.count).toBe(0);
    });

    it('Rule 6: persists notification even if realtime delivery throws', async () => {
      jest.spyOn(realtimeBus, 'publishCreated').mockImplementation(() => {
        throw new Error('Simulated WebSocket/Redis failure');
      });

      const items = await service.notifyProjectMemberAdded({
        actorId: adminId,
        recipientUserIds: [userBId],
        organizationId: orgId,
        projectId,
        projectName: 'Resilient Project',
        eventId: 'ws-fail-test',
      });

      // Wait: publishCreated handles errors internally; even if it threw, emitSafe catches and DB already persisted
      expect(items).toHaveLength(1);
      const list = await service.listForUser(userBId);
      expect(list.items).toHaveLength(1);
      expect(list.items[0].message).toContain('Resilient Project');
    });

    it('Rule 4 & Rule 5: enforces current ACL (FORBIDDEN after removal from private project) and safe DELETED state on target resolution', async () => {
      let projectDeleted = false;
      let userHasProjectMembership = false;

      const mockCollectionMap: Record<string, { findOne: jest.Mock }> = {
        projects: {
          findOne: jest.fn(async () =>
            projectDeleted
              ? {
                  _id: new Types.ObjectId(projectId),
                  organizationId: new Types.ObjectId(orgId),
                  visibility: 'PRIVATE',
                  status: 'DELETED',
                  deletedAt: new Date(),
                }
              : {
                  _id: new Types.ObjectId(projectId),
                  organizationId: new Types.ObjectId(orgId),
                  visibility: 'PRIVATE',
                  status: 'ACTIVE',
                  deletedAt: null,
                },
          ),
        },
        organization_memberships: {
          findOne: jest.fn(async () => ({
            organizationId: new Types.ObjectId(orgId),
            userId: new Types.ObjectId(userBId),
            status: 'ACTIVE',
          })),
        },
        user_role_assignments: {
          findOne: jest.fn(async () => null),
        },
        project_memberships: {
          findOne: jest.fn(async () =>
            userHasProjectMembership
              ? {
                  organizationId: new Types.ObjectId(orgId),
                  projectId: new Types.ObjectId(projectId),
                  userId: new Types.ObjectId(userBId),
                  status: 'ACTIVE',
                }
              : null,
          ),
        },
        tasks: {
          findOne: jest.fn(async () => ({
            _id: new Types.ObjectId(taskId),
            projectId: new Types.ObjectId(projectId),
            deletedAt: null,
          })),
        },
      };

      const mockConn = {
        useDb: jest.fn(() => ({
          models: {},
          model: undefined,
          db: {
            collection: (name: string) => mockCollectionMap[name] ?? null,
          },
        })),
      };

      const [notif] = await service.notifyTaskAssigned({
        actorId: adminId,
        assigneeUserId: userBId,
        organizationId: orgId,
        projectId,
        taskId,
        taskTitle: 'Confidential Private Task',
        eventId: 'acl-test-1',
      });

      const aclRepo = new NotificationCenterRepository(mockConn as never);

      // 1. User B was removed from the PRIVATE project -> FORBIDDEN ("This content is no longer available")
      userHasProjectMembership = false;
      const forbiddenResolution = await aclRepo.resolveTargetAccess(
        userBId,
        notif,
      );
      expect(forbiddenResolution.available).toBe(false);
      expect(forbiddenResolution.reason).toBe('FORBIDDEN');
      expect(forbiddenResolution.message).toBe(
        'This content is no longer available',
      );
      expect(forbiddenResolution.target).toBeNull();

      // 2. User B is an active project member -> OK
      userHasProjectMembership = true;
      const allowedResolution = await aclRepo.resolveTargetAccess(
        userBId,
        notif,
      );
      expect(allowedResolution.available).toBe(true);
      expect(allowedResolution.reason).toBe('OK');

      // 3. Project is deleted -> DELETED ("Content is no longer available.")
      projectDeleted = true;
      const deletedResolution = await aclRepo.resolveTargetAccess(
        userBId,
        notif,
      );
      expect(deletedResolution.available).toBe(false);
      expect(deletedResolution.reason).toBe('DELETED');
      expect(deletedResolution.message).toBe('Content is no longer available.');
      expect(deletedResolution.target).toBeNull();
    });
  });
});
