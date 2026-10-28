#!/bin/sh
# Fake traceroute used by the runner tests. macOS prints the header on stderr.
echo "traceroute to example.com (203.0.113.7), 8 hops max, 40 byte packets" >&2
echo " 1  192.168.1.1  1.2 ms"
echo " 2  *"
echo " 3  203.0.113.7  9.8 ms"
echo " 4  62.119.252.53 (62.119.252.53)  16.879 ms"
echo "    62.119.252.49 (62.119.252.49)  16.349 ms  16.995 ms"
