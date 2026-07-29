import { useState, useEffect, useCallback, useRef } from "react";
import SyncButton from "../components/SyncButton";
import ErrorBoundary from "../components/ErrorBoundary";
import StudentForm from "../components/StudentForm";
import PageHero, { StatCard } from "../components/PageHero";
import SseDegradedBanner from "../components/SseDegradedBanner";
import RequireAdmin from "../components/RequireAdmin";
import { usePaymentEvents } from "../hooks/usePaymentEvents";
import { getSyncStatus, getPaymentSummary, getStudents, getStudent } from "../services/api";
import {
  IconUsers, IconCheck, IconAlertTriangle, IconDollarSign,
  IconSearch, IconChevronLeft, IconChevronRight,
} from "../components/Icons";

const PAGE_SIZE = 20;

function timeAgo(iso) {
  if (!iso) return "Never";
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString();
}

const STATUS_BADGE = {
  paid:    { cls: "badge badge-success", label: "Paid" },
  partial: { cls: "badge badge-warning", label: "Partial" },
  unpaid:  { cls: "badge badge-danger",  label: "Unpaid" },
};

function Dashboard() {
  const [lastSyncAt, setLastSyncAt]           = useState(null);
  const [syncMsg, setSyncMsg]                 = useState(null);
  const [summary, setSummary]                 = useState(null);
  const [summaryLoading, setSummaryLoading]   = useState(true);
  const [summaryError, setSummaryError]       = useState(null);
  const [students, setStudents]               = useState([]);
  const [studentsLoading, setStudentsLoading] = useState(true);
  const [studentsError, setStudentsError]     = useState(null);
  const [page, setPage]                       = useState(1);
  const [pages, setPages]                     = useState(1);
  const [total, setTotal]                     = useState(0);
  const [search, setSearch]                   = useState("");
  const [statusFilter, setStatusFilter]       = useState("all");
  const [classFilter, setClassFilter]         = useState("");
  const [error, setError]                     = useState(null);
  const [editingStudent, setEditingStudent]   = useState(null);
  const [editingStudentData, setEditingStudentData] = useState(null);

  // Real-time SSE — surfaces degraded state when Redis pub/sub is unavailable (Issue #1054).
  const { degraded } = usePaymentEvents({
    onEvent: (type) => {
      // Refresh summary/students whenever a payment or dispute event arrives.
      if (type === 'payment' || type.startsWith('dispute')) {
        fetchSummary();
        fetchStudents(page, debouncedSearch, statusFilter, classFilter);
      }
    },
  });

  const searchDebounceRef = useRef(null);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // Holds the AbortController for the most-recent fetchStudents call so
  // superseded (stale) requests can be cancelled before the next one starts.
  const studentsAbortRef = useRef(null);

  useEffect(() => {
    clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(searchDebounceRef.current);
  }, [search]);

  const fetchSummary = useCallback(() => {
    setSummaryLoading(true);
    setSummaryError(null);
    getPaymentSummary()
      .then(({ data }) => setSummary(data))
      .catch(() => setSummaryError("Could not load payment summary."))
      .finally(() => setSummaryLoading(false));
  }, []);

  const fetchStudents = useCallback((p, srch, st, cls) => {
    // Cancel any in-flight student fetch before issuing a new one.
    studentsAbortRef.current?.abort();
    const controller = new AbortController();
    studentsAbortRef.current = controller;

    setStudentsLoading(true);
    setStudentsError(null);
    getStudents(p, PAGE_SIZE, { search: srch, status: st, className: cls }, { signal: controller.signal })
      .then(({ data }) => {
        setStudents(data.students);
        setPages(data.pages || 1);
        setTotal(data.total || 0);
      })
      .catch((err) => {
        // Silently ignore aborted (superseded) requests.
        if (err?.name === "CanceledError" || err?.code === "ERR_CANCELED") return;
        setStudentsError("Could not load student list.");
      })
      .finally(() => {
        // Only clear loading when this controller is still the current one.
        if (studentsAbortRef.current === controller) {
          setStudentsLoading(false);
        }
      });
  }, []);

  useEffect(() => {
    getSyncStatus()
      .then(({ data }) => setLastSyncAt(data.lastSyncAt))
      .catch(() => setError("Could not load sync status."));
    fetchSummary();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setPage(1);
    fetchStudents(1, debouncedSearch, statusFilter, classFilter);
  }, [debouncedSearch, statusFilter, classFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchStudents(page, debouncedSearch, statusFilter, classFilter);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSyncComplete(data) {
    setLastSyncAt(new Date().toISOString());
    setSyncMsg(data?.message || "Sync complete.");
    setTimeout(() => setSyncMsg(null), 3500);
    fetchSummary();
    setPage(1);
    fetchStudents(1, debouncedSearch, statusFilter, classFilter);
  }

  async function handleEditStudent(student) {
    try {
      const { data } = await getStudent(student.studentId);
      setEditingStudentData(data);
      setEditingStudent(student.studentId);
    } catch {
      setError("Failed to load student details");
    }
  }

  function handleCloseForm() {
    setEditingStudent(null);
    setEditingStudentData(null);
  }

  function handleSaveStudent() {
    handleCloseForm();
    fetchStudents(page, debouncedSearch, statusFilter, classFilter);
  }

  const stats = [
    {
      label: "Total Students",
      value: summary?.totalStudents ?? summary?.total ?? "—",
      Icon: IconUsers,
      color: "cyan",
    },
    {
      label: "Paid",
      value: summary?.paidCount ?? summary?.counts?.paid ?? "—",
      Icon: IconCheck,
      color: "green",
    },
    {
      label: "Pending",
      value: summary ? ((summary.unpaidCount || 0) + (summary.counts?.partial || 0)) || "—" : "—",
      Icon: IconAlertTriangle,
      color: "amber",
    },
    {
      label: "XLM Collected",
      value: summary
        ? (summary.totalXlmCollected || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })
        : "—",
      sub: "XLM total",
      Icon: IconDollarSign,
      color: "violet",
    },
  ];

  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd   = Math.min(page * PAGE_SIZE, total);

  return (
    <>
      <SseDegradedBanner degraded={degraded} />
      <style>{`        @keyframes dashFadeUp {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .dash-wrap { animation: dashFadeUp 0.35s ease both; }
        .dash-stat-row { --stat-accent: var(--c); }

        /* Inline toolbar override for search */
        .dash-search {
          position: relative;
        }
        .dash-search-icon {
          position: absolute;
          left: 0.65rem;
          top: 50%;
          transform: translateY(-50%);
          color: var(--text-muted);
          pointer-events: none;
          display: flex;
        }
        .dash-search input {
          padding-left: 2.125rem !important;
        }

        .student-row-name { font-weight: 500; color: var(--text); }
        .student-row-id { font-family: monospace; font-size: 0.78rem; color: var(--text-muted); }
        .student-row-class { font-size: 0.8125rem; color: var(--text-muted); }
        .student-row-fee { font-variant-numeric: tabular-nums; font-size: 0.875rem; }

        .stat-card-inner {
          display: flex;
          flex-direction: column;
        }
        .stat-card-icon-wrap {
          width: 36px; height: 36px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          margin-bottom: 0.875rem;
          flex-shrink: 0;
        }

        /* Skeleton pulse */
        @keyframes skel-pulse {
          0%,100% { opacity:1; } 50% { opacity:0.5; }
        }
        .skel-block {
          border-radius: 4px;
          background: var(--border);
          animation: skel-pulse 1.4s ease-in-out infinite;
        }
      `}</style>

      {/* Accessibility live regions */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {summaryLoading || studentsLoading ? "Loading dashboard data…" : "Dashboard data loaded."}
      </div>
      {(summaryError || studentsError) && (
        <div aria-live="assertive" aria-atomic="true" className="sr-only">
          {summaryError || studentsError}
        </div>
      )}

      <div className="page-wrap dash-wrap">

        {/* ── Centered Hero Header ──────────────────── */}
        <PageHero
          eyebrow="Admin Console"
          title="Payments Dashboard"
          subtitle="Monitor students, fees, and blockchain-settled payments in real time."
        >
          <SyncButton onSyncComplete={handleSyncComplete} lastSyncTime={lastSyncAt} />
          <span style={{ alignSelf: "center", fontSize: "0.82rem", color: "rgba(255,255,255,0.85)" }}>
            Last sync: <strong style={{ color: "#fff" }}>{timeAgo(lastSyncAt)}</strong>
          </span>
        </PageHero>

        {/* ── Alerts ────────────────────────────────── */}
        {syncMsg && (
          <div role="status" className="alert alert-success" style={{ marginBottom: "1.25rem" }}>
            <IconCheck size={16} />
            <span>{syncMsg}</span>
          </div>
        )}
        {error && (
          <div role="alert" className="alert alert-danger" style={{ marginBottom: "1.25rem" }}>
            <IconAlertTriangle size={16} />
            <span>{error}</span>
          </div>
        )}

        {/* ── Stat Cards ────────────────────────────── */}
        <ErrorBoundary>
          {summaryError ? (
            <div role="alert" className="alert alert-danger" style={{ marginBottom: "1.5rem" }}>
              <span style={{ flex: 1 }}>{summaryError}</span>
              <button onClick={fetchSummary} className="btn btn-sm btn-ghost" style={{ color: "inherit", borderColor: "currentColor", opacity: 0.8 }}>Retry</button>
            </div>
          ) : (
            <div className="stat-grid" style={{ marginBottom: "1.75rem" }}>
              {summaryLoading
                ? Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="stat-card" aria-hidden="true">
                      <div className="skel-block" style={{ width: 42, height: 42, borderRadius: 12, marginBottom: 16 }} />
                      <div className="skel-block" style={{ width: "60%", height: 10, marginBottom: 12 }} />
                      <div className="skel-block" style={{ width: "45%", height: 30 }} />
                    </div>
                  ))
                : stats.map((s) => <StatCard key={s.label} {...s} />)
              }
            </div>
          )}
        </ErrorBoundary>

        {/* ── Student Table ─────────────────────────── */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Students</div>
              {!studentsLoading && total > 0 && (
                <div className="card-subtitle">{total.toLocaleString()} total</div>
              )}
            </div>

            {/* Toolbar */}
            <div className="toolbar" role="search" aria-label="Filter students" style={{ margin: 0 }}>
              <div className="dash-search">
                <span className="dash-search-icon"><IconSearch size={14} /></span>
                <input
                  type="search"
                  placeholder="Name or ID…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  aria-label="Search students by name or ID"
                  style={{
                    padding: "0.4rem 0.7rem",
                    paddingLeft: "2.125rem",
                    border: "1.5px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    fontSize: "0.8125rem",
                    fontFamily: "inherit",
                    color: "var(--text)",
                    background: "var(--card-bg)",
                    outline: "none",
                    width: 180,
                    transition: "border-color 0.15s, box-shadow 0.15s",
                  }}
                  onFocus={e => { e.target.style.borderColor = "var(--accent)"; e.target.style.boxShadow = "0 0 0 3px var(--accent-subtle)"; }}
                  onBlur={e  => { e.target.style.borderColor = "var(--border)"; e.target.style.boxShadow = "none"; }}
                />
              </div>
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                aria-label="Filter by payment status"
                style={{
                  padding: "0.4rem 0.7rem",
                  border: "1.5px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  fontSize: "0.8125rem",
                  fontFamily: "inherit",
                  color: "var(--text)",
                  background: "var(--card-bg)",
                  outline: "none",
                  cursor: "pointer",
                }}
              >
                <option value="all">All Status</option>
                <option value="paid">Paid</option>
                <option value="partial">Partial</option>
                <option value="unpaid">Unpaid</option>
              </select>
              <select
                value={classFilter}
                onChange={e => setClassFilter(e.target.value)}
                aria-label="Filter by class"
                style={{
                  padding: "0.4rem 0.7rem",
                  border: "1.5px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  fontSize: "0.8125rem",
                  fontFamily: "inherit",
                  color: "var(--text)",
                  background: "var(--card-bg)",
                  outline: "none",
                  cursor: "pointer",
                }}
              >
                <option value="">All Classes</option>
                {["JSS1","JSS2","JSS3","SS1","SS2","SS3"].map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Table */}
          <ErrorBoundary>
            {studentsError ? (
              <div className="card-body">
                <div role="alert" className="alert alert-danger">
                  <span style={{ flex: 1 }}>{studentsError}</span>
                  <button
                    onClick={() => fetchStudents(page, debouncedSearch, statusFilter, classFilter)}
                    className="btn btn-sm btn-ghost"
                    style={{ color: "inherit", borderColor: "currentColor", opacity: 0.8 }}
                  >
                    Retry
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ overflowX: "auto" }} aria-busy={studentsLoading} aria-label="Student list">
                <table className="data-table" aria-label={studentsLoading ? "Loading students" : "Student list"}>
                  <thead>
                    <tr>
                      <th scope="col">Student ID</th>
                      <th scope="col">Name</th>
                      <th scope="col">Class</th>
                      <th scope="col">Fee</th>
                      <th scope="col">Status</th>
                      <th scope="col"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {studentsLoading ? (
                      Array.from({ length: 6 }).map((_, i) => (
                        <tr key={i}>
                          <td><div className="skel-block" style={{ height: 12, width: 72 }} /></td>
                          <td><div className="skel-block" style={{ height: 12, width: 130 }} /></td>
                          <td><div className="skel-block" style={{ height: 12, width: 44 }} /></td>
                          <td><div className="skel-block" style={{ height: 12, width: 56 }} /></td>
                          <td><div className="skel-block" style={{ height: 20, width: 52, borderRadius: 20 }} /></td>
                          <td><div className="skel-block" style={{ height: 28, width: 42, borderRadius: 6 }} /></td>
                        </tr>
                      ))
                    ) : students.length === 0 ? (
                      <tr>
                        <td colSpan="6">
                          <div className="empty-state">
                            <div className="empty-state-icon"><IconSearch size={26} /></div>
                            <div className="empty-state-title">No students found</div>
                            <div className="empty-state-desc">
                              {search || statusFilter !== "all" || classFilter ? "Try adjusting your search or filters." : "No students have been registered yet."}
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : students.map(s => {
                      const st = (s.status || "unpaid").toLowerCase();
                      const badge = STATUS_BADGE[st] || STATUS_BADGE.unpaid;
                      return (
                        <tr key={s.studentId}>
                          <td className="col-mono">{s.studentId}</td>
                          <td className="student-row-name">{s.name}</td>
                          <td className="student-row-class">{s.class}</td>
                          <td className="student-row-fee">
                            <span style={{ fontVariantNumeric: "tabular-nums" }}>{s.feeAmount}</span>
                            <span style={{ marginLeft: "0.25rem", fontSize: "0.72rem", color: "var(--text-muted)", fontWeight: 600 }}>XLM</span>
                          </td>
                          <td>
                            <span className={badge.cls}>{badge.label}</span>
                          </td>
                          <td>
                            <button
                              onClick={() => handleEditStudent(s)}
                              className="btn btn-sm btn-ghost"
                            >
                              Edit
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </ErrorBoundary>

          {/* Pagination */}
          {total > 0 && (
            <div style={{ padding: "0.875rem 1.25rem", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
              <span className="pagination-info" aria-live="polite" aria-atomic="true">
                {studentsLoading ? "Loading…" : `${rangeStart}–${rangeEnd} of ${total.toLocaleString()} students`}
              </span>
              <nav className="pagination-controls" aria-label="Student list pagination">
                <button
                  className="page-btn"
                  disabled={page === 1 || studentsLoading}
                  onClick={() => setPage(p => p - 1)}
                  aria-label="Previous page"
                  style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}
                >
                  <IconChevronLeft size={15} /> Prev
                </button>
                <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)", padding: "0 0.25rem" }} aria-current="page">
                  {page} / {pages}
                </span>
                <button
                  className="page-btn"
                  disabled={page === pages || studentsLoading}
                  onClick={() => setPage(p => p + 1)}
                  aria-label="Next page"
                  style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}
                >
                  Next <IconChevronRight size={15} />
                </button>
              </nav>
            </div>
          )}
        </div>
      </div>

      {editingStudentData && (
        <StudentForm
          student={editingStudentData}
          onClose={handleCloseForm}
          onSave={handleSaveStudent}
        />
      )}
    </>
  );
}

export default function DashboardPage() {
  return (
    <RequireAdmin>
      <Dashboard />
    </RequireAdmin>
  );
}
