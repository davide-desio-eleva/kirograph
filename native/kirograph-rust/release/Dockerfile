# Builds the Linux (x64, arm64) and Windows (x64) binaries of kirograph-rust on the release
# machine, with nothing installed on it but Docker. Debian bullseye (glibc 2.31): the binaries
# load on any distribution with that glibc or newer.
FROM rust:1-bullseye

# The compiler of the other architecture: the native one already answers to its triplet name
RUN apt-get update \
 && if [ "$(dpkg --print-architecture)" = "arm64" ]; \
    then CROSS="gcc-x86-64-linux-gnu g++-x86-64-linux-gnu libc6-dev-amd64-cross"; \
    else CROSS="gcc-aarch64-linux-gnu g++-aarch64-linux-gnu libc6-dev-arm64-cross"; fi \
 && apt-get install -y --no-install-recommends $CROSS clang lld llvm \
 && rm -rf /var/lib/apt/lists/*

RUN rustup target add x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu x86_64-pc-windows-msvc \
 && cargo install cargo-xwin --locked

# Cross compilers for whichever Linux the container itself is not
ENV CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc \
    CC_x86_64_unknown_linux_gnu=x86_64-linux-gnu-gcc \
    CXX_x86_64_unknown_linux_gnu=x86_64-linux-gnu-g++ \
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc \
    CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++
