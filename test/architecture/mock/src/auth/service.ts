import { Database } from '../core/database';
export class AuthService { private db = new Database(); login(u: string): boolean { return !!this.db.query(u).length; } }
