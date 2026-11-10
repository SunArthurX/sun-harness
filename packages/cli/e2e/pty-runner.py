"""Relay an isolated CLI subprocess through a real Unix pseudo-terminal."""

import errno
import os
import pty
import select
import sys

pid, master = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])

inputs = [master, 0]
try:
    while True:
        readable, _, _ = select.select(inputs, [], [])
        if master in readable:
            try:
                output = os.read(master, 4096)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
            if not output:
                break
            os.write(1, output)
        if 0 in readable:
            data = os.read(0, 4096)
            if data:
                os.write(master, data)
            else:
                inputs.remove(0)
finally:
    os.close(master)
    _, status = os.waitpid(pid, 0)

sys.exit(os.waitstatus_to_exitcode(status))
