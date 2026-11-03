#!/bin/sh
set -eu
cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cloudflare-containers-ca.crt
update-ca-certificates
cat /proc/sys/kernel/random/uuid > /tmp/workspace-incarnation
touch /tmp/workspace-ready
exec sleep infinity
