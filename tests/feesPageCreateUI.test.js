/**
 * @jest-environment jsdom
 *
 * Tests for the /fees page (fee-structure creation UI) and navigation.
 *
 * Acceptance criteria:
 *  1. /fees is reachable from the admin nav (AppLayout ADMIN_NAV includes it).
 *  2. The page renders a create-fee-structure form.
 *  3. Submitting the form calls createFeeStructure with the correct payload.
 *  4. A newly created fee appears in the table after a successful submission.
 *  5. An API error during creation is surfaced to the user.
 *  6. The page renders the existing fee structures list on load.
 */

'use strict';

import '@testing-library/jest-dom';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import FeesPage from '../frontend/src/pages/fees';
import * as api from '../frontend/src/services/api';

// ── Mock the API module ───────────────────────────────────────────────────────

jest.mock('../frontend/src/services/api');

// ── Mock sub-components that FeesPage pulls in ────────────────────────────────

jest.mock('../frontend/src/components/PageHero', () => {
  return {
    __esModule: true,
    default: function MockPageHero({ title }) {
      return <h1>{title}</h1>;
    },
  };
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const EXISTING_FEE = {
  className: 'JSS1',
  feeAmount: 200,
  academicYear: '2025',
  description: 'Existing fee',
};

const NEW_FEE = {
  className: 'SS1',
  feeAmount: 350,
  academicYear: '2026',
  description: 'New fee',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function setupDefaultMocks() {
  api.getFeeStructures.mockResolvedValue({ data: [EXISTING_FEE] });
  api.getStudents.mockResolvedValue({ data: { students: [], total: 0 } });
  api.createFeeStructure.mockResolvedValue({ data: NEW_FEE });
  api.deleteFeeStructure.mockResolvedValue({});
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('/fees page — create fee structure form', () => {
  it('renders the create form with all required fields', async () => {
    setupDefaultMocks();
    render(<FeesPage />);

    // Wait for initial load to settle
    await waitFor(() => expect(api.getFeeStructures).toHaveBeenCalledTimes(1));

    // Class select
    expect(screen.getByLabelText(/class/i)).toBeInTheDocument();
    // Fee amount input
    expect(screen.getByLabelText(/fee amount/i)).toBeInTheDocument();
    // Academic year
    expect(screen.getByLabelText(/academic year/i)).toBeInTheDocument();
    // Description
    expect(screen.getByLabelText(/description/i)).toBeInTheDocument();
    // Submit button
    expect(screen.getByRole('button', { name: /create/i })).toBeInTheDocument();
  });

  it('calls createFeeStructure with the correct payload on submit', async () => {
    setupDefaultMocks();
    render(<FeesPage />);
    await waitFor(() => expect(api.getFeeStructures).toHaveBeenCalled());

    // Fill the form
    fireEvent.change(screen.getByLabelText(/class/i), {
      target: { value: 'SS1' },
    });
    fireEvent.change(screen.getByLabelText(/fee amount/i), {
      target: { value: '350' },
    });
    fireEvent.change(screen.getByLabelText(/academic year/i), {
      target: { value: '2026' },
    });
    fireEvent.change(screen.getByLabelText(/description/i), {
      target: { value: 'New fee' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(api.createFeeStructure).toHaveBeenCalledWith({
        className: 'SS1',
        feeAmount: 350,
        academicYear: '2026',
        description: 'New fee',
      });
    });
  });

  it('shows the newly created fee in the table after successful submission', async () => {
    setupDefaultMocks();
    render(<FeesPage />);
    await waitFor(() => expect(api.getFeeStructures).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/class/i), { target: { value: 'SS1' } });
    fireEvent.change(screen.getByLabelText(/fee amount/i), { target: { value: '350' } });

    fireEvent.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      // New fee's class should now appear in the table
      expect(screen.getByText('SS1')).toBeInTheDocument();
    });
  });

  it('shows a success message after a fee is created', async () => {
    setupDefaultMocks();
    render(<FeesPage />);
    await waitFor(() => expect(api.getFeeStructures).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/class/i), { target: { value: 'SS1' } });
    fireEvent.change(screen.getByLabelText(/fee amount/i), { target: { value: '350' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/fee structure created successfully/i)
      ).toBeInTheDocument();
    });
  });

  it('resets the form fields after a successful creation', async () => {
    setupDefaultMocks();
    render(<FeesPage />);
    await waitFor(() => expect(api.getFeeStructures).toHaveBeenCalled());

    const classSelect  = screen.getByLabelText(/class/i);
    const amountInput  = screen.getByLabelText(/fee amount/i);

    fireEvent.change(classSelect,  { target: { value: 'SS1' } });
    fireEvent.change(amountInput,  { target: { value: '350' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(classSelect.value).toBe('');
      expect(amountInput.value).toBe('');
    });
  });

  it('shows an error alert when createFeeStructure fails', async () => {
    api.getFeeStructures.mockResolvedValue({ data: [] });
    api.createFeeStructure.mockRejectedValue({
      response: { data: { error: 'Active fee structure already exists for class SS1', code: 'DUPLICATE_FEE_STRUCTURE' } },
    });

    render(<FeesPage />);
    await waitFor(() => expect(api.getFeeStructures).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/class/i), { target: { value: 'SS1' } });
    fireEvent.change(screen.getByLabelText(/fee amount/i), { target: { value: '350' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });

  it('validates client-side: shows error if className is missing on submit', async () => {
    api.getFeeStructures.mockResolvedValue({ data: [] });
    render(<FeesPage />);
    await waitFor(() => expect(api.getFeeStructures).toHaveBeenCalled());

    // Only fill in amount, leave class empty
    fireEvent.change(screen.getByLabelText(/fee amount/i), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(api.createFeeStructure).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });

  it('validates client-side: shows error if feeAmount is zero or invalid', async () => {
    api.getFeeStructures.mockResolvedValue({ data: [] });
    render(<FeesPage />);
    await waitFor(() => expect(api.getFeeStructures).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/class/i), { target: { value: 'JSS1' } });
    fireEvent.change(screen.getByLabelText(/fee amount/i), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(api.createFeeStructure).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });
});

describe('/fees page — existing fee structures table', () => {
  it('renders existing fee structures from the API', async () => {
    api.getFeeStructures.mockResolvedValue({ data: [EXISTING_FEE] });
    render(<FeesPage />);

    await waitFor(() => {
      expect(screen.getByText('JSS1')).toBeInTheDocument();
      expect(screen.getByText(/200/)).toBeInTheDocument();
    });
  });

  it('shows an empty state message when no fee structures exist', async () => {
    api.getFeeStructures.mockResolvedValue({ data: [] });
    render(<FeesPage />);

    await waitFor(() => {
      expect(
        screen.getByText(/no fee structures found/i)
      ).toBeInTheDocument();
    });
  });

  it('shows a load error when getFeeStructures fails', async () => {
    api.getFeeStructures.mockRejectedValue(new Error('Network error'));
    render(<FeesPage />);

    await waitFor(() => {
      expect(
        screen.getByText(/could not load fee structures/i)
      ).toBeInTheDocument();
    });
  });

  it('shows a Delete button for each fee structure', async () => {
    api.getFeeStructures.mockResolvedValue({ data: [EXISTING_FEE] });
    render(<FeesPage />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /delete fee structure for JSS1/i })
      ).toBeInTheDocument();
    });
  });
});

describe('/fees page — nav link (source-level assertion)', () => {
  const fs = require('fs');
  const path = require('path');

  const appLayoutSrc = fs.readFileSync(
    path.join(__dirname, '../frontend/src/components/AppLayout.jsx'),
    'utf8'
  );
  const appSrc = fs.readFileSync(
    path.join(__dirname, '../frontend/src/pages/_app.jsx'),
    'utf8'
  );

  it('AppLayout ADMIN_NAV includes an href to /fees', () => {
    expect(appLayoutSrc).toContain('href: "/fees"');
  });

  it('AppLayout imports IconDollarSign for the Fees nav item', () => {
    expect(appLayoutSrc).toMatch(/IconDollarSign/);
  });

  it('_app.jsx APP_LAYOUT_ROUTES includes /fees', () => {
    expect(appSrc).toContain('"/fees"');
  });

  it('fees.jsx imports and calls createFeeStructure', () => {
    const feesSrc = fs.readFileSync(
      path.join(__dirname, '../frontend/src/pages/fees.jsx'),
      'utf8'
    );
    expect(feesSrc).toMatch(/import.*createFeeStructure.*from/);
    expect(feesSrc).toMatch(/createFeeStructure\(/);
  });
});
