class Cursor:
    def execute(self, query, params=None):
        return query


def by_name(cur: Cursor, name: str):
    cur.execute(f"SELECT * FROM users WHERE name = '{name}'")


def by_id(cur: Cursor, uid: int):
    cur.execute("SELECT * FROM users WHERE id = %s", (uid,))


def concat(cur: Cursor, name: str):
    cur.execute("SELECT * FROM users WHERE name = '" + name + "'")


def formatted(cur: Cursor, name: str):
    cur.execute("SELECT * FROM users WHERE name = '%s'" % name)
