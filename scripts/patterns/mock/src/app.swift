import Foundation

// process-launch-swift: Process().launch()
func runCommand(path: String) {
    let p = Process()
    p.launchPath = path
    p.launch()
}

// sql-injection-swift: execute with string concat
func getUser(db: AnyObject, id: String) {
    let _ = db.execute("SELECT * FROM users WHERE id = " + id)
}

func greet(_ name: String) -> String {
    return "Hello, \(name)!"
}

struct User {
    let id: Int
    let name: String
}

func filterUsers(_ users: [User], minId: Int) -> [User] {
    return users.filter { $0.id >= minId }
}
