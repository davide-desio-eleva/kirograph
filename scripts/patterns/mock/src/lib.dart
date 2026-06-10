import 'dart:io';

// process-run-dart: Process.run with variable
void runCommand(String cmd, List<String> args) {
  Process.run(cmd, args);
}

// process-run-dart: Process.start
void startProcess(String cmd, List<String> args) {
  Process.start(cmd, args);
}

// sql-injection-dart: rawQuery with concatenation
void buildQuery(dynamic db, String userId) {
  db.rawQuery('SELECT * FROM users WHERE id = ' + userId);
}

String greet(String name) => 'Hello, $name!';

int add(int a, int b) => a + b;

class User {
  final int id;
  final String name;
  const User({required this.id, required this.name});
}
