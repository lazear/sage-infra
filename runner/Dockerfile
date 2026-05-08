# sage-infra runner: thin debian image carrying a fresh `sage` binary plus the
# wrapper that executes one (commit x dataset) benchmark on AWS Batch.
#
# The build context is expected to contain:
#   ./sage         pre-built x86_64-linux-gnu release binary (built by GH Actions)
#   ./wrapper.py   from runner/wrapper.py
FROM debian:bookworm-slim

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
