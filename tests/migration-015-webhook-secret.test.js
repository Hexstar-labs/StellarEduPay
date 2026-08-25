'use strict';

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// Resolve the migration by its descriptive name rather than by ordinal. The
// migration was renumbered (015 → 017) during a concurrent-branch rebase, and
// its number is expected to change again; keying off the `_add_school_webhook_secret`
// slug survives any renumbering. See issue #1290.
const MIGRATIONS_DIR = path.join(__dirname, '../backend/migrations');
const migrationFile = fs
  .readdirSync(MIGRATIONS_DIR)
  .find(f => f.endsWith('.js') && f.includes('add_school_webhook_secret'));

if (!migrationFile) {
  throw new Error('Could not locate the school webhook-secret migration by name');
}

const migration = require(path.join(MIGRATIONS_DIR, migrationFile));

// In CI a real MongoDB service is available via MONGO_URI — use it directly to
// avoid MongoMemoryServer downloading a binary (blocked by blockRealHttp.js).
const USE_EXTERNAL_MONGO = !!process.env.MONGO_URI;
const TEST_DB = 'migration_015_test';

describe('Migration 015 — Add webhookSecret to schools', () => {
  let mongoServer;

  beforeAll(async () => {
    if (USE_EXTERNAL_MONGO) {
      const baseUri = process.env.MONGO_URI.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);
      await mongoose.connect(baseUri);
    } else {
      const { MongoMemoryServer } = require('mongodb-memory-server');
      mongoServer = await MongoMemoryServer.create();
      await mongoose.connect(mongoServer.getUri());
    }
  });

  afterAll(async () => {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.collection('schools').deleteMany({});
  });

  it('should generate webhookSecret for schools without one', async () => {
    const collection = mongoose.connection.collection('schools');

    // Insert schools without webhookSecret
    await collection.insertMany([
      { schoolId: 'SCH-001', name: 'School A', slug: 'school-a', stellarAddress: 'GAAAA' },
      { schoolId: 'SCH-002', name: 'School B', slug: 'school-b', stellarAddress: 'GBBBB' },
    ]);

    // Run migration
    await migration.up();

    // Verify all schools now have webhookSecret
    const schools = await collection.find({}).toArray();
    expect(schools).toHaveLength(2);
    schools.forEach(school => {
      expect(school.webhookSecret).toBeDefined();
      expect(typeof school.webhookSecret).toBe('string');
      expect(school.webhookSecret.length).toBe(64); // 32 bytes = 64 hex chars
    });
  });

  it('should not overwrite existing webhookSecret', async () => {
    const collection = mongoose.connection.collection('schools');
    const existingSecret = 'existing_secret_12345678901234567890';

    // Insert schools with and without webhookSecret
    await collection.insertMany([
      { schoolId: 'SCH-001', name: 'School A', slug: 'school-a', stellarAddress: 'GAAAA', webhookSecret: existingSecret },
      { schoolId: 'SCH-002', name: 'School B', slug: 'school-b', stellarAddress: 'GBBBB' },
    ]);

    // Run migration
    await migration.up();

    // Verify existing secret is preserved
    const schoolA = await collection.findOne({ schoolId: 'SCH-001' });
    expect(schoolA.webhookSecret).toBe(existingSecret);

    // Verify new secret was generated for school B
    const schoolB = await collection.findOne({ schoolId: 'SCH-002' });
    expect(schoolB.webhookSecret).toBeDefined();
    expect(schoolB.webhookSecret).not.toBe(existingSecret);
  });

  it('should be idempotent — running twice does not change secrets', async () => {
    const collection = mongoose.connection.collection('schools');

    // Insert school without webhookSecret
    await collection.insertOne({
      schoolId: 'SCH-001',
      name: 'School A',
      slug: 'school-a',
      stellarAddress: 'GAAAA',
    });

    // Run migration first time
    await migration.up();
    const firstRun = await collection.findOne({ schoolId: 'SCH-001' });
    const firstSecret = firstRun.webhookSecret;

    // Run migration second time
    await migration.up();
    const secondRun = await collection.findOne({ schoolId: 'SCH-001' });
    const secondSecret = secondRun.webhookSecret;

    // Secrets should be identical
    expect(firstSecret).toBe(secondSecret);
  });

  it('should rollback by removing webhookSecret', async () => {
    const collection = mongoose.connection.collection('schools');

    // Insert school with webhookSecret
    await collection.insertOne({
      schoolId: 'SCH-001',
      name: 'School A',
      slug: 'school-a',
      stellarAddress: 'GAAAA',
      webhookSecret: 'test_secret',
    });

    // Run rollback
    await migration.down();

    // Verify webhookSecret was removed
    const school = await collection.findOne({ schoolId: 'SCH-001' });
    expect(school.webhookSecret).toBeUndefined();
  });
});
