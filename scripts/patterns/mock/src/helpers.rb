# command-injection-ruby
def run_command(cmd)
  system(cmd)
end

def execute(cmd)
  exec(cmd)
end

# subshell-injection-ruby
def list_files(dir)
  `ls #{dir}`
end

# dangerous-eval-ruby
def run_code(code)
  eval(code)
end

def add(a, b)
  a + b
end

class User
  attr_reader :id, :name

  def initialize(id, name)
    @id = id
    @name = name
  end
end
