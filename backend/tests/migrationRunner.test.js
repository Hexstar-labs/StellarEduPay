'use strict';

const path = require('path');
const fs = require('fs');

const mockFindOneAndUpdate = jest.fn();
const mockFindOne = jest.fn();
const mockDeleteOne = jest.fn();

jest.mock('../src/models/migrationModel', () => ({
  findOneAndUpdate: (...args) => mockFindOneAndUpdate(...args),
  findOne: (...args) => mockFindOne(...args),
  deleteOne: (...args) => mockDeleteOne(...args),
}));

jest.mock('../src/utils/logger', () => {
  const noop = () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  });
  return { child: noop, ...noop() };
});

jest.mock('../src/config/database', () => ({
  getConnection: () => ({ db: {} }),
}));

let mockFiles = [];
let mockExists = true;

jest.spyOn(fs, 'existsSync').mockImplementation(() => mockExists);
jest.spyOn(fs, 'readdirSync').mockImplementation(() => mockFiles);

const { runMigrations, rollback } = require('../src/services/migrationRunner');

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

function makeRequire(files) {
  const map = Object.fromEntries(
    files.map((f) => [path.join(MIGRATIONS_DIR, f.name), f.module]),
  );
  return (id) => {
    if (map[id]) return map[id];
    throw new Error(`Unexpected require: ${id}`);
  };
}

const LOCK_ACQUIRED = null;
const LOCK_HELD = { version: 'already-exists' };

beforeEach(() => {
  jest.clearAllMocks();
  mockExists = true;
  mockFiles = [];
  mockFindOneAndUpdate.mockResolvedValue(LOCK_ACQUIRED);
  mockDeleteOne.mockResolvedValue({});
});

describe('runMigrations — missing migrations directory', () => {
  it('throws when the migrations directory does not exist', async () => {
    mockExists = false;
    await expect(runMigrations()).rejects.toThrow(/Migrations directory not found/);
  });

  it('does not throw for a present-but-empty migrations directory', async () => {
    mockExists = true;
    mockFiles = [];
    await expect(runMigrations(makeRequire([]))).resolves.toBeUndefined();
  });
});

describe('runMigrations — distributed locking', () => {
  test('acquires lock via findOneAndUpdate upsert before running migration', async () => {
    const up = jest.fn().mockResolvedValue();
    const files = [{ name: '001_test.js', module: { version: '001_test', up } }];
    mockFiles = files.map((f) => f.name);

    await runMigrations(makeRequire(files));

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { version: '001_test' },
      {
        $setOnInsert: expect.objectContaining({
          version: '001_test',
          lockedAt: expect.any(Date),
        }),
      },
      { upsert: true, new: false },
    );
    expect(up).toHaveBeenCalledTimes(1);
  });

  test('runs migration when lock is acquired', async () => {
    mockFindOneAndUpdate.mockResolvedValue(LOCK_ACQUIRED);
    const up = jest.fn().mockResolvedValue();
    const files = [{ name: '001_test.js', module: { version: '001_test', up } }];
    mockFiles = files.map((f) => f.name);
    await runMigrations(makeRequire(files));
    expect(up).toHaveBeenCalledTimes(1);
  });

  test('skips migration when lock is already held', async () => {
    mockFindOneAndUpdate.mockResolvedValue(LOCK_HELD);
    const up = jest.fn();
    const files = [{ name: '001_test.js', module: { version: '001_test', up } }];
    mockFiles = files.map((f) => f.name);
    await runMigrations(makeRequire(files));
    expect(up).not.toHaveBeenCalled();
  });

  test('concurrent simulation: only the lock winner runs the migration', async () => {
    const up = jest.fn().mockResolvedValue();
    const files = [{ name: '001_test.js', module: { version: '001_test', up } }];
    mockFiles = files.map((f) => f.name);
    mockFindOneAndUpdate
      .mockResolvedValueOnce(LOCK_ACQUIRED)
      .mockResolvedValueOnce(LOCK_HELD);

    await Promise.all([
      runMigrations(makeRequire(files)),
      runMigrations(makeRequire(files)),
    ]);
    expect(up).toHaveBeenCalledTimes(1);
  });

  test('runs migrations in sorted filename order', async () => {
    const order = [];
    const files = [
      { name: '002_b.js', module: { version: '002_b', up: async () => order.push('002') } },
      { name: '001_a.js', module: { version: '001_a', up: async () => order.push('001') } },
    ];
    mockFiles = files.map((f) => f.name);
    await runMigrations(makeRequire(files));
    expect(order).toEqual(['001', '002']);
  });

  test('skips already-locked migrations and runs pending ones', async () => {
    mockFindOneAndUpdate
      .mockResolvedValueOnce(LOCK_HELD)
      .mockResolvedValueOnce(LOCK_ACQUIRED);
    const up1 = jest.fn();
    const up2 = jest.fn().mockResolvedValue();
    const files = [
      { name: '001_a.js', module: { version: '001_a', up: up1 } },
      { name: '002_b.js', module: { version: '002_b', up: up2 } },
    ];
    mockFiles = files.map((f) => f.name);
    await runMigrations(makeRequire(files));
    expect(up1).not.toHaveBeenCalled();
    expect(up2).toHaveBeenCalledTimes(1);
  });

  test('does not call findOneAndUpdate when no migration files exist', async () => {
    mockFiles = [];
    await runMigrations(makeRequire([]));
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('runMigrations — failed up cleans up lock', () => {
  test('deletes the lock document when up() throws', async () => {
    const up = jest.fn().mockRejectedValue(new Error('up failed'));
    const files = [{ name: '001_test.js', module: { version: '001_test', up } }];
    mockFiles = files.map((f) => f.name);
    await expect(runMigrations(makeRequire(files))).rejects.toThrow('up failed');
    expect(mockDeleteOne).toHaveBeenCalledWith({ version: '001_test' });
  });
});

describe('rollback', () => {
  test('calls down() of the last applied migration and deletes its record', async () => {
    const down = jest.fn().mockResolvedValue();
    const files = [
      { name: '001_test.js', module: { version: '001_test', up: jest.fn(), down } },
    ];
    mockFiles = files.map((f) => f.name);
    mockFindOne.mockReturnValue({
      sort: jest.fn().mockResolvedValue({
        version: '001_test',
        appliedAt: new Date(),
      }),
    });
    await rollback(makeRequire(files));
    expect(down).toHaveBeenCalledTimes(1);
    expect(mockDeleteOne).toHaveBeenCalledWith({ version: '001_test' });
  });

  test('does nothing when no migrations have been applied', async () => {
    mockFindOne.mockReturnValue({ sort: jest.fn().mockResolvedValue(null) });
    await rollback(makeRequire([]));
    expect(mockDeleteOne).not.toHaveBeenCalled();
  });

  test('throws when the migration file has no down() function', async () => {
    const files = [{ name: '001_test.js', module: { version: '001_test', up: jest.fn() } }];
    mockFiles = files.map((f) => f.name);
    mockFindOne.mockReturnValue({
      sort: jest.fn().mockResolvedValue({
        version: '001_test',
        appliedAt: new Date(),
      }),
    });
    await expect(rollback(makeRequire(files))).rejects.toThrow(/down/);
  });

  test('throws when the migration file for the last version cannot be found', async () => {
    mockFiles = [];
    mockFindOne.mockReturnValue({
      sort: jest.fn().mockResolvedValue({
        version: '001_missing',
        appliedAt: new Date(),
      }),
    });
    await expect(rollback(makeRequire([]))).rejects.toThrow(/not found/);
  });
});
