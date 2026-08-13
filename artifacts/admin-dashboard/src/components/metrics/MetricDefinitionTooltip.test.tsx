// artifacts/admin-dashboard/src/components/metrics/MetricDefinitionTooltip.test.tsx
//
// Tests for the WAI-ARIA definition tooltip (HLP-001/002, Task 7).
//
// Verifies the accessibility + interaction contract:
//   - opens on focus (keyboard)
//   - opens on click (mouse)
//   - opens on tap (touch — same path as click)
//   - closes on Escape (trigger keeps focus)
//   - missing definition → explicit "Definition unavailable" fallback
//   - accessible label is set on the trigger button
//   - aria-describedby links the trigger to the tooltip panel
//
// jsdom doesn't implement layout, but radix Tooltip's open state is controlled
// by MetricDefinitionTooltip (not by pointer), so the panel renders into the
// portal as soon as `open` flips true — focus/click both flip it directly.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MetricDefinitionTooltip } from "./MetricDefinitionTooltip";

// A metric id that exists in the catalog (see definitions-catalog.ts).
const KNOWN_ID = "ov.yield.week";
// A metric id that does NOT exist — exercises the fallback branch.
const UNKNOWN_ID = "ov.does.not.exist";

describe("MetricDefinitionTooltip", () => {
  it("opens the tooltip on focus (keyboard)", async () => {
    const user = userEvent.setup();
    render(<MetricDefinitionTooltip id={KNOWN_ID} />);
    const trigger = screen.getByRole("button");
    await user.tab(); // moves focus onto the trigger
    expect(trigger).toHaveFocus();
    // The trigger's aria-expanded flips true when open.
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("opens the tooltip on click (mouse)", async () => {
    const user = userEvent.setup();
    render(<MetricDefinitionTooltip id={KNOWN_ID} />);
    const trigger = screen.getByRole("button");
    await user.click(trigger);
    // Radix renders the portal after the state update — assert via the panel
    // content (findAllByText awaits the re-render; radix mirrors the content
    // for aria-describedby so there are multiple matches). Also check the
    // trigger flag.
    expect((await screen.findAllByText(/Total Yield \(Week\)/i)).length).toBeGreaterThan(0);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("opens the tooltip on tap (touch)", async () => {
    const user = userEvent.setup();
    render(<MetricDefinitionTooltip id={KNOWN_ID} />);
    const trigger = screen.getByRole("button");
    // Touch tap is a pointerdown+up → click in jsdom; click handler toggles.
    await user.click(trigger);
    expect((await screen.findAllByText(/Total Yield \(Week\)/i)).length).toBeGreaterThan(0);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("closes on Escape and keeps focus on the trigger", async () => {
    const user = userEvent.setup();
    render(<MetricDefinitionTooltip id={KNOWN_ID} />);
    const trigger = screen.getByRole("button");
    await user.click(trigger);
    expect((await screen.findAllByText(/Total Yield \(Week\)/i)).length).toBeGreaterThan(0);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // The trigger keeps focus after Esc (per the component contract).
    expect(trigger).toHaveFocus();
  });

  it("renders the 'Definition unavailable' fallback for a missing id", async () => {
    const user = userEvent.setup();
    render(<MetricDefinitionTooltip id={UNKNOWN_ID} />);
    const trigger = screen.getByRole("button");
    await user.click(trigger);
    // The fallback text is rendered in the portal when open.
    expect((await screen.findAllByText(/definition unavailable/i)).length).toBeGreaterThan(0);
  });

  it("renders the catalog definition text for a known id when open", async () => {
    const user = userEvent.setup();
    render(<MetricDefinitionTooltip id={KNOWN_ID} />);
    const trigger = screen.getByRole("button");
    await user.click(trigger);
    // The term (line 1, bold) should appear in the open panel.
    expect((await screen.findAllByText(/Total Yield \(Week\)/i)).length).toBeGreaterThan(0);
  });

  it("sets an accessible label on the trigger button", () => {
    render(<MetricDefinitionTooltip id={KNOWN_ID} />);
    const trigger = screen.getByRole("button");
    // Default label is "Definition of {term}".
    expect(trigger).toHaveAccessibleName(/definition of total yield \(week\)/i);
  });

  it("honors an explicit ariaLabel override", () => {
    render(<MetricDefinitionTooltip id={KNOWN_ID} ariaLabel="What does this mean?" />);
    const trigger = screen.getByRole("button");
    expect(trigger).toHaveAccessibleName("What does this mean?");
  });

  it("links the trigger to the tooltip via aria-describedby when open", async () => {
    const user = userEvent.setup();
    render(<MetricDefinitionTooltip id={KNOWN_ID} />);
    const trigger = screen.getByRole("button");
    // Closed initially — no describedby link.
    expect(trigger).not.toHaveAttribute("aria-describedby");
    await user.click(trigger);
    // The panel renders into the portal after the state update.
    expect((await screen.findAllByText(/Total Yield \(Week\)/i)).length).toBeGreaterThan(0);
    const describedBy = trigger.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    // The describedby id points at a real element in the document (the panel).
    const panel = document.getElementById(describedBy!);
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute("role", "tooltip");
  });

  it("clicking the open trigger toggles it closed", async () => {
    const user = userEvent.setup();
    render(<MetricDefinitionTooltip id={KNOWN_ID} />);
    const trigger = screen.getByRole("button");
    await user.click(trigger);
    expect((await screen.findAllByText(/Total Yield \(Week\)/i)).length).toBeGreaterThan(0);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    // Second click toggles closed.
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
