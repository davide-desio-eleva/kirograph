#include <stdio.h>
#include <string.h>

/* command-injection-c: system() with variable */
void run_cmd(const char *input) {
    system(input);
}

/* unsafe-string-c: strcpy, gets */
void copy_input(char *dst, const char *src) {
    strcpy(dst, src);
}

void read_line(char *buf) {
    gets(buf);
}

int add(int a, int b) {
    return a + b;
}
