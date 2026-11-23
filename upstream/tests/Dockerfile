# What the tests of upstream/tests run in: Debian 13 with GCC 14 (the compiler
# the build fixes are about), libcurl and the tools the cases use.
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        g++ gcc make git patch unzip ca-certificates libcurl4-openssl-dev python3 curl procps \
    && rm -rf /var/lib/apt/lists/*
