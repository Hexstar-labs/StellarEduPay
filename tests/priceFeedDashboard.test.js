'use strict';
/**
 * Tests for issue #1101 — a Grafana dashboard must exist that visualises the
 * metrics referenced by monitoring/alerts/price_feed.yml, and every price feed
 * alert must carry a dashboard_url annotation linking to it.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const monitoringDir = path.resolve(__dirname, '..', 'monitoring');
const dashboardsDir = path.join(monitoringDir, 'grafana', 'dashboards');
const alertsDir = path.join(monitoringDir, 'alerts');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readYaml(filePath) {
  return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

describe('#1101 price feed Grafana dashboard', () => {
  const dashboardFile = path.join(dashboardsDir, 'price_feed.json');

  test('price_feed.json dashboard file exists', () => {
    expect(fs.existsSync(dashboardFile)).toBe(true);
  });

  test('dashboard has a uid', () => {
    const dash = readJson(dashboardFile);
    expect(typeof dash.uid).toBe('string');
    expect(dash.uid.length).toBeGreaterThan(0);
  });

  test('dashboard has at least one panel', () => {
    const dash = readJson(dashboardFile);
    expect(Array.isArray(dash.panels)).toBe(true);
    expect(dash.panels.length).toBeGreaterThan(0);
  });

  test('dashboard references price_feed_staleness_seconds metric', () => {
    const raw = fs.readFileSync(dashboardFile, 'utf8');
    expect(raw).toContain('price_feed_staleness_seconds');
  });

  test('dashboard references price_feed_stale metric', () => {
    const raw = fs.readFileSync(dashboardFile, 'utf8');
    expect(raw).toContain('price_feed_stale');
  });

  test('dashboard references price_feed_last_success_timestamp metric', () => {
    const raw = fs.readFileSync(dashboardFile, 'utf8');
    expect(raw).toContain('price_feed_last_success_timestamp');
  });
});

describe('#1101 price feed alert annotations include dashboard_url', () => {
  const priceFeedAlerts = readYaml(path.join(alertsDir, 'price_feed.yml'));
  const allRules = priceFeedAlerts.groups.flatMap((g) => g.rules);

  test('at least one price feed alert rule exists', () => {
    expect(allRules.length).toBeGreaterThan(0);
  });

  test.each(allRules.map((r) => [r.alert, r]))(
    '%s alert has a dashboard_url annotation',
    (_, rule) => {
      expect(typeof rule.annotations?.dashboard_url).toBe('string');
      expect(rule.annotations.dashboard_url.length).toBeGreaterThan(0);
    },
  );

  test.each(allRules.map((r) => [r.alert, r]))(
    '%s dashboard_url references the price feed dashboard uid',
    (_, rule) => {
      const dash = readJson(path.join(dashboardsDir, 'price_feed.json'));
      expect(rule.annotations.dashboard_url).toContain(dash.uid);
    },
  );
});

describe('#1101 Grafana dashboard provisioning', () => {
  const provisioningDashboardsDir = path.join(
    monitoringDir,
    'grafana',
    'provisioning',
    'dashboards',
  );

  test('dashboards provisioning directory exists', () => {
    expect(fs.existsSync(provisioningDashboardsDir)).toBe(true);
  });

  test('dashboards provisioning config YAML file exists', () => {
    const files = fs.readdirSync(provisioningDashboardsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    expect(files.length).toBeGreaterThan(0);
  });

  test('dashboards provisioning config is valid YAML with a file provider', () => {
    const files = fs.readdirSync(provisioningDashboardsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    const config = readYaml(path.join(provisioningDashboardsDir, files[0]));
    expect(Array.isArray(config.providers)).toBe(true);
    const fileProvider = config.providers.find((p) => p.type === 'file');
    expect(fileProvider).toBeDefined();
  });
});
