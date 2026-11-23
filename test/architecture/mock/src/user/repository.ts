import { Database } from '../core/database';
export class UserRepository { private db = new Database(); findAll(): unknown[] { return this.db.query('SELECT * FROM users'); } }
