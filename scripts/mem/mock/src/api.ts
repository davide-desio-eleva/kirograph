import { AuthService } from './auth';
import { UserRepository } from './database';

export interface ApiRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export class ApiRouter {
  private routes = new Map<string, (req: ApiRequest) => Promise<ApiResponse>>();

  register(method: string, path: string, handler: (req: ApiRequest) => Promise<ApiResponse>): void {
    this.routes.set(`${method}:${path}`, handler);
  }

  async handle(req: ApiRequest): Promise<ApiResponse> {
    const handler = this.routes.get(`${req.method}:${req.path}`);
    if (!handler) return { status: 404, body: { error: 'Not found' } };
    return handler(req);
  }
}

export class RateLimiter {
  private counts = new Map<string, { count: number; resetAt: number }>();

  check(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const entry = this.counts.get(key);
    if (!entry || entry.resetAt < now) {
      this.counts.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count++;
    return true;
  }
}
