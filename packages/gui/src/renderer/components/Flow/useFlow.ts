import { useCallback, useEffect, useState } from "react";
import type { FlowIssueView, FlowStateView } from "../../../shared/flow.js";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";

const IDLE: FlowStateView = {
  enabled: false,
  gathering: null,
  failed: null,
  unreadIssueId: null,
  refreshesLeft: 3,
};

/** Flow's state and issues (ADR 0084), read once and kept current by main's
 *  events. `available` is false where the bridge has no Flow (fakes, the
 *  website demo): the button and the panel never mount there. */
export function useFlow(): {
  readonly available: boolean;
  readonly state: FlowStateView;
  readonly issues: readonly FlowIssueView[];
  readonly refresh: () => void;
  readonly markRead: (issueId: string) => void;
} {
  const { bridge } = useHertaBridge();
  const available = bridge.flowState !== undefined;
  const [state, setState] = useState<FlowStateView>(IDLE);
  const [issues, setIssues] = useState<readonly FlowIssueView[]>([]);

  useEffect(() => {
    if (!available) return;
    let alive = true;
    void bridge
      .flowState?.()
      .then((s) => alive && setState(s))
      .catch(() => undefined);
    void bridge
      .flowIssues?.()
      .then((list) => alive && setIssues(list))
      .catch(() => undefined);
    const off = bridge.onFlow?.((e) => {
      if (e.kind === "state") setState(e.state);
      else
        setIssues((list) => [
          e.issue,
          ...list.filter((i) => i.id !== e.issue.id),
        ]);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [bridge, available]);

  const refresh = useCallback(() => {
    void bridge.flowRefresh?.().catch(() => undefined);
  }, [bridge]);
  const markRead = useCallback(
    (issueId: string) => {
      bridge.flowMarkRead?.(issueId);
      setState((s) =>
        s.unreadIssueId === issueId ? { ...s, unreadIssueId: null } : s,
      );
    },
    [bridge],
  );
  return { available, state, issues, refresh, markRead };
}
