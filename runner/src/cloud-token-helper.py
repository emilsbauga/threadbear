# Make one on a cloud token card (docs/protocol.md, Virtual runners, "Cloud
# tokens on the Mac"): `claude setup-token` for one Claude login, with no
# window. The runner runs this with argv[1] the claude binary and the login's
# CLAUDE_CONFIG_DIR in the environment (none for claude-main). setup-token
# prints nothing without a terminal, so it runs in a pseudo-terminal, wide so
# the token comes out on one line. It opens claude.ai in the browser; once
# Mike approves, the CLI gets its code on a localhost callback and prints the
# token. Nothing is typed into it.
#
# The only thing this prints is one line of JSON on stdout, {"token": ...},
# and only when a token came back (exit 1 otherwise, printing nothing). What
# the CLI printed is never echoed, written or logged: the runner hands the
# token to boxes:setCloudToken and nowhere else.
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios

cli = sys.argv[1]
captured = bytearray()
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cli, [cli, "setup-token"])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 1000, 0, 0))


def stop(*_):
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
    sys.exit(1)


signal.signal(signal.SIGTERM, stop)

while True:
    ready, _, _ = select.select([fd], [], [], 1.0)
    if fd not in ready:
        continue
    try:
        data = os.read(fd, 65536)
    except OSError:
        break
    if not data:
        break
    captured.extend(data)
    # Bounded: setup-token prints a page at most.
    if len(captured) > 1_000_000:
        del captured[:500_000]
try:
    os.waitpid(pid, 0)
except OSError:
    pass

text = captured.decode("utf-8", "replace")
print_token = None
# CSI and OSC escapes out (cursor moves become nothing, so a line stays a line).
text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]", "", text)
lines = [line.strip().strip("\u2502|").strip() for line in re.split(r"\r\n|\r|\n", text)]
TOKEN_CHARS = re.compile(r"[A-Za-z0-9_-]+")
for i, line in enumerate(lines):
    at = line.find("sk-ant-oat01-")
    if at < 0:
        continue
    run = TOKEN_CHARS.match(line, at).group(0)
    # Wrapped: the token ran to the end of its line short of a whole one
    # (they're 108 characters), and the lines after it are nothing but more
    # of it (a line with a space, or empty, isn't).
    if at + len(run) == len(line) and len(run) < 100:
        for more in lines[i + 1:]:
            if not more or not TOKEN_CHARS.fullmatch(more) or len(run) > 300:
                break
            run += more
    if re.fullmatch(r"sk-ant-oat01-[A-Za-z0-9_-]{40,300}", run):
        print_token = run
if not print_token:
    sys.exit(1)
sys.stdout.write(json.dumps({"token": print_token}) + "\n")
