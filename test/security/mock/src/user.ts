class Db {
  query(sql: string): object[] { return []; }
}

export class UserService {
  private db = new Db();
  findById(id: string): object | null { return null; }
  findAll(): object[] { return []; }
  login(username: string, password: string): boolean { return false; }
  // Named 'login' on purpose — doesn't match handle/controller/route/request/
  // req/endpoint/action/handler. Regression test for issue #39 follow-up:
  // security flows used to require the caller's own name to look like a
  // controller/handler, missing this exact shape on real code (OWASP Juice
  // Shop's login()/searchProducts() call sequelize.query() the same way).
  authenticate(username: string): object[] {
    return this.db.query(`SELECT * FROM users WHERE username = '${username}'`);
  }
}
