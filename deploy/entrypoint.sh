#!/bin/sh
set -e

case "$1" in
  hub)
    exec node /app/apps/hub/dist/index.js
    ;;
  cloud-node)
    exec /usr/local/bin/botd start
    ;;
  start|join|wake)
    exec /usr/local/bin/botd "$@"
    ;;
  botd)
    shift
    exec /usr/local/bin/botd "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
