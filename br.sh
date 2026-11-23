#!/bin/sh
# Run a command inside the Buildroot build container.
#   ./br.sh            -> interactive shell
#   ./br.sh make ...   -> run a command
# The BR2_EXTERNAL tree (this directory) is mounted at /src; Buildroot,
# downloads and output live in the "cosmosex-br-work" volume at /work
# (BR_VOLUME and BR_IMAGE name another volume or container image).
set -e
cd "$(dirname "$0")"
IMAGE=${BR_IMAGE:-cosmosex-br-env}
VOLUME=${BR_VOLUME:-cosmosex-br-work}
docker image inspect $IMAGE >/dev/null 2>&1 || docker build -t $IMAGE docker
docker volume inspect $VOLUME >/dev/null 2>&1 || {
    docker volume create $VOLUME >/dev/null
    docker run --rm -u root -v $VOLUME:/work $IMAGE chown br /work
}
[ $# -eq 0 ] && set -- bash
TTY=-i; [ -t 0 ] && [ -t 1 ] && TTY=-it
exec docker run --rm $TTY -v "$PWD":/src -v $VOLUME:/work $IMAGE "$@"
