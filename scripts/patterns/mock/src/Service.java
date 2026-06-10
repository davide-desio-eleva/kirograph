import java.sql.*;

public class Service {

    // sql-injection-java
    public void getUserById(Connection conn, String userId) throws SQLException {
        Statement stmt = conn.createStatement();
        stmt.executeQuery("SELECT * FROM users WHERE id = " + userId);
    }

    public void deleteRecord(Connection conn, String table, String id) throws SQLException {
        Statement stmt = conn.createStatement();
        stmt.execute("DELETE FROM " + table + " WHERE id = " + id);
    }

    public void updateName(Connection conn, String name, String id) throws SQLException {
        Statement stmt = conn.createStatement();
        stmt.executeUpdate("UPDATE users SET name = '" + name + "' WHERE id = " + id);
    }

    // dangerous-reflection-java
    public Object loadPlugin(String className) throws Exception {
        return Class.forName(className).getDeclaredConstructor().newInstance();
    }
}
