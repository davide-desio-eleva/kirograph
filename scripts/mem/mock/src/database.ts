export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export class DatabaseConnection {
  private connected = false;

  async connect(url: string): Promise<void> {
    this.connected = true;
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    if (!this.connected) throw new Error('Not connected');
    return { rows: [], rowCount: 0 };
  }

  async transaction<T>(fn: (db: DatabaseConnection) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }
}

export class UserRepository {
  constructor(private db: DatabaseConnection) {}

  async findById(id: string) {
    return this.db.query('SELECT * FROM users WHERE id = $1', [id]);
  }

  async create(email: string, passwordHash: string) {
    return this.db.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING *',
      [email, passwordHash]
    );
  }
}
