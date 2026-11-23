import { BaseService } from './base';
/** @deprecated use AuthV2 */
export class AuthService extends BaseService {
  process(input: string): string { return input.toUpperCase(); }
  login(user: string): boolean { return this.validate(user); }
}
