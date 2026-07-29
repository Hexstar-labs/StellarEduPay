/**
 * @jest-environment jsdom
 *
 * Tests for issue #1214 — dashboard.jsx must issue exactly one /students
 * request on initial mount, not two.
 *
 * Root cause: two separate useEffect hooks both called fetchStudents on mount:
 *   1. The filter effect (deps: debouncedSearch, statusFilter, classFilter)
 *      runs on mount with initial values and calls fetchStudents.
 *   2. The page effect (deps: [page]) also ran on mount (page starts at 1)
 *      and called fetchStudents again.
 *
 * Fix: the page effect skips its first execution (via an isInitialPageRender
 * ref) because the filter effect already fetched page 1 on mount.  Subsequent
 * page changes are unaffected.
 */

'use strict';

import '@testing-library/jest-dom';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import Dashboard from '../frontend/src/pages/dashboard';
import * as api from '../frontend/src/services/api';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../frontend/src/services/api');

jest.mock('../frontend/src/components/SyncButton', () => {
  return function MockSyncButton() { return null; };
});
jest.mock('../frontend/src/components/ErrorBoundary', () => {
  return function MockErrorBoundary({ children }) { return <>{children}</>; };
});
jest.mock('../frontend/src/components/StudentForm', () => {
  return function MockStudentForm() { return null; };
});
jest.mock('../frontend/src/components/SseDegradedBanner', () => {
  return function MockSseDegradedBanner() { return null; };
});
jest.mock('../frontend/src/components/PageHero', () => {
  const PageHero = function MockPageHero({ children }) { return <div>{children}</div>; };
  const StatCard = function MockStatCard({ label, value }) {
    return <div data-testid="stat-card">{label}: {value}</div>;
  };
  PageHero.StatCard = StatCard; // match the named export pattern
  return PageHero;
});
jest.mock('../frontend/src/components/RequireAdmin', () => {
  return function MockRequireAdmin({ children }) { return <>{children}</>; };
});
jest.mock('../frontend/src/components/Icons', () => ({
  IconUsers: () => null,
  IconCheck: () => null,
  IconAlertTriangle: () => null,
  IconDollarSign: () => null,
  IconSearch: () => null,
  IconChevronLeft: () => null,
  IconChevronRight: () => null,
}));
jest.mock('../frontend/src/hooks/usePaymentEvents', () => ({
  usePaymentEvents: () => ({ degraded: false, connectionStatus: 'connected' }),
}));

// ── Shared API defaults ───────────────────────────────────────────────────────

function setupApiDefaults() {
  api.getSyncStatus.mockResolvedValue({ data: { lastSyncAt: null } });
  api.getPaymentSummary.mockResolvedValue({
    data: { totalStudents: 5, paidCount: 3, unpaidCount: 2, totalXlmCollected: 100 },
  });
  api.getStudents.mockResolvedValue({
    data: { students: [], pages: 1, total: 0 },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Dashboard duplicate /students request on mount (#1214)', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    setupApiDefaults();
  });

  test('getStudents is called exactly once on initial mount', async () => {
    render(<Dashboard />);

    // Wait until the loading skeleton is gone or at least until effects settle.
    await waitFor(() => {
      expect(api.getStudents).toHaveBeenCalled();
    });

    // Allow any pending microtasks / timers to flush.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // The critical assertion: exactly one call to getStudents on mount.
    expect(api.getStudents).toHaveBeenCalledTimes(1);
  });

  test('getStudents is called with page=1 on initial mount', async () => {
    render(<Dashboard />);

    await waitFor(() => {
      expect(api.getStudents).toHaveBeenCalled();
    });

    const [page] = api.getStudents.mock.calls[0];
    expect(page).toBe(1);
  });

  test('getStudents is called a second time when page changes (next page button)', async () => {
    // Provide enough total/pages so the Next button is enabled.
    api.getStudents.mockResolvedValue({
      data: { students: [], pages: 3, total: 60 },
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(api.getStudents).toHaveBeenCalledTimes(1);
    });

    // Click the Next page button to change page to 2.
    const nextBtn = screen.getByRole('button', { name: /next page/i });
    fireEvent.click(nextBtn);

    await waitFor(() => {
      expect(api.getStudents).toHaveBeenCalledTimes(2);
    });

    // Verify the second call uses page 2.
    const [page2] = api.getStudents.mock.calls[1];
    expect(page2).toBe(2);
  });

  test('filter change triggers exactly one new getStudents call', async () => {
    render(<Dashboard />);

    await waitFor(() => {
      expect(api.getStudents).toHaveBeenCalledTimes(1);
    });

    // Change the status filter.
    const statusSelect = screen.getByRole('combobox', { name: /filter by payment status/i });
    fireEvent.change(statusSelect, { target: { value: 'paid' } });

    await waitFor(() => {
      expect(api.getStudents).toHaveBeenCalledTimes(2);
    });

    // Should be exactly 2 now — no third call from a page effect.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(api.getStudents).toHaveBeenCalledTimes(2);
  });

  test('getPaymentSummary is called exactly once on mount', async () => {
    render(<Dashboard />);

    await waitFor(() => {
      expect(api.getPaymentSummary).toHaveBeenCalled();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(api.getPaymentSummary).toHaveBeenCalledTimes(1);
  });

});
