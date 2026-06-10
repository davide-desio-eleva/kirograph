use std::process::Command;

// command-injection-rust: Command::new with variable argument
pub fn run_command(cmd: &str) -> std::io::Result<()> {
    Command::new(cmd).spawn()?;
    Ok(())
}

// unsafe-block-rust: raw pointer dereference
pub fn read_raw(ptr: *const u8) -> u8 {
    unsafe { *ptr }
}

pub fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

fn main() {
    println!("{}", greet("world"));
    println!("{}", add(1, 2));
}
