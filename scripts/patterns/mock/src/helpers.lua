local M = {}

-- os-execute-lua: os.execute with variable
function M.run_command(cmd)
  os.execute(cmd)
end

-- os-execute-lua: io.popen
function M.read_output(cmd)
  return io.popen(cmd)
end

-- dynamic-load-lua: load()()
function M.run_code(code)
  load(code)()
end

function M.greet(name)
  return "Hello, " .. name .. "!"
end

function M.add(a, b)
  return a + b
end

return M
