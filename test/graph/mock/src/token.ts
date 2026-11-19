import { Database } from './database';
export function generateToken(db: Database): string { db.connect(); return 'tok'; }
