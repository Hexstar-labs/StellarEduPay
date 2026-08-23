'use strict';

/**
 * Tests for schoolSettingsService.
 *
 * Covers the three-layer resolution (school override → SystemConfig → DEFAULTS),
 * validation of unknown keys, and the clearSchoolSetting path.
 * Models are fully mocked — no real DB connection is needed.
 */

// ── School model mock ───────────────────────────────────────────────────────
// The service chains .lean() on every findOne / findOneAndUpdate call.
// Jest allows mock-factory references to variables prefixed with "mock".
const mockSchoolFindOne          = jest.fn();
const mockSchoolFindOneAndUpdate = jest.fn();

// Prefixed with "mock" so jest.mock hoisting can reference it safely.
const mockLean = (val) => ({ lean: () => Promise.resolve(val) });

jest.mock('../src/models/schoolModel', () => ({
  findOne:          (...args) => mockLean(mockSchoolFindOne(...args)),
  findOneAndUpdate: (...args) => mockLean(mockSchoolFindOneAndUpdate(...args)),
}));

// ── SystemConfig model mock ─────────────────────────────────────────────────
const mockSystemConfigGet = jest.fn();

jest.mock('../src/models/systemConfigModel', () => ({
  get: (...args) => mockSystemConfigGet(...args),
}));

// ── load after mocks are in place ──────────────────────────────────────────
const {
  getSchoolSetting,
  setSchoolSetting,
  getSchoolSettings,
  clearSchoolSetting,
  SETTING_KEYS,
} = require('../src/services/schoolSettingsService');

const SCHOOL_ID = 'school-abc';

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no school document, no SystemConfig value.
  // The mock functions return the value directly; mockLean wraps it for lean().
  mockSchoolFindOne.mockReturnValue(null);
  mockSystemConfigGet.mockResolvedValue(null);
  mockSchoolFindOneAndUpdate.mockReturnValue({ settings: {} });
});

// ── SETTING_KEYS export ─────────────────────────────────────────────────────

describe('SETTING_KEYS', () => {
  it('is a Set containing the known keys', () => {
    expect(SETTING_KEYS).toBeInstanceOf(Set);
    expect(SETTING_KEYS.has('reminderEnabled')).toBe(true);
    expect(SETTING_KEYS.has('maxSyncBatchSize')).toBe(true);
    expect(SETTING_KEYS.has('maintenanceMode')).toBe(true);
  });
});

// ── getSchoolSetting ────────────────────────────────────────────────────────

describe('getSchoolSetting', () => {
  it('returns undefined for an unknown key', async () => {
    const result = await getSchoolSetting(SCHOOL_ID, 'unknownKey');
    expect(result).toBeUndefined();
    expect(mockSchoolFindOne).not.toHaveBeenCalled();
  });

  it('returns the school-level override when set', async () => {
    mockSchoolFindOne.mockReturnValue({ settings: { reminderEnabled: false } });
    const result = await getSchoolSetting(SCHOOL_ID, 'reminderEnabled');
    expect(result).toBe(false);
    expect(mockSystemConfigGet).not.toHaveBeenCalled();
  });

  it('falls through to SystemConfig when school has no override', async () => {
    mockSchoolFindOne.mockReturnValue({ settings: {} });
    mockSystemConfigGet.mockResolvedValue(30);
    const result = await getSchoolSetting(SCHOOL_ID, 'maxSyncBatchSize');
    expect(result).toBe(30);
  });

  it('falls through to the DEFAULT when neither school nor SystemConfig has a value', async () => {
    const result = await getSchoolSetting(SCHOOL_ID, 'maxSyncBatchSize');
    expect(result).toBe(20); // DEFAULTS.maxSyncBatchSize
  });

  it('falls through to the DEFAULT for reminderEnabled', async () => {
    const result = await getSchoolSetting(SCHOOL_ID, 'reminderEnabled');
    expect(result).toBe(true);
  });

  it('falls through to the DEFAULT for maintenanceMode', async () => {
    const result = await getSchoolSetting(SCHOOL_ID, 'maintenanceMode');
    expect(result).toBe(false);
  });

  it('school override wins over SystemConfig', async () => {
    mockSchoolFindOne.mockReturnValue({ settings: { maxSyncBatchSize: 99 } });
    mockSystemConfigGet.mockResolvedValue(5);
    const result = await getSchoolSetting(SCHOOL_ID, 'maxSyncBatchSize');
    expect(result).toBe(99);
  });

  it('falls through to DEFAULT for betaFeatures (not in SystemConfig map)', async () => {
    mockSchoolFindOne.mockReturnValue({ settings: {} });
    const result = await getSchoolSetting(SCHOOL_ID, 'betaFeatures');
    expect(result).toEqual([]);
    expect(mockSystemConfigGet).not.toHaveBeenCalled();
  });
});

// ── setSchoolSetting ────────────────────────────────────────────────────────

describe('setSchoolSetting', () => {
  it('calls findOneAndUpdate with the correct $set path', async () => {
    const updated = { settings: { reminderEnabled: true } };
    mockSchoolFindOneAndUpdate.mockReturnValue(updated);

    const result = await setSchoolSetting(SCHOOL_ID, 'reminderEnabled', true);
    expect(mockSchoolFindOneAndUpdate).toHaveBeenCalledWith(
      { schoolId: SCHOOL_ID },
      { $set: { 'settings.reminderEnabled': true } },
      { new: true },
    );
    expect(result).toEqual(updated);
  });

  it('throws for an unknown key and does not call the model', async () => {
    await expect(setSchoolSetting(SCHOOL_ID, 'badKey', 'value'))
      .rejects.toThrow('Unknown setting key: badKey');
    expect(mockSchoolFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('can set a falsy value (false)', async () => {
    await setSchoolSetting(SCHOOL_ID, 'maintenanceMode', false);
    expect(mockSchoolFindOneAndUpdate).toHaveBeenCalledWith(
      { schoolId: SCHOOL_ID },
      { $set: { 'settings.maintenanceMode': false } },
      { new: true },
    );
  });

  it('can set a numeric value', async () => {
    await setSchoolSetting(SCHOOL_ID, 'maxSyncBatchSize', 50);
    expect(mockSchoolFindOneAndUpdate).toHaveBeenCalledWith(
      { schoolId: SCHOOL_ID },
      { $set: { 'settings.maxSyncBatchSize': 50 } },
      { new: true },
    );
  });
});

// ── getSchoolSettings ───────────────────────────────────────────────────────

describe('getSchoolSettings', () => {
  it('returns merged defaults when no school and no SystemConfig', async () => {
    const result = await getSchoolSettings(SCHOOL_ID);
    expect(result.maxSyncBatchSize).toBe(20);
    expect(result.reminderEnabled).toBe(true);
    expect(result.maintenanceMode).toBe(false);
    expect(result.betaFeatures).toEqual([]);
  });

  it('school overrides take highest priority', async () => {
    mockSchoolFindOne.mockReturnValue({
      settings: { maxSyncBatchSize: 100, maintenanceMode: true },
    });
    const result = await getSchoolSettings(SCHOOL_ID);
    expect(result.maxSyncBatchSize).toBe(100);
    expect(result.maintenanceMode).toBe(true);
  });

  it('SystemConfig values override defaults but not school overrides', async () => {
    mockSchoolFindOne.mockReturnValue({ settings: {} });
    mockSystemConfigGet.mockImplementation(async (key) => {
      if (key === 'reminderEnabled') return false;
      return null;
    });
    const result = await getSchoolSettings(SCHOOL_ID);
    expect(result.reminderEnabled).toBe(false);
    expect(result.maxSyncBatchSize).toBe(20);
  });

  it('school override wins over SystemConfig value', async () => {
    mockSchoolFindOne.mockReturnValue({ settings: { reminderEnabled: true } });
    mockSystemConfigGet.mockImplementation(async (key) => {
      if (key === 'reminderEnabled') return false;
      return null;
    });
    const result = await getSchoolSettings(SCHOOL_ID);
    expect(result.reminderEnabled).toBe(true);
  });
});

// ── clearSchoolSetting ──────────────────────────────────────────────────────

describe('clearSchoolSetting', () => {
  it('calls findOneAndUpdate with $unset', async () => {
    mockSchoolFindOneAndUpdate.mockReturnValue({ settings: {} });
    await clearSchoolSetting(SCHOOL_ID, 'reminderEnabled');
    expect(mockSchoolFindOneAndUpdate).toHaveBeenCalledWith(
      { schoolId: SCHOOL_ID },
      { $unset: { 'settings.reminderEnabled': '' } },
      { new: true },
    );
  });

  it('throws for an unknown key', async () => {
    await expect(clearSchoolSetting(SCHOOL_ID, 'notAKey'))
      .rejects.toThrow('Unknown setting key: notAKey');
    expect(mockSchoolFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
