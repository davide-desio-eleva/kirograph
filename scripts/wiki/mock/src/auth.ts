// Auth module — mock source for KiroGraph wiki test project
import { createHmac } from 'crypto';

export interface User {
  id: string;
  email: string;
  role: 'admin' | 'user';
}

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  exp: number;
}

const JWT_SECRET = process.env.JWT_SECRET ?? 'changeme';
const TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes

export function signToken(user: User): string {
  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const [header, body, sig] = token.split('.');
    const expected = createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (sig !== expected) return null;
    const payload: JwtPayload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export class AuthService {
  login(email: string, password: string): string | null {
    // mock: accept any credentials
    const user: User = { id: 'u1', email, role: 'user' };
    return signToken(user);
  }

  logout(_token: string): void {
    // tokens are stateless — nothing to do
  }
}
