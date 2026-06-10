defmodule Helper do
  # os-cmd-elixir: :os.cmd with variable
  def run_command(cmd) do
    :os.cmd(cmd)
  end

  # os-cmd-elixir: System.cmd
  def execute(program, args) do
    System.cmd(program, args)
  end

  # code-eval-elixir: Code.eval_string
  def run_code(code) do
    Code.eval_string(code)
  end

  def greet(name) do
    "Hello, #{name}!"
  end

  def add(a, b) do
    a + b
  end
end
