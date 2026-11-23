# Build environment for the CosmosEx Buildroot image.
# Buildroot needs a Linux host with a case-sensitive filesystem; on macOS run
# this via ./br.sh (Colima/Docker), which keeps output/ and dl/ in a volume.
FROM debian:12-slim

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        build-essential bash bc binutils bzip2 ca-certificates cpio diffutils \
        file findutils git gzip libncurses-dev locales make patch perl \
        python3 rsync sed tar unzip wget xz-utils which \
    && sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

ARG UID=1000
RUN useradd -m -u ${UID} -s /bin/bash br && mkdir /work && chown br /work
USER br
WORKDIR /work
