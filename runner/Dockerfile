# sage-infra runner: thin ubuntu image carrying a fresh `sage` binary plus the
# wrapper that executes one (commit x dataset) benchmark on AWS Batch.
#
# The build context is expected to contain:
#   ./sage         pre-built x86_64-linux-gnu release binary (built by GH Actions)
#   ./wrapper.py   from runner/wrapper.py
#
# Base must match the GH Actions runner's glibc (ubuntu-latest -> 24.04 / 2.39).
# If you pin runs-on to ubuntu-22.04, drop this back to debian:bookworm-slim.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        python3 \
        python3-boto3 \
        ca-certificates \
        time \
 && rm -rf /var/lib/apt/lists/*

COPY sage /usr/local/bin/sage
COPY wrapper.py /usr/local/bin/wrapper.py
RUN chmod +x /usr/local/bin/sage /usr/local/bin/wrapper.py

WORKDIR /scratch
ENTRYPOINT ["python3", "/usr/local/bin/wrapper.py"]
