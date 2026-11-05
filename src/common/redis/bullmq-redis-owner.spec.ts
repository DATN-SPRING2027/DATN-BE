import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BullMqRedisOwner } from './bullmq-redis-owner';
import * as connection from './redis-connection';

describe('BullMQ shared Redis connection ownership', () => {
  afterEach(() => jest.restoreAllMocks());

  it('closes the factory-owned client after queue module destroy hooks', async () => {
    const calls: string[] = [];
    const client = {
      disconnect: jest.fn(() => calls.push('redis-disconnect')),
    };
    jest
      .spyOn(connection, 'createRedisConnection')
      .mockReturnValue(client as unknown as connection.RedisConnection);
    const module = await Test.createTestingModule({
      providers: [
        ConfigService,
        BullMqRedisOwner,
        {
          provide: 'queue-fixture',
          useValue: { onModuleDestroy: () => calls.push('queue-close') },
        },
      ],
    }).compile();
    await module.init();
    expect(module.get(BullMqRedisOwner).client).toBe(client);
    expect(client.disconnect).not.toHaveBeenCalled();
    await module.close();
    expect(calls).toEqual(['queue-close', 'redis-disconnect']);
  });

  it('keeps independent application contexts isolated', async () => {
    const first = { disconnect: jest.fn() },
      second = { disconnect: jest.fn() };
    jest
      .spyOn(connection, 'createRedisConnection')
      .mockReturnValueOnce(first as unknown as connection.RedisConnection)
      .mockReturnValueOnce(second as unknown as connection.RedisConnection);
    const create = () =>
      Test.createTestingModule({
        providers: [ConfigService, BullMqRedisOwner],
      }).compile();
    const a = await create(),
      b = await create();
    await a.init();
    await b.init();
    await a.close();
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(second.disconnect).not.toHaveBeenCalled();
    await b.close();
    expect(second.disconnect).toHaveBeenCalledTimes(1);
  });
});
