import os
import subprocess
import hashlib
import sqlite3


# ── dangerous-exec-py ─────────────────────────────────────────────────────────
def run_ping(host):
    os.system("ping -c 1 " + host)


def compress_file(path):
    subprocess.call("tar czf out.tar.gz " + path, shell=True)


def fetch_url(url):
    subprocess.run("curl " + url, shell=True)


def spawn_proc(cmd):
    subprocess.Popen(cmd, shell=True)


# ── weak-crypto-py ────────────────────────────────────────────────────────────
def hash_password(password):
    return hashlib.md5(password.encode()).hexdigest()


def legacy_hash(data):
    return hashlib.sha1(data.encode()).hexdigest()


def old_hash(data):
    return hashlib.new('md5', data.encode()).hexdigest()


# ── sql-injection-py ──────────────────────────────────────────────────────────
def get_user(conn, user_id):
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE id = %s" % user_id)
    return cursor.fetchall()


def find_by_name(conn, name):
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE name = '{}'".format(name))
    return cursor.fetchall()
