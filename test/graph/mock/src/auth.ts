import { UserService } from './user';
export class AuthService {
  private users = new UserService();
  authenticate(u: string): string { return this.users.login(u); }
}
