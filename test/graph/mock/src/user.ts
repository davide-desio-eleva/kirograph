import { Database } from './database';
import { generateToken } from './token';
export class UserService {
  private db = new Database();
  login(username: string): string { return generateToken(this.db); }
  findAll(): unknown[] { return this.db.query('SELECT * FROM users'); }
}
