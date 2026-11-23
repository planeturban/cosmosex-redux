# m68k-atari-mint cross tools (Vincent Rivière's PPA, gcc 4.6.4: a.out
# .PRG as the CosmosEx release's ST programs were built with)
FROM --platform=linux/amd64 ubuntu:22.04
RUN apt-get update && apt-get install -y --no-install-recommends software-properties-common gpg-agent make \
 && add-apt-repository -y ppa:vriviere/ppa && apt-get update \
 && apt-get install -y --no-install-recommends cross-mint-essential \
 && rm -rf /var/lib/apt/lists/*
