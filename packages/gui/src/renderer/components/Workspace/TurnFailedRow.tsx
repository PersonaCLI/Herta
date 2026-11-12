import type { MessageKey } from "../../i18n/keys.js";
import { useT } from "../../i18n/LocaleProvider.js";

/**
 * Map a failed turn's HTTP status to its user-facing message, per the
 * official DeepSeek error codes (api-docs.deepseek.com/quick_start/
 * error_codes, user 2026-07-12): 401 wrong/expired key, 402 insufficient
 * balance, 429 rate limit, 500 server error, 503 overloaded. Before this,
 * EVERY failure — including 402, whose actual fix is topping up — read as
 * the generic connection-lost message. 400/422 (malformed request /
 * invalid params) stay generic: they are our bugs, and the retry hint is
 * as good a suggestion as any. Exported for unit tests.
 */
export function turnFailedMessageKey(
  status: number | null,
  providerCode: string | null = null,
): MessageKey {
  // Checked before `status` because a certificate/proxy failure never has one,
  // and because it is the single case where "please resend" is actively wrong
  // advice — the same request over the same untrusted proxy fails identically
  // every time. The user has to change a machine setting (audit S3).
  if (providerCode === "network-tls") return "workspace.turnFailedTls";
  // Never sent: the message with its conversation is more than the model's
  // window holds, and resending the same one changes nothing (review
  // 2026-11-10, second pass).
  if (providerCode === "prompt-too-large") {
    return "workspace.turnFailedTooLarge";
  }
  switch (status) {
    case 401:
      return "workspace.turnFailed401";
    case 402:
      return "workspace.turnFailed402";
    case 429:
      return "workspace.turnFailed429";
    case 500:
      return "workspace.turnFailed500";
    case 503:
      return "workspace.turnFailed503";
    default:
      return "workspace.turnFailed";
  }
}

export interface TurnFailedRowProps {
  /** The failure's HTTP status when the provider reported one; null for
   *  network/unknown failures (the generic message). */
  readonly status: number | null;
  /** The provider's own error code, for failures that carry no HTTP status. */
  readonly providerCode?: string | null;
}

// Inline notice for a turn that FAILED for a non-interrupt reason (provider /
// network error) without committing a reply (slice 4). Before this, the
// half-typed sentence simply vanished, leaving the user wondering what
// happened. Same status-row shell as RecapCompactRow, but static (no
// shimmer — nothing is in progress) and muted. Cleared by the store when
// the next turn starts.
export function TurnFailedRow(props: TurnFailedRowProps): JSX.Element {
  return (
    <div className="status-row is-shown" data-testid="turn-failed-row">
      <div className="status-core">
        <span className="transfer-text">
          {useT()(
            turnFailedMessageKey(props.status, props.providerCode ?? null),
          )}
        </span>
      </div>
    </div>
  );
}
