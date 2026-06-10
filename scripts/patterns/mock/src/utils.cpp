#include <iostream>
#include <string>
#include <cstring>

// command-injection-cpp: system() with variable
void run_cmd(const std::string& input) {
    system(input.c_str());
}

// unsafe-string-cpp: strcpy
void copy_input(char* dst, const char* src) {
    strcpy(dst, src);
}

std::string greet(const std::string& name) {
    return "Hello, " + name + "!";
}

int multiply(int a, int b) {
    return a * b;
}
