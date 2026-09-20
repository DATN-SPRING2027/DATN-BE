import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports that the process is healthy', () => {
    const controller = new HealthController();

    expect(controller.getHealth()).toEqual({ status: 'ok' });
  });
});
