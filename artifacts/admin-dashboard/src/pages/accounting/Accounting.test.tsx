import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithQueryClient, screen, fireEvent, waitFor, within } from "@/test-utils";
import userEvent from "@testing-library/user-event";
import { Accounting } from "./Accounting";
import * as apiClient from "@workspace/api-client-react";

// Mock dependencies
vi.mock("wouter", () => ({
  useSearch: () => "",
  useRouter: () => ({
    back: vi.fn(),
  }),
}));

vi.mock("@workspace/metrics", () => ({
  // MetricCard only routes through TierBMetricCard (the component this file
  // mocks below) when source/template/templateParams are all present — see
  // MetricCard.tsx's `isTierB` check. Without them every card falls through
  // to the real, unmocked Renderer instead, and none of the TierBMetricCard
  // mock's test ids/text ever appear.
  getMetricDef: (id: string) => ({
    id,
    label: `Metric ${id}`,
    tab: "accounting",
    render: "kpi",
    unit: "USD",
    source: "metrics",
    template: "test-template",
    templateParams: {},
  }),
}));

vi.mock("@/hooks/use-metric-selection", () => ({
  useMetricSelection: () => ({
    selected: ["metric-1", "metric-2", "metric-3", "metric-ar-aging"],
    selectable: ["metric-1", "metric-2", "metric-3", "metric-ar-aging"],
    toggle: vi.fn(),
    reorder: vi.fn(),
    reset: vi.fn(),
  }),
}));

const mockGetAccountingStatus = vi.fn();
const mockPostAccountingDisconnect = vi.fn();
const mockGetAccountingConnectUri = vi.fn();

vi.spyOn(apiClient, "useGetAccountingStatus").mockImplementation(() => ({
  data: { connected: true, companyName: "Test Farm Inc" } as any,
  isLoading: false,
  refetch: vi.fn(),
} as any));

vi.spyOn(apiClient, "usePostAccountingDisconnect").mockImplementation(() => ({
  mutate: mockPostAccountingDisconnect,
  isPending: false,
} as any));

vi.spyOn(apiClient, "getAccountingConnectUri").mockImplementation(mockGetAccountingConnectUri);

// Mock the TierBMetricCard to control error responses
vi.mock("@/components/metrics/TierBMetricCard", () => ({
  TierBMetricCard: ({ def, suppressConnectionError, onMetricError }: any) => {
    const isConnectionError = def.id === "metric-1" || def.id === "metric-2";
    const isCardError = def.id === "metric-ar-aging";

    // Simulate connection error (401/invalid_grant)
    if (isConnectionError && !suppressConnectionError) {
      const error = { error: "invalid_grant" };
      onMetricError?.(error);
      return (
        <div data-testid={`card-${def.id}`} role="alert">
          Unable to load metric
          <div>{error.error}</div>
        </div>
      );
    }

    // When connection error is suppressed, show skeleton
    if (isConnectionError && suppressConnectionError) {
      return (
        <div data-testid={`card-${def.id}`} className="animate-pulse">
          <div className="h-6 w-20 bg-gray-200 rounded"></div>
          <div className="mt-2 h-20 w-full bg-gray-200 rounded"></div>
        </div>
      );
    }

    // Card-scoped error (500)
    if (isCardError) {
      return (
        <div data-testid={`card-${def.id}`} role="alert">
          Unable to load metric
          <div>500 Server Error</div>
          <button>Retry</button>
        </div>
      );
    }

    return <div data-testid={`card-${def.id}`}>Test Value</div>;
  },
}));

describe("Accounting - QuickBooks failure state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows exactly 1 banner and 0 card errors on connection-level 401 failure", async () => {
    const { container } = renderWithQueryClient(<Accounting />);

    // Wait for cards to render and trigger connection error
    await waitFor(() => {
      // Verify connection-level error banner is shown
      expect(screen.getByText("QuickBooks connection expired.")).toBeInTheDocument();
      expect(screen.getByText(/Reconnect to resume syncing/)).toBeInTheDocument();
    });

    // Count alert-role elements (error messages)
    const alerts = screen.queryAllByRole("alert");
    // Should only have the banner alert, not card-level errors
    const cardErrors = alerts.filter((alert) => {
      const text = alert.textContent || "";
      return text.includes("invalid_grant");
    });

    expect(cardErrors.length).toBe(0);
  });

  it("shows card-scoped error even with healthy connection", async () => {
    renderWithQueryClient(<Accounting />);

    await waitFor(() => {
      // The AR Aging card (card-scoped error) should show its own error+retry
      const arAgingCard = screen.getByTestId("card-metric-ar-aging");
      expect(within(arAgingCard).getByText("500 Server Error")).toBeInTheDocument();
      expect(within(arAgingCard).getByText("Retry")).toBeInTheDocument();
    });
  });

  it("shows Disconnect in overflow menu and requires confirmation", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<Accounting />);

    // Find and click the overflow menu button
    const overflowButton = screen.getByRole("button", { name: /more options/i });
    await user.click(overflowButton);

    // Disconnect should be in the dropdown
    const disconnectOption = screen.getByText("Disconnect QuickBooks");
    await user.click(disconnectOption);

    // Confirm dialog should appear
    await waitFor(() => {
      expect(screen.getByText("Disconnect QuickBooks?")).toBeInTheDocument();
      expect(screen.getByText(/Syncing stops immediately/)).toBeInTheDocument();
    });

    // Verify Cancel and Disconnect buttons exist
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Disconnect/ })).toBeInTheDocument();
  });

  it("never shows Disconnect as the only visible CTA during connection failure", async () => {
    const { container } = renderWithQueryClient(<Accounting />);

    // Wait for connection error to be detected
    await waitFor(() => {
      expect(screen.getByText("QuickBooks connection expired.")).toBeInTheDocument();
    });

    // The Reconnect button should be the primary CTA
    const reconnectButton = screen.getByRole("button", { name: /Reconnect QuickBooks/ });
    expect(reconnectButton).toBeInTheDocument();

    // Disconnect should be hidden in overflow menu, not visible as primary button
    const mainButtons = screen.queryAllByRole("button");
    const disconnectButtons = mainButtons.filter((btn) => btn.textContent?.includes("Disconnect"));
    expect(disconnectButtons.length).toBe(0); // Not shown as main button
  });

  it("reconnect button resets connection state", async () => {
    const user = userEvent.setup();
    mockGetAccountingConnectUri.mockResolvedValueOnce({ authorizeUri: "https://qbo-auth.example.com" });

    const { rerender } = renderWithQueryClient(<Accounting />);

    // Wait for error state
    await waitFor(() => {
      expect(screen.getByText("QuickBooks connection expired.")).toBeInTheDocument();
    });

    // Click Reconnect
    const reconnectButton = screen.getByRole("button", { name: /Reconnect QuickBooks/ });
    await user.click(reconnectButton);

    // Should attempt to open OAuth flow
    expect(mockGetAccountingConnectUri).toHaveBeenCalled();
  });

  it("disconnects with confirmation dialog", async () => {
    const user = userEvent.setup();
    mockPostAccountingDisconnect.mockImplementationOnce(
      (_: any, { onSuccess }: any) => onSuccess(),
    );

    renderWithQueryClient(<Accounting />);

    // Open dropdown
    const overflowButton = screen.getByRole("button", { name: /more options/i });
    await user.click(overflowButton);

    // Click Disconnect
    await user.click(screen.getByText("Disconnect QuickBooks"));

    // Confirm the action
    await waitFor(() => {
      expect(screen.getByText("Disconnect QuickBooks?")).toBeInTheDocument();
    });

    const confirmButton = screen.getByRole("button", { name: /Disconnect$/ });
    await user.click(confirmButton);

    // Should call disconnect mutation
    expect(mockPostAccountingDisconnect).toHaveBeenCalled();
  });

  it("shows suppress skeleton for connection errors but not card-scoped errors", async () => {
    renderWithQueryClient(<Accounting />);

    await waitFor(() => {
      // Connection-level error cards should show skeletons
      const connectionErrorCards = [
        screen.getByTestId("card-metric-1"),
        screen.getByTestId("card-metric-2"),
      ];

      connectionErrorCards.forEach((card) => {
        expect(card).toHaveClass("animate-pulse");
        expect(within(card).queryByText("invalid_grant")).not.toBeInTheDocument();
      });

      // Card-scoped error should show its own error
      const arAgingCard = screen.getByTestId("card-metric-ar-aging");
      expect(within(arAgingCard).getByText("500 Server Error")).toBeInTheDocument();
      expect(within(arAgingCard).getByText("Retry")).toBeInTheDocument();
    });
  });
});
