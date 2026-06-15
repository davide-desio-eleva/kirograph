export interface AuthToken {
  userId: string;
  expiresAt: number;
  scopes: string[];
}

export class AuthService {
  private tokenStore = new Map<string, AuthToken>();

  issueToken(userId: string, scopes: string[]): string {
    const token = crypto.randomUUID();
    this.tokenStore.set(token, { userId, expiresAt: Date.now() + 3600_000, scopes });
    return token;
  }

  validateToken(token: string): AuthToken | null {
    const entry = this.tokenStore.get(token);
    if (!entry || entry.expiresAt < Date.now()) return null;
    return entry;
  }

  revokeToken(token: string): void {
    this.tokenStore.delete(token);
  }
}

export function hashPassword(password: string): string {
  return Buffer.from(password).toString('base64');
}
