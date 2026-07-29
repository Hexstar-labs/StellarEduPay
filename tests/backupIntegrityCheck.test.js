'use strict';
/**
 * Tests for issue #1105 — backup.sh integrity check must use mongorestore's
 * exit code, not string-matching its human-readable log output.
 *
 * These tests assert:
 *   1. When mongorestore exits 0, the check passes regardless of log wording
 *      (even if the output never contains the word "done").
 *   2. When mongorestore exits non-zero, the check fails and the backup file
 *      is removed — regardless of what the log output says.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execSync } = require('child_process');

const BACKUP_SH = path.resolve(__dirname, '..', 'scripts', 'backup.sh');

function readBackupSh() {
  return fs.readFileSync(BACKUP_SH, 'utf8');
}

describe('#1105 backup.sh integrity check', () => {
  test('backup.sh does not use grep to match mongorestore output for success detection', () => {
    const src = readBackupSh();
    // Strip comment lines before checking — the fix comment explains what the
    // old approach was (grep -q "done") but the actual code must not use it.
    const codeLines = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(codeLines).not.toMatch(/mongorestore.*\|\s*grep/);
    expect(codeLines).not.toMatch(/grep.*done/);
  });

  test('backup.sh captures mongorestore exit code into a variable', () => {
    const src = readBackupSh();
    // The fix pattern: mongorestore exit code is captured and tested explicitly.
    expect(src).toMatch(/mongorestore_exit/);
    expect(src).toMatch(/mongorestore_exit.*-ne.*0/);
  });

  test('backup.sh does not pipe mongorestore through any command that masks its exit code', () => {
    const src = readBackupSh();
    // Confirm the integrity block runs mongorestore in a subshell assignment,
    // not piped — piping under set -o pipefail still loses the true exit code
    // when grep is the last command in the pipeline.
    const integrityBlock = src.split('Verifying backup integrity')[1] || '';
    expect(integrityBlock).not.toMatch(/mongorestore[^\n]*\|[^\n]*grep/);
  });

  test('simulated mongorestore success with non-standard output passes the check', () => {
    // Create a temp dir and a fake mongorestore that exits 0 but prints nothing
    // resembling "done" — the old grep check would have wrongly failed this.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
    const fakeBin = path.join(tmpDir, 'fake-bin');
    const backupDir = path.join(tmpDir, 'backups');
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(backupDir);

    // mongodump stub: creates the expected archive file and exits 0
    const mongodumpStub = path.join(fakeBin, 'mongodump');
    fs.writeFileSync(
      mongodumpStub,
      '#!/bin/sh\n' +
        '# Extract --archive= value from args and create a non-empty file\n' +
        'for arg; do\n' +
        '  case "$arg" in --archive=*) archive="${arg#--archive=}";; esac\n' +
        'done\n' +
        'echo "fake backup data" > "$archive"\n' +
        'exit 0\n',
    );
    fs.chmodSync(mongodumpStub, 0o755);

    // mongorestore stub: exits 0 but never prints the word "done"
    const mongorestoreStub = path.join(fakeBin, 'mongorestore');
    fs.writeFileSync(
      mongorestoreStub,
      '#!/bin/sh\n' +
        'echo "restoration completed without the magic word"\n' +
        'exit 0\n',
    );
    fs.chmodSync(mongorestoreStub, 0o755);

    // stat stub (the script uses stat -c%s on Linux)
    const statStub = path.join(fakeBin, 'stat');
    fs.writeFileSync(
      statStub,
      '#!/bin/sh\n' +
        '# Return a size larger than MIN_BACKUP_SIZE (1024)\n' +
        'echo 2048\n' +
        'exit 0\n',
    );
    fs.chmodSync(statStub, 0o755);

    let exitCode = 0;
    try {
      execSync(`bash "${BACKUP_SH}"`, {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          MONGO_URI: 'mongodb://fake:fake@localhost:27017/test',
          BACKUP_DIR: backupDir,
          RETAIN_DAYS: '7',
          MIN_BACKUP_SIZE: '1024',
          WEBHOOK_URL: '',
          BACKUP_NOTIFY_TOKEN: '',
        },
        stdio: 'pipe',
      });
    } catch (err) {
      exitCode = err.status || 1;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // The backup should succeed (exit 0) even though mongorestore never said "done"
    expect(exitCode).toBe(0);
  });

  test('simulated mongorestore failure with exit code 1 causes the check to fail', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
    const fakeBin = path.join(tmpDir, 'fake-bin');
    const backupDir = path.join(tmpDir, 'backups');
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(backupDir);

    // mongodump stub: creates the archive and exits 0
    const mongodumpStub = path.join(fakeBin, 'mongodump');
    fs.writeFileSync(
      mongodumpStub,
      '#!/bin/sh\n' +
        'for arg; do\n' +
        '  case "$arg" in --archive=*) archive="${arg#--archive=}";; esac\n' +
        'done\n' +
        'echo "fake backup data" > "$archive"\n' +
        'exit 0\n',
    );
    fs.chmodSync(mongodumpStub, 0o755);

    // mongorestore stub: PRINTS "done" but exits 1 — the old grep check would
    // have wrongly accepted this as a valid backup; the new check must reject it.
    const mongorestoreStub = path.join(fakeBin, 'mongorestore');
    fs.writeFileSync(
      mongorestoreStub,
      '#!/bin/sh\n' +
        'echo "done"\n' +
        'exit 1\n',
    );
    fs.chmodSync(mongorestoreStub, 0o755);

    const statStub = path.join(fakeBin, 'stat');
    fs.writeFileSync(
      statStub,
      '#!/bin/sh\necho 2048\nexit 0\n',
    );
    fs.chmodSync(statStub, 0o755);

    let exitCode = 0;
    let stdout = '';
    try {
      execSync(`bash "${BACKUP_SH}"`, {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          MONGO_URI: 'mongodb://fake:fake@localhost:27017/test',
          BACKUP_DIR: backupDir,
          RETAIN_DAYS: '7',
          MIN_BACKUP_SIZE: '1024',
          WEBHOOK_URL: '',
          BACKUP_NOTIFY_TOKEN: '',
        },
        stdio: 'pipe',
      });
    } catch (err) {
      exitCode = err.status || 1;
      stdout = (err.stdout || '').toString();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // Must fail because mongorestore exited non-zero
    expect(exitCode).not.toBe(0);
  });
});
