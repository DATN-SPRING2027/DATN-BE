export const AI_ENGINE_CLIENT = Symbol('AI_ENGINE_CLIENT');

export type AiEngineRequest = Readonly<{
  path: string;
  method: 'GET' | 'POST';
  body?: unknown;
}>;

export interface AiEngineClient {
  request<TResponse>(request: AiEngineRequest): Promise<TResponse>;
}
