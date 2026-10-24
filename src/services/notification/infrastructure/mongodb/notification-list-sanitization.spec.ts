import { NotificationCenterRepository } from './notification-center.repository';
import type { NotificationItemDto } from '../../notification-center.types';

describe('NotificationCenterRepository list ACL batching', () => {
  it('deduplicates repeated target checks and caps parallel ACL reads', async () => {
    const repository = new NotificationCenterRepository();
    jest
      .spyOn(
        repository as unknown as { activeConnection: () => unknown },
        'activeConnection',
      )
      .mockReturnValue({});

    let activeChecks = 0;
    let maxConcurrentChecks = 0;
    const resolveTargetAccess = jest
      .spyOn(repository, 'resolveTargetAccess')
      .mockImplementation(async () => {
        activeChecks += 1;
        maxConcurrentChecks = Math.max(maxConcurrentChecks, activeChecks);
        await Promise.resolve();
        activeChecks -= 1;
        return {
          available: false,
          reason: 'FORBIDDEN',
          message: 'This content is no longer available',
          target: null,
        };
      });
    const items: NotificationItemDto[] = Array.from(
      { length: 14 },
      (_, index) => ({
        id: `notification-${index}`,
        recipientId: 'recipient-1',
        actorId: null,
        organizationId: '507f1f77bcf86cd799439001',
        projectId: `507f1f77bcf86cd7994390${String(index).padStart(2, '0')}`,
        taskId: null,
        noteId: null,
        conversationId: null,
        type: 'PROJECT_MEMBER_ADDED',
        title: 'Project update',
        message: 'A private project title',
        target: {
          kind: 'PROJECT',
          url: '/projects/project-1',
          organizationId: '507f1f77bcf86cd799439001',
          projectId: `507f1f77bcf86cd7994390${String(index).padStart(2, '0')}`,
        },
        readAt: null,
        createdAt: new Date().toISOString(),
      }),
    );
    items[13] = { ...items[13], ...items[0], id: 'notification-duplicate' };

    const sanitized = await (
      repository as unknown as {
        sanitizeItemsForListing: (
          recipientId: string,
          page: NotificationItemDto[],
        ) => Promise<NotificationItemDto[]>;
      }
    ).sanitizeItemsForListing('recipient-1', items);

    expect(resolveTargetAccess).toHaveBeenCalledTimes(13);
    expect(maxConcurrentChecks).toBeLessThanOrEqual(12);
    expect(
      sanitized.every(
        (item) => item.message === 'This content is no longer available',
      ),
    ).toBe(true);
    expect(
      sanitized.every((item) => item.target?.url === '/notifications'),
    ).toBe(true);
  });
});
