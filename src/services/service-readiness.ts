export type DependencyReadiness = 'AVAILABLE' | 'UNAVAILABLE';

export interface ServiceReadinessSnapshot {
  status: 'READY' | 'DEGRADED' | 'UNAVAILABLE';
  liveness: 'ALIVE';
  dependencies: {
    mongodb: DependencyReadiness;
    redis: DependencyReadiness;
  };
  checkedAt: string;
}

export function createReadinessSnapshot(
  mongodbAvailable: boolean,
  redisAvailable: boolean,
  checkedAt = new Date(),
): ServiceReadinessSnapshot {
  const availableCount = Number(mongodbAvailable) + Number(redisAvailable);
  return {
    status:
      availableCount === 2
        ? 'READY'
        : availableCount === 1
          ? 'DEGRADED'
          : 'UNAVAILABLE',
    liveness: 'ALIVE',
    dependencies: {
      mongodb: mongodbAvailable ? 'AVAILABLE' : 'UNAVAILABLE',
      redis: redisAvailable ? 'AVAILABLE' : 'UNAVAILABLE',
    },
    checkedAt: checkedAt.toISOString(),
  };
}
