# Year-long token… for one Claude login (docs/protocol.md, Accounts,
# "Year-long tokens"). The app runs this in Terminal, the way Sign in… runs
# `claude auth login`: argv is the claude binary and the login's token file,
# threadbear-token.json in its own folder. It runs `claude setup-token` in a
# pseudo-terminal, so Mike sees and answers it as usual, and picks the
# token out of what it prints. The file (0600) holds the token and when it
# was made; the runner passes the token to that login's CLI as
# CLAUDE_CODE_OAUTH_TOKEN and nowhere else, and warns before the year is up.
#
# Not settings.json's `env`: Mike's logins share one settings.json through
# symlinks, so a token there would sign every login in as one. Not the
# Keychain: those entries are Claude Code's own, never read or rewritten.
import datetime
import fcntl
import json
import os
import pty
import re
import select
import struct
import sys
import termios
import tty

cli, target = sys.argv[1], sys.argv[2]

captured = bytearray()
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cli, [cli, "setup-token"])

# Wide, so the token comes out on one line rather than wrapped.
rows = os.get_terminal_size().lines if os.isatty(0) else 40
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, 1000, 0, 0))
saved = termios.tcgetattr(0) if os.isatty(0) else None
if saved:
    tty.setraw(0)
try:
    while True:
        ready, _, _ = select.select([fd, 0] if saved else [fd], [], [])
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            captured.extend(data)
            os.write(1, data)
        if 0 in ready:
            typed = os.read(0, 1024)
            if typed:
                os.write(fd, typed)
finally:
    if saved:
        termios.tcsetattr(0, termios.TCSADRAIN, saved)
_, status = os.waitpid(pid, 0)

text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)", "", captured.decode("utf-8", "replace"))
found = re.findall(r"sk-ant-oat01-[A-Za-z0-9_-]{40,}", text)
# Clear the screen and its scrollback: setup-token printed the token there.
os.write(1, b"\x1b[2J\x1b[3J\x1b[H")
if not found:
    print("No token came back from claude setup-token, so nothing was changed.")
    sys.exit(1)

made = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
tmp = f"{target}.{os.getpid()}"
with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
    json.dump({"token": found[-1], "madeAt": made}, f)
    f.write("\n")
os.replace(tmp, target)
print("Done. This login now uses a year-long token. Threadbear will warn a few days before the year is up. You can close this window.")
