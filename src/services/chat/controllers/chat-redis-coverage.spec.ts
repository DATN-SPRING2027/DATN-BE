import 'reflect-metadata';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ChatController } from './chat.controller';
import { ChatFeaturesController } from './chat-features.controller';
import { ChatTrafficGuard } from './chat-traffic.guard';
import { GatewayChatController } from '../../../gateway/gateway-chat.controller';

it('requires the authenticated Redis traffic guard on every Chat business route', () => {
  const gatewayRoutes = new Set(
    Object.getOwnPropertyNames(GatewayChatController.prototype).flatMap(
      (key) => {
        const method: unknown = Object.getOwnPropertyDescriptor(
          GatewayChatController.prototype,
          key,
        )?.value;
        return typeof method === 'function' &&
          Reflect.hasMetadata(PATH_METADATA, method)
          ? [
              `${String(Reflect.getMetadata('method', method))}:${String(Reflect.getMetadata(PATH_METADATA, method))}`,
            ]
          : [];
      },
    ),
  );
  for (const controller of [ChatController, ChatFeaturesController]) {
    expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toContain(
      ChatTrafficGuard,
    );
    const routes = Object.getOwnPropertyNames(controller.prototype).filter(
      (key) =>
        key !== 'constructor' &&
        Reflect.hasMetadata(
          PATH_METADATA,
          Object.getOwnPropertyDescriptor(controller.prototype, key)!
            .value as object,
        ),
    );
    expect(routes.length).toBeGreaterThan(10);
    for (const key of routes) {
      const method = Object.getOwnPropertyDescriptor(controller.prototype, key)!
        .value as object;
      expect(
        gatewayRoutes.has(
          `${String(Reflect.getMetadata('method', method))}:chat/${String(Reflect.getMetadata(PATH_METADATA, method))}`,
        ),
      ).toBe(true);
    }
  }
});
