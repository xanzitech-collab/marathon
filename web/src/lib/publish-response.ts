import { NextResponse } from 'next/server.js';

export interface PublishApiResult {
  status: number;
  body: Record<string, unknown>;
}

export function createPublishApiResult(ok: boolean, payload: Record<string, unknown> = {}): PublishApiResult {
  return {
    status: 200,
    body: {
      success: ok,
      ...payload,
    },
  };
}

export function createPublishApiError(message: string, status = 200): PublishApiResult {
  return {
    status,
    body: {
      success: false,
      error: message,
    },
  };
}

export function toNextResponse(result: PublishApiResult) {
  return NextResponse.json(result.body, { status: result.status });
}
