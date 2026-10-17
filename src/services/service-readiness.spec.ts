import { createReadinessSnapshot } from './service-readiness';

describe('createReadinessSnapshot', () => {
  const checkedAt = new Date('2026-10-17T00:00:00.000Z');

  it('reports READY only when MongoDB and Redis both answer', () => {
    expect(createReadinessSnapshot(true, true, checkedAt)).toEqual({
      status: 'READY',
      liveness: 'ALIVE',
      dependencies: { mongodb: 'AVAILABLE', redis: 'AVAILABLE' },
      checkedAt: checkedAt.toISOString(),
    });
  });

  it('reports DEGRADED when exactly one dependency answers', () => {
    expect(createReadinessSnapshot(true, false, checkedAt).status).toBe(
      'DEGRADED',
    );
    expect(createReadinessSnapshot(false, true, checkedAt).status).toBe(
      'DEGRADED',
    );
  });

  it('reports UNAVAILABLE when no dependency answers', () => {
    expect(createReadinessSnapshot(false, false, checkedAt)).toMatchObject({
      status: 'UNAVAILABLE',
      dependencies: { mongodb: 'UNAVAILABLE', redis: 'UNAVAILABLE' },
    });
  });
});
