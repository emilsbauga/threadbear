import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const helper = path.resolve(import.meta.dirname, '../../../scripts/parity/host.sh');
test('parity skips Linux, unreachable hosts and Macs without Desk Runner', () => {
  const output = execFileSync('bash', ['-c', `
    set -u
    source "$1"
    ssh() {
      cat >/dev/null
      case "$*" in
        *cloud*) return 1;;
        *asleep*) return 255;;
        *no-desk*) return 1;;
        *tinker-desk*) return 0;;
      esac
      return 1
    }
    printf '%s\\n' cloud asleep no-desk tinker-desk | parity_host
  `, 'test', helper], { encoding: 'utf8' });
  assert.equal(output.trim(), 'tinker-desk');
});
test('parity fails when no candidate can take pictures', () => {
  assert.throws(() => execFileSync('bash', ['-c', `
    set -u
    source "$1"
    ssh() { return 1; }
    printf '%s\\n' cloud | parity_host
  `, 'test', helper], { stdio: 'pipe' }));
});

test('parity accepts a final candidate without a newline', () => {
  const output = execFileSync('bash', ['-c', `
    set -u
    source "$1"
    ssh() { return 0; }
    printf tinker-desk | parity_host
  `, 'test', helper], { encoding: 'utf8' });
  assert.equal(output.trim(), 'tinker-desk');
});
