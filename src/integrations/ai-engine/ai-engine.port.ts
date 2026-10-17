export const AI_ENGINE_CLIENT = Symbol('AI_ENGINE_CLIENT');

export type AiEngineRequest = Readonly<{
  path: string;
  method: 'GET' | 'POST';
  headers: Readonly<Record<string, string>>;
  body?: unknown;
}>;

export type AiEngineResponse<TResponse> = Readonly<{
  status: number;
  body: TResponse;
}>;

export interface AiEngineClient {
  request<TResponse>(
    request: AiEngineRequest,
  ): Promise<AiEngineResponse<TResponse>>;
}
