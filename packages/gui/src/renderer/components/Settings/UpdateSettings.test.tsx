import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { UpdateSettings } from "./UpdateSettings.js";

function renderPane(mock = createMockHertaBridge()) {
  renderWithLocale(
    <HertaBridgeProvider bridge={mock.bridge}>
      <UpdateSettings />
    </HertaBridgeProvider>,
  );
  return mock;
}

describe("UpdateSettings", () => {
  it("shows the app version and the manual check button; the button checks", async () => {
    const mock = renderPane(createMockHertaBridge({ appVersion: "0.1.0" }));
    expect(await screen.findByText("v0.1.0")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Check for updates" });
    btn.click();
    expect(mock.calls.checkForUpdate).toBe(1);
    // `idle` is "no news" — never checked, auto-update off, unsupported
    // build, or an automatic check that failed silently by design. Only a
    // COMPLETED check that returned nothing newer prints "Up to date"
    // (audit 2026-07-24, 1.13); claiming it here told an offline user they
    // were on the newest build.
    expect(screen.getByTestId("update-status")).toHaveTextContent(
      "Not checked yet",
    );
  });

  it("prints 'Up to date' only for a completed check (audit 2026-07-24, 1.13)", () => {
    const mock = renderPane(createMockHertaBridge({ appVersion: "0.1.0" }));
    act(() => {
      mock.emitUpdate({ phase: "up-to-date" });
    });
    expect(screen.getByTestId("update-status")).toHaveTextContent("Up to date");
  });

  it("a feed that cannot be reached says so and offers the netdisk; any other error prints its message (owner 2026-09-09)", async () => {
    const mock = renderPane(createMockHertaBridge({ appVersion: "0.1.0" }));
    await screen.findByText("v0.1.0");
    act(() =>
      mock.emitUpdate({
        phase: "error",
        message: "net::ERR_CONNECTION_CLOSED",
        network: true,
      }),
    );
    const status = screen.getByTestId("update-status");
    expect(status).toHaveTextContent("could not be reached");
    expect(status).not.toHaveTextContent("ERR_CONNECTION_CLOSED");
    screen.getByRole("button", { name: "Open Baidu Netdisk" }).click();
    expect(mock.calls.openExternal).toEqual([
      "https://pan.baidu.com/s/1k-47zy6TTDWl0OaT2WCFUg?pwd=y195",
    ]);
    act(() => mock.emitUpdate({ phase: "error", message: "HttpError: 404" }));
    expect(screen.getByTestId("update-status")).toHaveTextContent(
      "Check failed: HttpError: 404",
    );
    expect(
      screen.queryByRole("button", { name: "Open Baidu Netdisk" }),
    ).toBeNull();
  });

  it("streams state: downloading shows progress, ready swaps in restart-and-install", async () => {
    const mock = renderPane();
    await screen.findByText("v0.1.0");
    act(() =>
      mock.emitUpdate({ phase: "downloading", version: "0.2.0", progress: 37 }),
    );
    expect(screen.getByTestId("update-status")).toHaveTextContent(
      "Downloading 37%",
    );
    act(() => mock.emitUpdate({ phase: "ready", version: "0.2.0" }));
    expect(screen.getByTestId("update-status")).toHaveTextContent("v0.2.0");
    const restart = screen.getByRole("button", { name: "Restart & update" });
    restart.click();
    expect(mock.calls.restartAndInstall).toBe(1);
  });

  it("adopts a pre-mount ready snapshot (late subscriber)", async () => {
    renderPane(
      createMockHertaBridge({
        updateState: { phase: "ready", version: "0.3.0" },
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Restart & update" }),
    ).toBeInTheDocument();
  });

  it("hides the update surface on a bridge without it (website demo, fakes)", async () => {
    const mock = createMockHertaBridge();
    const stripped = Object.assign(Object.create(null), mock.bridge, {
      checkForUpdate: undefined,
      restartAndInstall: undefined,
      getUpdateState: undefined,
      onUpdate: undefined,
    });
    renderWithLocale(
      <HertaBridgeProvider bridge={stripped}>
        <UpdateSettings />
      </HertaBridgeProvider>,
    );
    expect(await screen.findByText("v0.1.0")).toBeInTheDocument();
    expect(screen.getByText("Updates unavailable here")).toBeInTheDocument();
    expect(screen.queryByTestId("update-status")).not.toBeInTheDocument();
    // Attribution shows even on a build with no update support (audit S12) —
    // it is a statement about what the project is, not update chatter.
    expect(screen.getByTestId("fan-notice")).toHaveTextContent(
      /Unofficial fan project, unaffiliated with and not endorsed by HoYoverse/,
    );
  });
});
