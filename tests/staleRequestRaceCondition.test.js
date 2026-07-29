/**
 * @jest-environment jsdom
 *
 * Acceptance criteria:
 *   Two overlapping lookups are issued where the first-issued request resolves
 *   *after* the second.  The UI must reflect only the result of the most
 *   recently issued request — never the stale earlier one.
 *
 * Covers:
 *   - PaymentForm.lookupStudent  (AbortController via api.getStudent et al.)
 *   - Dashboard.fetchStudents    (AbortController via api.getStudents)
 */

'use strict';

import '@testing-library/jest-dom';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import PaymentForm from '../frontend/src/components/PaymentForm';
import Dashboard from '../frontend/src/pages/dashboard';
import * as api from '../frontend/src/services/api';

// ── Shared mocks ──────────────────────────────────────────────────────────────

jest.mock('../frontend/src/services/api');

// PaymentForm imports QRCodeSVG from qrcode.react — stub it so jsdom doesn't
// choke on canvas operations.
jest.mock('qrcode.react', () => ({
  QRCodeSVG: function MockQR() { return null; },
}));

// Dashboard sub-components that are irrelevant to the race-condition test.
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
jest.mock('../frontend/src/hooks/usePaymentEvents', () => ({
  usePaymentEvents: () => ({ degraded: false }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns a {promise, resolve, reject} tuple whose promise is only settled
 * when the caller invokes resolve/reject — giving the test full control over
 * resolution order.
 */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ── PaymentForm race-condition tests ──────────────────────────────────────────

describe('PaymentForm.lookupStudent — stale request race condition', () => {
  // Fixtures
  const studentA = {
    name: 'Alice Johnson',
    class: 'Grade 5A',
    feeAmount: 250,
    feePaid: false,
    studentId: 'STU-A',
  };
  const instructionsA = {
    walletAddress: 'GSCHOOL_WALLET_AAAA',
    memo: 'STU-A',
    feeAmount: 250,
    acceptedAssets: [{ code: 'XLM', displayName: 'Stellar Lumens' }],
  };

  const studentB = {
    name: 'Bob Smith',
    class: 'Grade 6B',
    feeAmount: 300,
    feePaid: true,
    studentId: 'STU-B',
  };
  const instructionsB = {
    walletAddress: 'GSCHOOL_WALLET_BBBB',
    memo: 'STU-B',
    feeAmount: 300,
    acceptedAssets: [{ code: 'XLM', displayName: 'Stellar Lumens' }],
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test(
    'when lookup-A is issued then lookup-B is issued and B resolves before A, ' +
    'the UI shows only B\'s student data',
    async () => {
      // Create separate deferred handles for each lookup so we can resolve them
      // in the desired order (B first, then A).
      const dA = deferred(); // controls lookup-A's getStudent call
      const dB = deferred(); // controls lookup-B's getStudent call

      let callCount = 0;
      api.getStudent.mockImplementation((_id, _opts) => {
        callCount += 1;
        if (callCount === 1) return dA.promise;
        return dB.promise;
      });
      api.getPaymentInstructions.mockImplementation((id, _opts) => {
        const data = id === 'STU-A' ? instructionsA : instructionsB;
        return Promise.resolve({ data });
      });
      api.getStudentPayments.mockResolvedValue({ data: [] });
      api.getStudentBalance.mockResolvedValue({ data: { hasDeletedPayments: false } });

      render(<PaymentForm />);

      // --- Issue lookup A ---
      const input = screen.getByRole('textbox');
      await act(async () => {
        fireEvent.change(input, { target: { value: 'STU-A' } });
      });
      // Trigger lookup A via form submit to avoid debounce timing in tests.
      await act(async () => {
        fireEvent.submit(input.closest('form'));
      });

      // --- Issue lookup B (supersedes A) ---
      await act(async () => {
        fireEvent.change(input, { target: { value: 'STU-B' } });
      });
      await act(async () => {
        fireEvent.submit(input.closest('form'));
      });

      // --- Resolve B first ---
      await act(async () => {
        dB.resolve({ data: studentB });
      });

      // UI should now show student B's name.
      await waitFor(() => {
        expect(screen.getByText('Bob Smith')).toBeInTheDocument();
      });

      // --- Now resolve A (the stale request) ---
      await act(async () => {
        dA.resolve({ data: studentA });
      });

      // After the stale response lands, the UI must NOT switch to student A.
      // Give React a tick to process any (incorrect) state update.
      await act(async () => {});

      expect(screen.queryByText('Alice Johnson')).not.toBeInTheDocument();
      expect(screen.getByText('Bob Smith')).toBeInTheDocument();
    }
  );

  test(
    'when lookup-A is superseded, loading state clears only after the current (B) lookup settles',
    async () => {
      const dA = deferred();
      const dB = deferred();

      let callCount = 0;
      api.getStudent.mockImplementation(() => {
        callCount += 1;
        return callCount === 1 ? dA.promise : dB.promise;
      });
      api.getPaymentInstructions.mockResolvedValue({ data: instructionsB });
      api.getStudentPayments.mockResolvedValue({ data: [] });
      api.getStudentBalance.mockResolvedValue({ data: { hasDeletedPayments: false } });

      render(<PaymentForm />);

      const input = screen.getByRole('textbox');

      // Issue A then B.
      await act(async () => { fireEvent.change(input, { target: { value: 'STU-A' } }); });
      await act(async () => { fireEvent.submit(input.closest('form')); });
      await act(async () => { fireEvent.change(input, { target: { value: 'STU-B' } }); });
      await act(async () => { fireEvent.submit(input.closest('form')); });

      // Resolve the stale request A — loading indicator should NOT disappear yet
      // because B is still in flight.
      await act(async () => { dA.resolve({ data: studentA }); });

      const submitBtn = screen.getByRole('button', { name: /Get Payment Instructions/i });
      expect(submitBtn).toBeDisabled(); // still loading

      // Now resolve B — loading should clear.
      await act(async () => { dB.resolve({ data: studentB }); });

      await waitFor(() => {
        expect(submitBtn).not.toBeDisabled();
      });
    }
  );
});

// ── Dashboard.fetchStudents race-condition tests ───────────────────────────────

describe('Dashboard.fetchStudents — stale request race condition', () => {
  const studentsPage1 = [
    { studentId: 'STU001', name: 'Alice',   class: 'JSS1', feeAmount: 100, status: 'unpaid' },
  ];
  const studentsPage2 = [
    { studentId: 'STU002', name: 'Bob',     class: 'JSS2', feeAmount: 200, status: 'paid'   },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    api.getSyncStatus.mockResolvedValue({ data: { lastSyncAt: null } });
    api.getPaymentSummary.mockResolvedValue({
      data: { totalStudents: 2, paidCount: 1, unpaidCount: 1, totalXlmCollected: 100 },
    });
  });

  test(
    'when fetch-1 is issued then fetch-2 is issued and fetch-2 resolves first, ' +
    'the UI shows only fetch-2\'s students',
    async () => {
      const d1 = deferred(); // first fetch (stale)
      const d2 = deferred(); // second fetch (current)

      let callCount = 0;
      api.getStudents.mockImplementation(() => {
        callCount += 1;
        return callCount === 1 ? d1.promise : d2.promise;
      });

      render(<Dashboard />);

      // First fetch is triggered on mount.  Wait for it to be in flight.
      await act(async () => {});

      // Trigger a second fetch by changing the search filter (simulates rapid
      // typing / filter change before the first response arrives).
      const searchInput = screen.getByRole('searchbox');
      await act(async () => {
        fireEvent.change(searchInput, { target: { value: 'Bob' } });
        // Flush the debounce immediately.
        jest.runAllTimers && jest.runAllTimers();
      });

      // Let the debounce settle so that debouncedSearch updates and the second
      // fetch is issued.
      await act(async () => {});

      // Resolve the newer (second) fetch first with Bob.
      await act(async () => {
        d2.resolve({ data: { students: studentsPage2, pages: 1, total: 1 } });
      });

      await waitFor(() => {
        expect(screen.getByText('Bob')).toBeInTheDocument();
      });

      // Now resolve the stale (first) fetch with Alice — should be ignored.
      await act(async () => {
        d1.resolve({ data: { students: studentsPage1, pages: 1, total: 1 } });
      });

      await act(async () => {});

      expect(screen.queryByText('Alice')).not.toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
    }
  );

  test(
    'when a stale fetch resolves with an error, the error is not surfaced if a newer fetch succeeded',
    async () => {
      const d1 = deferred(); // stale fetch
      const d2 = deferred(); // current fetch

      let callCount = 0;
      api.getStudents.mockImplementation(() => {
        callCount += 1;
        return callCount === 1 ? d1.promise : d2.promise;
      });

      render(<Dashboard />);
      await act(async () => {});

      const searchInput = screen.getByRole('searchbox');
      await act(async () => {
        fireEvent.change(searchInput, { target: { value: 'Bob' } });
      });
      await act(async () => {});

      // Second fetch resolves successfully with Bob.
      await act(async () => {
        d2.resolve({ data: { students: studentsPage2, pages: 1, total: 1 } });
      });

      await waitFor(() => expect(screen.getByText('Bob')).toBeInTheDocument());

      // Stale first fetch is aborted — simulate axios CanceledError.
      const cancelError = new Error('canceled');
      cancelError.code = 'ERR_CANCELED';
      await act(async () => { d1.reject(cancelError); });
      await act(async () => {});

      // No error banner should appear — the abort is silent.
      expect(screen.queryByText(/Could not load student list/i)).not.toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
    }
  );
});
