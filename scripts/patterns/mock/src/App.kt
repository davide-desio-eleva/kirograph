import java.sql.Connection

// command-injection-kotlin: Runtime.exec and ProcessBuilder
fun runCommand(cmd: String) {
    Runtime.getRuntime().exec(cmd)
    ProcessBuilder(cmd).start()
}

// sql-injection-kotlin: executeQuery with string concat
fun getUser(conn: Connection, id: String): String {
    val stmt = conn.createStatement()
    stmt.executeQuery("SELECT * FROM users WHERE id = " + id)
    return id
}

fun greet(name: String): String = "Hello, $name!"

fun filterAdults(users: List<User>) = users.filter { it.age >= 18 }

fun main() {
    println(greet("world"))
}

data class User(val id: Int, val name: String, val age: Int)
