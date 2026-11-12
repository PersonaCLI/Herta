import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithLocale } from "../../i18n/test-util.js";
import { TurnFailedRow, turnFailedMessageKey } from "./TurnFailedRow.js";

describe("turnFailedMessageKey", () => {
  it("maps the official DeepSeek error codes to their specific messages", () => {
    expect(turnFailedMessageKey(401)).toBe("workspace.turnFailed401");
    expect(turnFailedMessageKey(402)).toBe("workspace.turnFailed402");
    expect(turnFailedMessageKey(429)).toBe("workspace.turnFailed429");
    expect(turnFailedMessageKey(500)).toBe("workspace.turnFailed500");
    expect(turnFailedMessageKey(503)).toBe("workspace.turnFailed503");
  });

  it("everything else stays the generic connection-lost message", () => {
    expect(turnFailedMessageKey(null)).toBe("workspace.turnFailed");
    // 400/422 are malformed-request bugs on OUR side — generic by design.
    expect(turnFailedMessageKey(400)).toBe("workspace.turnFailed");
    expect(turnFailedMessageKey(422)).toBe("workspace.turnFailed");
  });

  it("a certificate/proxy failure gets its own message (audit S3)", () => {
    // It arrives with no HTTP status at all, so before this it was
    // indistinguishable from a dropped connection.
    expect(turnFailedMessageKey(null, "network-tls")).toBe(
      "workspace.turnFailedTls",
    );
  });

  it("a message too large for the model says so, and not `connection lost` (review 2026-11-10)", () => {
    expect(turnFailedMessageKey(null, "prompt-too-large")).toBe(
      "workspace.turnFailedTooLarge",
    );
  });

  it("other provider codes fall through to the status mapping", () => {
    expect(turnFailedMessageKey(402, "http")).toBe("workspace.turnFailed402");
    expect(turnFailedMessageKey(null, "network")).toBe("workspace.turnFailed");
    expect(turnFailedMessageKey(null, "stall")).toBe("workspace.turnFailed");
  });
});

describe("TurnFailedRow", () => {
  it("a 402 failure tells the user to top up, not to check the network", () => {
    renderWithLocale(<TurnFailedRow status={402} />);
    expect(
      screen.getByText(
        "Insufficient DeepSeek balance — top up and send again.",
      ),
    ).toBeInTheDocument();
  });

  it("a status-less failure shows the generic message", () => {
    renderWithLocale(<TurnFailedRow status={null} />);
    expect(
      screen.getByText(
        "Connection lost — this reply was not delivered. Please send again.",
      ),
    ).toBeInTheDocument();
  });

  it("a proxy/certificate failure says resending will not help", () => {
    renderWithLocale(
      <TurnFailedRow status={null} providerCode="network-tls" />,
    );
    expect(
      screen.getByText(
        "The secure connection to DeepSeek was refused — usually a company proxy or VPN. Resending will not help; check your network settings.",
      ),
    ).toBeInTheDocument();
  });
});
