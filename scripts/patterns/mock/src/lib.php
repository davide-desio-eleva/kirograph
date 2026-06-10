<?php

// command-injection-php
function run_command(string $cmd): string {
    return shell_exec($cmd);
}

function execute(string $cmd): void {
    system($cmd);
}

// dangerous-eval-php
function run_code(string $code): void {
    eval($code);
}

// sql-injection-php
function get_user(int $id): string {
    $q = "SELECT * FROM users WHERE id = " . $id;
    return $q;
}

function greet(string $name): string {
    return "Hello, {$name}!";
}

function add(int $a, int $b): int {
    return $a + $b;
}

class User {
    public function __construct(
        private int $id,
        private string $name
    ) {}

    public function getName(): string {
        return $this->name;
    }
}
