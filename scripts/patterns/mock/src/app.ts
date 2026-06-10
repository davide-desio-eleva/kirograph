import * as fs from 'fs';
import { createHash } from 'crypto';

// ── sql-injection-concat-js ───────────────────────────────────────────────────
export function searchUsers(db: any, name: string) {
  return db.query("SELECT * FROM users WHERE name = " + name);
}

export function runQuery(db: any, table: string, id: string) {
  return db.execute("SELECT * FROM " + table + " WHERE id = " + id);
}

// ── sql-injection-template-js ─────────────────────────────────────────────────
export function findByEmail(db: any, email: string) {
  return db.query(`SELECT * FROM users WHERE email = '${email}'`);
}

// ── dangerous-eval-js ─────────────────────────────────────────────────────────
export function runScript(code: string) {
  return eval(code);
}

// ── path-traversal-readfile-js ────────────────────────────────────────────────
export function loadTemplate(req: any) {
  return fs.readFileSync(req.params, 'utf8');
}

export function streamFile(req: any, res: any) {
  return fs.createReadStream(req.query);
}

// ── weak-crypto-md5-js ────────────────────────────────────────────────────────
export function hashToken(token: string) {
  return createHash('md5').update(token).digest('hex');
}

export function legacyHash(data: string) {
  return createHash('sha1').update(data).digest('hex');
}

// ── prototype-pollution-js ────────────────────────────────────────────────────
export function merge(target: any, source: any) {
  target["__proto__"] = source;
}
