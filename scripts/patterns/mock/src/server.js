const fs = require('fs');
const { createHash } = require('crypto');

// ── sql-injection-concat-js ───────────────────────────────────────────────────
function getUserById(db, id) {
  return db.run("SELECT * FROM users WHERE id = " + id);
}

// ── sql-injection-template-js ─────────────────────────────────────────────────
function listOrders(db, userId) {
  return db.exec(`SELECT * FROM orders WHERE user_id = ${userId}`);
}

// ── dangerous-eval-js ─────────────────────────────────────────────────────────
function executeExpression(expr) {
  return eval(expr);
}

// ── path-traversal-readfile-js ────────────────────────────────────────────────
function serveFile(req) {
  return fs.readFileSync(req.body, 'utf8');
}

function openFile(req) {
  return fs.open(req.params, 'r');
}

// ── weak-crypto-md5-js ────────────────────────────────────────────────────────
function checksumMd5(data) {
  return createHash('md5').update(data).digest('hex');
}

// ── prototype-pollution-js ────────────────────────────────────────────────────
function patchObject(obj, key, val) {
  obj.__proto__ = val;
}

module.exports = { getUserById, listOrders, executeExpression, serveFile, checksumMd5, patchObject };
