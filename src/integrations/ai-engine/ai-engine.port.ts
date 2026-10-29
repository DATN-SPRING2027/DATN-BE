export const AI_ENGINE_CLIENT = Symbol('AI_ENGINE_CLIENT');

export type AiEngineHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type AiEngineRequest = Readonly<{
  path: string;
  method: AiEngineHttpMethod;
  headers: Readonly<Record<string, string>>;
  body?: unknown;
}>;

export type AiEngineResponse<TResponse> = Readonly<{
  status: number;
  body: TResponse;
}>;

export type AiEngineStreamRequest = Readonly<{
  path: string;
  method: 'POST';
  headers: Readonly<Record<string, string>>;
  body?: unknown;
  signal?: AbortSignal;
}>;

export type AiEngineStreamResponse = Readonly<{
  status: number;
  contentType: string | null;
  stream: ReadableStream<Uint8Array>;
}>;

export interface AiEngineClient {
  request<TResponse>(
    request: AiEngineRequest,
  ): Promise<AiEngineResponse<TResponse>>;

  requestStream(
    request: AiEngineStreamRequest,
  ): Promise<AiEngineStreamResponse>;
}
