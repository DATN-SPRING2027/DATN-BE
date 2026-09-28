import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApplication } from '../src/bootstrap';
import { GatewayIamController } from '../src/gateway/gateway-iam.controller';
import { AuthenticationApplicationService } from '../src/services/iam/application/authentication/authentication.application.service';
import { AuthenticationController } from '../src/services/iam/controllers/authentication.controller';

const secret = 'test-gateway-secret-at-least-32-characters';

describe('Gateway to IAM source IP over HTTP', () => {
  let gateway: INestApplication;
  let iam: INestApplication;

  afterEach(async () => {
    await gateway?.close();
    await iam?.close();
  });

  it('preserves the client IP through a non-loopback IAM peer', async () => {
    const login = jest.fn().mockResolvedValue({
      accessToken: 'private.jwt.value',
      user: { id: 'user-1', email: 'person@example.test' },
    });
    const iamModule = await Test.createTestingModule({
      controllers: [AuthenticationController],
      providers: [
        { provide: AuthenticationApplicationService, useValue: { login } },
        { provide: ConfigService, useValue: { get: () => secret } },
      ],
    }).compile();
    iam = iamModule.createNestApplication();
    iam.setGlobalPrefix('internal');
    let iamPeer = '';
    iam.use((req: Request, _res: Response, next: NextFunction) => {
      Object.defineProperty(req.socket, 'remoteAddress', {
        configurable: true,
        value: '10.1.2.3',
      });
      iamPeer = req.socket.remoteAddress ?? '';
      next();
    });
    await iam.listen(0, '127.0.0.1');
    const iamAddress = (iam.getHttpServer() as Server).address() as AddressInfo;

    const gatewayModule = await Test.createTestingModule({
      controllers: [GatewayIamController],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: (name: string) =>
              name === 'IAM_SERVICE_URL'
                ? `http://127.0.0.1:${iamAddress.port}`
                : name === 'IAM_GATEWAY_SECRET'
                  ? secret
                  : 5000,
          },
        },
      ],
    }).compile();
    gateway = gatewayModule.createNestApplication();
    configureApplication(gateway, ['loopback']);
    await gateway.init();

    const response = await request(gateway.getHttpServer() as App)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '192.0.2.9, 203.0.113.7')
      .send({ email: 'person@example.test', password: 'password' })
      .expect(200);
    expect(iamPeer).toBe('10.1.2.3');
    const calls = login.mock.calls as unknown[][];
    expect(calls[0][0]).toMatchObject({ sourceIp: '203.0.113.7' });
    expect(response.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(JSON.stringify(response.body)).not.toContain('private.jwt.value');
  });
});
