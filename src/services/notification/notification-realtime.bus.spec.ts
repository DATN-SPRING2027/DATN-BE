import {
  NotificationRealtimeBus,
  notificationRealtimeChannel,
  type NotificationRealtimePublisher,
} from './notification-realtime.bus';
import type { NotificationItemDto } from './notification-center.types';

describe('NotificationRealtimeBus', () => {
  it('publishes persisted notification events to the shared Redis channel', async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const publisher: NotificationRealtimePublisher = {
      publish,
    };
    const bus = new NotificationRealtimeBus(publisher);
    const item = {
      id: 'notification-1',
      recipientId: 'user-1',
      organizationId: 'org-1',
      type: 'PROJECT_MEMBER_ADDED',
      target: null,
    } as NotificationItemDto;

    bus.publishCreated(item);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(publish).toHaveBeenCalledWith(
      notificationRealtimeChannel(),
      expect.stringContaining('"version":1'),
    );
    const [, serialized] = publish.mock.calls[0] as [string, string];
    expect(JSON.parse(serialized)).toEqual({
      version: 1,
      payload: {
        organizationId: 'org-1',
        recipientIds: ['user-1'],
        event: 'notification.created',
        data: item,
      },
      traceContext: {},
    });
  });
});
