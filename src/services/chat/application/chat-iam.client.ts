import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { ChatActor, ChatCandidate } from './chat.repository';

export interface ChatCredentials {
  authorization?: string;
  cookie?: string;
}

export interface ChatSessionBinding {
  tokenHash: string;
  expiresAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class ChatIamClient {
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .getOrThrow<string>('IAM_SERVICE_URL')
      .replace(/\/+$/, '');
  }

  async getActor(credentials: ChatCredentials): Promise<ChatActor> {
    const identity = await this.request('/internal/auth/me', credentials);
    if (
      !isRecord(identity) ||
      typeof identity.id !== 'string' ||
      !/^[a-f\d]{24}$/i.test(identity.id) ||
      typeof identity.name !== 'string' ||
      typeof identity.organizationId !== 'string' ||
      !/^[a-f\d]{24}$/i.test(identity.organizationId)
    ) {
      throw new ServiceUnavailableException({
        code: 'CHAT_IDENTITY_INVALID',
        message: 'Identity service returned an invalid response.',
      });
    }
    const avatarUrl =
      typeof identity.avatarUrl === 'string' ? identity.avatarUrl : null;
    return {
      id: identity.id,
      name: identity.name,
      organizationId: identity.organizationId,
      avatarUrl,
    };
  }

  async searchCandidates(
    credentials: ChatCredentials,
    search = '',
  ): Promise<{
    actorId: string;
    organizationId: string;
    data: ChatCandidate[];
  }> {
    const trimmed = search.trim();
    const query = trimmed ? `?search=${encodeURIComponent(trimmed)}` : '';
    const result = await this.request(
      `/internal/iam/chat-candidates${query}`,
      credentials,
    );
    if (
      !isRecord(result) ||
      !isRecord(result.actor) ||
      typeof result.actor.id !== 'string' ||
      !/^[a-f\d]{24}$/i.test(result.actor.id) ||
      typeof result.actor.organizationId !== 'string' ||
      !/^[a-f\d]{24}$/i.test(result.actor.organizationId) ||
      !Array.isArray(result.data) ||
      !result.data.every((candidate) => this.isCandidate(candidate))
    ) {
      throw new ServiceUnavailableException({
        code: 'CHAT_CANDIDATES_INVALID',
        message: 'Identity service returned an invalid response.',
      });
    }
    return {
      actorId: result.actor.id,
      organizationId: result.actor.organizationId,
      data: result.data,
    };
  }

  async getCandidates(
    credentials: ChatCredentials,
    userIds: string[],
  ): Promise<{ actor: ChatActor; data: ChatCandidate[] }> {
    const result = await this.request(
      '/internal/iam/chat-candidates/resolve',
      credentials,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userIds }),
      },
    );
    if (
      !isRecord(result) ||
      !isRecord(result.actor) ||
      typeof result.actor.id !== 'string' ||
      !/^[a-f\d]{24}$/i.test(result.actor.id) ||
      typeof result.actor.name !== 'string' ||
      typeof result.actor.organizationId !== 'string' ||
      !/^[a-f\d]{24}$/i.test(result.actor.organizationId) ||
      !Array.isArray(result.data) ||
      !result.data.every((candidate) => this.isCandidate(candidate))
    ) {
      throw new ServiceUnavailableException({
        code: 'CHAT_CANDIDATES_INVALID',
        message: 'Identity service returned an invalid response.',
      });
    }
    return {
      actor: {
        id: result.actor.id,
        name: result.actor.name,
        organizationId: result.actor.organizationId,
        avatarUrl: null,
      },
      data: result.data,
    };
  }

  getSessionBinding(credentials: ChatCredentials): ChatSessionBinding {
    const token = this.getAccessToken(credentials);
    try {
      const payload = token.split('.')[1];
      if (!payload) throw new Error('Missing access token claims');
      const claims = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as unknown;
      if (
        !isRecord(claims) ||
        typeof claims.exp !== 'number' ||
        claims.exp <= Math.floor(Date.now() / 1000)
      )
        throw new Error('Invalid access token claims');
      return {
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: claims.exp * 1000,
      };
    } catch {
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_FAILED',
        message: 'Authentication failed.',
      });
    }
  }

  getSessionCredential(credentials: ChatCredentials): ChatCredentials {
    return { authorization: `Bearer ${this.getAccessToken(credentials)}` };
  }

  private getAccessToken(credentials: ChatCredentials): string {
    let token = credentials.authorization?.replace(/^Bearer /i, '');
    if (!token && credentials.cookie) {
      const values = credentials.cookie
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.startsWith('continuum_access='));
      if (values.length === 1) {
        try {
          token = decodeURIComponent(
            values[0].slice('continuum_access='.length),
          );
        } catch {
          token = undefined;
        }
      }
    }
    if (!token || token.length > 8192) {
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_FAILED',
        message: 'Authentication failed.',
      });
    }
    return token;
  }

  private isCandidate(value: unknown): value is ChatCandidate {
    return (
      isRecord(value) &&
      typeof value.id === 'string' &&
      /^[a-f\d]{24}$/i.test(value.id) &&
      typeof value.fullName === 'string' &&
      (value.email === undefined || typeof value.email === 'string') &&
      (value.avatarUrl === null || typeof value.avatarUrl === 'string')
    );
  }

  private async request(
    path: string,
    credentials: ChatCredentials,
    options: RequestInit = {},
  ): Promise<unknown> {
    const headers = new Headers(options.headers);
    headers.set('accept', 'application/json');
    if (credentials.authorization) {
      headers.set('authorization', credentials.authorization);
    }
    if (credentials.cookie) headers.set('cookie', credentials.cookie);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(2500),
      });
      if (response.status === 404 && path.startsWith('/internal/')) {
        response = await fetch(
          `${this.baseUrl}${path.replace('/internal/', '/api/v1/')}`,
          {
            ...options,
            headers,
            cache: 'no-store',
            signal: AbortSignal.timeout(2500),
          },
        );
      }
    } catch {
      throw new ServiceUnavailableException({
        code: 'CHAT_IDENTITY_UNAVAILABLE',
        message: 'Identity service is unavailable.',
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_FAILED',
        message: 'Authentication failed.',
      });
    }
    if (response.status === 404 || response.status === 422) {
      throw new NotFoundException({
        code: 'CHAT_PARTICIPANT_UNAVAILABLE',
        message: 'Participant is unavailable in this organization.',
      });
    }
    if (!response.ok) {
      throw new ServiceUnavailableException({
        code: 'CHAT_IDENTITY_UNAVAILABLE',
        message: 'Identity service is unavailable.',
      });
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new ServiceUnavailableException({
        code: 'CHAT_IDENTITY_INVALID',
        message: 'Identity service returned an invalid response.',
      });
    }
  }
}
