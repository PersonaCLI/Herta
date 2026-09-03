import type { SessionMetadata } from "@herta/app-server";
import type { MessageKey } from "../../i18n/keys.js";
import { useT } from "../../i18n/LocaleProvider.js";
import type { SessionGroupLabel } from "./group-sessions.js";
import { SessionItem } from "./SessionItem.js";
import type { SearchHitView } from "./Sidebar.js";
import { sessionDisplayTitle } from "./session-display-title.js";

export interface SessionGroupProps {
  readonly label: SessionGroupLabel;
  readonly sessions: readonly SessionMetadata[];
  /** Search-time content hits. A card whose session matched by CONTENT shows
   *  its snippet as the preview line, and clicking it lands on the matched
   *  turn rather than the latest one (2026-07-27). */
  readonly snippets?: ReadonlyMap<string, SearchHitView>;
}

const GROUP_KEY: Record<SessionGroupLabel, MessageKey> = {
  Today: "session.group.today",
  Yesterday: "session.group.yesterday",
  "Previous 7 Days": "session.group.previous7Days",
  Older: "session.group.older",
};

export function SessionGroup(props: SessionGroupProps): JSX.Element {
  const t = useT();
  return (
    <div className="session-group">
      <div
        className="session-group-label"
        data-flip-key={`label:${props.label}`}
      >
        {t(GROUP_KEY[props.label])}
      </div>
      {props.sessions.map((s) => {
        // sessionDisplayTitle returns the real generated title or the literal
        // "Untitled" sentinel for a titleless session. Localize ONLY that
        // sentinel — a real generated title is never "Untitled" — so an
        // untitled session reads 未命名 in zh mode.
        const display = sessionDisplayTitle(s);
        const hit = props.snippets?.get(s.sessionId);
        return (
          <SessionItem
            key={s.sessionId}
            session={s}
            title={display === "Untitled" ? t("session.untitled") : display}
            {...(hit !== undefined
              ? { searchSnippet: hit.snippet, searchJumpIndex: hit.blockIndex }
              : {})}
          />
        );
      })}
    </div>
  );
}
