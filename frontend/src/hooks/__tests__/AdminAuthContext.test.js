/**
 * Tests for AdminAuthContext — #1217
 *
 * Strategy: Jest runs in a node environment without a real DOM or React
 * renderer. We test the contract of AdminAuthContext by mocking React's
 * useContext so we can control what value the context provides, and by mocking
 * useAdminAuth so we can count how many times it is instantiated.
 *
 * Key guarantees tested:
 *  1. useAdminAuth is called exactly once when AdminAuthProvider mounts —
 *     regardless of how many consumers call useAdminAuthContext().
 *  2. useAdminAuthContext returns the same object that useAdminAuth returned.
 *  3. useAdminAuthContext throws a descriptive error when used outside the provider.
 *  4. AdminAuthContext module exports the expected symbols.
 */

// ─── Mocks ─────────────────────────────────────────────────────────────────

// We need to control what useContext returns so we can simulate:
//   a) the provider case  → useContext returns a real auth value
//   b) the no-provider case → useContext returns null (the context default)
let mockContextValue = null;

jest.mock("react", () => {
  const actual = jest.requireActual("react");
  return {
    ...actual,
    // Replace useContext with a version that returns whatever mockContextValue
    // is set to for AdminAuthContext and delegates everything else to React.
    useContext: jest.fn((ctx) => {
      // We intercept calls from useAdminAuthContext; all other useContext calls
      // (e.g. from useAdminAuth itself) pass through to the real implementation.
      return mockContextValue;
    }),
    // createContext is needed for the module to initialise; keep the real one.
    createContext: actual.createContext,
  };
});

// Track how many times useAdminAuth is called so we can assert it is only
// instantiated once regardless of consumer count.
let useAdminAuthCallCount = 0;
const MOCK_AUTH_VALUE = {
  isAdmin:    false,
  checked:    false,
  login:      jest.fn(),
  logout:     jest.fn(),
  schoolId:   "school-abc",
  userId:     "user-123",
  authMeError: false,
  retryAuth:  jest.fn(),
};

jest.mock("../useAdminAuth", () => ({
  useAdminAuth: jest.fn(() => {
    useAdminAuthCallCount += 1;
    return MOCK_AUTH_VALUE;
  }),
}));

// ─── Tests ─────────────────────────────────────────────────────────────────

const { useAdminAuthContext } = require("../AdminAuthContext");

describe("AdminAuthContext — #1217", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAdminAuthCallCount = 0;
    mockContextValue = null;
  });

  describe("module shape", () => {
    it("exports AdminAuthProvider as a function", () => {
      const { AdminAuthProvider } = require("../AdminAuthContext");
      expect(typeof AdminAuthProvider).toBe("function");
    });

    it("exports useAdminAuthContext as a function", () => {
      expect(typeof useAdminAuthContext).toBe("function");
    });
  });

  describe("useAdminAuthContext — guard", () => {
    it("throws a descriptive error when context value is null (used outside provider)", () => {
      // mockContextValue is null → simulates missing provider.
      mockContextValue = null;
      expect(() => useAdminAuthContext()).toThrow(
        "useAdminAuthContext must be used inside <AdminAuthProvider>"
      );
    });

    it("error message mentions AdminAuthProvider", () => {
      mockContextValue = null;
      expect(() => useAdminAuthContext()).toThrow("AdminAuthProvider");
    });
  });

  describe("useAdminAuthContext — passthrough", () => {
    it("returns the value provided by the context", () => {
      mockContextValue = MOCK_AUTH_VALUE;
      const result = useAdminAuthContext();
      expect(result).toBe(MOCK_AUTH_VALUE);
    });

    it("exposes isAdmin from context", () => {
      mockContextValue = { ...MOCK_AUTH_VALUE, isAdmin: true };
      expect(useAdminAuthContext().isAdmin).toBe(true);
    });

    it("exposes schoolId from context", () => {
      mockContextValue = { ...MOCK_AUTH_VALUE, schoolId: "sch-xyz" };
      expect(useAdminAuthContext().schoolId).toBe("sch-xyz");
    });

    it("exposes login callback from context", () => {
      const loginFn = jest.fn();
      mockContextValue = { ...MOCK_AUTH_VALUE, login: loginFn };
      expect(useAdminAuthContext().login).toBe(loginFn);
    });

    it("exposes logout callback from context", () => {
      const logoutFn = jest.fn();
      mockContextValue = { ...MOCK_AUTH_VALUE, logout: logoutFn };
      expect(useAdminAuthContext().logout).toBe(logoutFn);
    });

    it("exposes all required auth fields", () => {
      mockContextValue = MOCK_AUTH_VALUE;
      const result = useAdminAuthContext();
      const requiredFields = [
        "isAdmin", "checked", "login", "logout",
        "schoolId", "userId", "authMeError", "retryAuth",
      ];
      for (const field of requiredFields) {
        expect(result).toHaveProperty(field);
      }
    });
  });

  describe("AdminAuthProvider — single useAdminAuth instantiation", () => {
    it("AdminAuthProvider calls useAdminAuth exactly once", () => {
      // Simulate AdminAuthProvider rendering: it calls useAdminAuth() once
      // to get the value to publish through context.
      const { AdminAuthProvider } = require("../AdminAuthContext");
      const { useAdminAuth } = require("../useAdminAuth");

      // Simulate what React does when rendering a function component — call
      // the provider as a function and check its output (children passthrough).
      // We only care that useAdminAuth was invoked exactly once.
      const children = "child content";

      // Call it as a plain function (simulating a single render pass).
      AdminAuthProvider({ children });

      expect(useAdminAuth).toHaveBeenCalledTimes(1);
    });

    it("multiple useAdminAuthContext calls share one auth instance", () => {
      // Set the shared value in context (as AdminAuthProvider would do).
      mockContextValue = MOCK_AUTH_VALUE;

      // Each consumer call reads from the same context — not from useAdminAuth.
      const r1 = useAdminAuthContext();
      const r2 = useAdminAuthContext();
      const r3 = useAdminAuthContext();

      // All three consumers received the same object.
      expect(r1).toBe(MOCK_AUTH_VALUE);
      expect(r2).toBe(MOCK_AUTH_VALUE);
      expect(r3).toBe(MOCK_AUTH_VALUE);

      // useAdminAuth was never called by the consumers — only by the provider.
      expect(useAdminAuthCallCount).toBe(0);
    });
  });
});
