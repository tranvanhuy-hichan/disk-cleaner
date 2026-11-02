#!/bin/bash
# Khởi động Disk Cleaner
cd "/home/tranvanhuy0642/Projects/My projects/disk-cleaner"
exec env -u ELECTRON_RUN_AS_NODE "/home/tranvanhuy0642/Projects/My projects/disk-cleaner/node_modules/electron/dist/electron" "/home/tranvanhuy0642/Projects/My projects/disk-cleaner" --no-sandbox "$@"
