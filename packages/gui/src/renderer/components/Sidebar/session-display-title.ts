import type { SessionMetadata } from "@herta/app-server";

/**
 * The title a sidebar row shows for a session: the generated title
 * (`SessionMetadata.title`, from the title sidecar) when there is one, else
 * the literal "Untitled" sentinel — which SessionGroup localizes (未命名 in
 * zh mode) and which a real generated title can never equal.
 *
 * Until 2026-09-03 this lived in `renderer/mocks/` and special-cased the
 * mock session "today-1" by deriving a title from the mock record — a mocks
 * import in production code for a session id only the tests use. The mock
 * list now carries that derived title as ordinary metadata (mocks/sessions.ts),
 * so the rule here is the production rule and nothing else.
 */
export function sessionDisplayTitle(session: SessionMetadata): string {
  return session.title !== undefined && session.title !== ""
    ? session.title
    : "Untitled";
}
