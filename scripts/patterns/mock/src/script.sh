#!/usr/bin/env bash

# dangerous-eval-bash: eval with variable
run_code() {
  eval "$1"
}

# source-injection-bash: source with variable path
load_config() {
  source "$1"
}

greet() {
  echo "Hello, $1!"
}

add() {
  echo $(($1 + $2))
}
