import type { MessageKey } from "../keys.js";

export const en = {
  "nav.voice": "Voice",
  "nav.dream": "Dream",
  "nav.deepseek": "DeepSeek",
  "nav.coprocessor": "Coprocessor",
  "nav.language": "Language",
  "nav.window": "Window",
  "nav.update": "Updates",
  "update.intro":
    "Station firmware, received and installed. New versions download in the background and install automatically on exit.",
  "update.betaLead": "Beta: ",
  "update.betaNotice":
    "still under test — releases may include breaking changes, and past sessions or settings may not fully survive an update.",
  "update.auto": "Automatic updates",
  "update.autoDesc": "When off, updates happen only on a manual check.",
  "update.currentVersion": "Current version",
  "update.checkNow": "Check for updates",
  "update.restartNow": "Restart & update",
  "update.checking": "Checking…",
  "update.available": "New version found:",
  "update.downloading": "Downloading",
  "update.ready": "Ready — installs on exit:",
  "update.error": "Check failed",
  "update.unreachable":
    "The update server (GitHub) could not be reached. Check the network or VPN; the latest build is also on Baidu Netdisk.",
  "update.netdisk": "Open Baidu Netdisk",
  "update.upToDate": "Up to date",
  "update.notChecked": "Not checked yet",
  "update.unsupported": "Updates unavailable here",
  "nav.group.general": "General",
  "nav.group.herta": "Herta",
  "nav.group.engine": "Engine",
  "window.intro": "How the window looks and behaves.",
  "window.theme": "Appearance",
  "window.themeDesc": "Light or dark; System follows the operating system.",
  "theme.light": "Light",
  "theme.dark": "Dark",
  "theme.system": "System",
  "window.closeToTray": "Close to tray",
  "window.closeToTrayDesc":
    "Closing the window keeps Herta running in the system tray; when this is off, closing quits.",
  // macOS (2026-09-23): the icon sits in the menu bar, and a Mac app does not
  // quit when its window closes — it stays in the Dock until ⌘Q.
  "window.closeToTrayMac": "Close to menu bar",
  "window.closeToTrayDescMac":
    "Closing the window keeps Herta running in the menu bar; when this is off, it only closes the window, and Herta stays in the Dock until you quit with ⌘Q.",
  // Attention (ADR 0072 §1): what notifies, and the keep-awake hold.
  "window.notifications": "Notifications",
  "window.notificationsDesc":
    "When the window is in the background, a notification appears if something needs you or a longer reply finishes.",
  "window.keepAwake": "Keep awake during runs",
  "window.keepAwakeDesc":
    "Keeps the computer from sleeping while Brick runs; the display may still turn off.",
  "window.minimize": "Minimize",
  "window.maximize": "Maximize",
  "window.restore": "Restore",
  "window.closeBtn": "Close",
  "settings.eyebrow": "Settings",
  "settings.closeAria": "Close settings",
  "settings.sectionsAria": "Settings sections",
  "settings.dialogAria": "Settings",
  "settings.loadFailed":
    "Could not load this setting — reopen Settings to retry",
  "language.rowLabel": "Display language",
  "language.intro":
    "The interface and the conversation each have their own language.",
  "language.interactionRowLabel": "Interaction language",
  "language.interactionDesc":
    "The language Herta speaks in. Applies to new sessions; English sessions have no voice yet.",
  "language.follow": "Follow UI language",
  "topbar.toggleSidebar": "Toggle sidebar",
  "topbar.search": "Search sessions",
  "topbar.newSession": "New session",
  "topbar.resolveApprovalFirst": "Resolve the pending approval first",
  "topbar.settings": "Settings",
  "session.untitled": "Untitled",
  "session.searchPlaceholder": "Search sessions",
  "session.filterAria": "Filter sessions by title",
  "session.noMatches": "No matching sessions",
  "session.searching": "Searching transcripts…",
  "session.searchUnavailable": "(content search unavailable — titles only)",
  "session.pendingApproval": "Pending approval",
  "session.confirmDelete": "Confirm delete",
  "session.deleteAria": "Delete session",
  "session.openFailed": "Archive damaged",
  "session.switchInterrupts":
    "This interrupts the current reply — click again to confirm",
  "session.menuAria": "Session actions",
  "session.rename": "Rename",
  "session.renameAria": "Session name",
  "session.renameFailed": "Rename failed",
  "session.export": "Export as Markdown…",
  "session.exported": "Exported",
  "session.exportFailed": "Export failed",
  "export.user": "Trailblazer",
  "export.herta": "Herta",
  "export.startedAt": "Started {time}",
  "export.exportedAt": "Exported {time}",
  "session.group.today": "Today",
  "session.group.yesterday": "Yesterday",
  "session.group.previous7Days": "Previous 7 Days",
  "session.group.older": "Older",
  "voice.realtime": "Real-time voice",
  "voice.realtimeDesc": "Open the terminal microphone.",
  "voice.realtimeMissing":
    "This install lacks the voice runtime — she can only type for now.",
  "voice.realtimeFailed":
    "The voice process failed repeatedly; it is off for this run. Restart Herta to retry.",
  "voice.model": "Voice model",
  "voice.modelAbsent": "About {size} MB; available once downloaded.",
  "voice.modelDev": "Using the model in the workspace's data/tts.",
  "voice.modelDownload": "Download",
  "voice.modelDownloading": "Downloaded {received} / {total} MB",
  "voice.modelCancel": "Cancel",
  "voice.modelReady": "Installed, about {size} MB on disk.",
  "voice.modelRemove": "Remove",
  "voice.modelRetry": "Retry",
  "voice.modelFailed.network":
    "GitHub could not be reached to download the model. Check the network or VPN and retry.",
  "voice.modelFailed.http": "The server did not return the model file.",
  "voice.modelFailed.size":
    "The downloaded file had the wrong size; discarded.",
  "voice.modelFailed.hash":
    "The downloaded file failed its checksum; discarded.",
  "voice.modelFailed.archive":
    "The model archive could not be unpacked; discarded.",
  "voice.modelFailed.verify": "The model files failed verification; discarded.",
  "voice.modelFailed.disk": "Writing to this machine failed; check disk space.",
  "voice.modelFailed.cancelled": "Cancelled.",
  "voice.engine": "Voice engine",
  "voice.engineDesc":
    "The downloaded local model, or the cloud model that sounds better.",
  "voice.engine.local": "Local model",
  "voice.engine.minimax": "MiniMax cloud",
  "voice.minimaxKey": "MiniMax API key",
  "voice.minimaxKeyDesc":
    "Pay-as-you-go. Generates the voice ID; also synthesizes speech when no plan key is set. Get one at platform.minimaxi.com.",
  "voice.minimaxKeyAria": "MiniMax API key",
  "voice.keyDelete": "Delete",
  "voice.minimaxHelpAria": "About the keys",
  "voice.minimaxHelp":
    "Cloud voice needs an API key for two jobs: generating the voice ID and synthesizing speech. The voice ID can only be generated with the MiniMax API key (pay-as-you-go, once). Speech prefers the Token Plan key (free within the plan) and uses the API key when none is set.",
  "voice.minimaxKeyRejected": "Key rejected",
  "voice.minimaxKeyQuota": "Out of balance",
  "voice.minimaxKeyUnchecked": "Unchecked",
  "voice.speechRefused.quota":
    "The account is out of balance; replies type unvoiced until it is topped up.",
  "voice.speechRefused.auth":
    "MiniMax refused the key; replies type unvoiced until it is fixed.",
  "voice.speechRefused.invalid_key":
    "MiniMax did not accept the key; replies type unvoiced until it is fixed.",
  "voice.minimaxPlanKey": "Token Plan key",
  "voice.minimaxPlanKeyDesc":
    "Optional. Synthesizes speech under a Token Plan subscription.",
  "voice.minimaxPlanKeyAria": "MiniMax Token Plan key",
  "voice.minimaxRejected":
    "MiniMax did not accept that key — check it and try again.",
  "voice.clonePreparing": "Preparing her voice…",
  "voice.cloneRetry": "Retry",
  "voice.cloneFailed.no_key": "Enter a MiniMax key first.",
  "voice.cloneFailed.no_clone_key":
    "Generating the voice ID needs the MiniMax API key (pay-as-you-go); enter it and retry.",
  "voice.cloneFailed.invalid_key": "MiniMax did not accept the key.",
  "voice.cloneFailed.auth":
    "MiniMax refused the request; check the key and the account.",
  "voice.cloneFailed.rate": "Too many requests; try again shortly.",
  "voice.cloneFailed.quota": "The account is out of balance.",
  "voice.cloneFailed.sensitive":
    "The reference recording failed the platform's content check.",
  "voice.cloneFailed.voice_missing": "The voice on the platform has expired.",
  "voice.cloneFailed.invalid":
    "The platform did not accept the request's parameters.",
  "voice.cloneFailed.network":
    "MiniMax could not be reached; check the network and retry.",
  "voice.cloneFailed.http": "MiniMax returned an unexpected response.",
  "voice.cloneFailed.cancelled": "Cancelled.",
  "voice.cloneFailed.other": "Cloning failed; try again later.",
  "voice.cloneFailed.reference": "This install lacks the reference recording.",
  "voice.mute": "Mute voice",
  "voice.muteDesc": "Silence all of Herta's voice.",
  "voice.volume": "Volume",
  "voice.volumeDesc": "Adjust the loudness of Herta's voice.",
  "dream.enable": "Enable Dream",
  "dream.enableDesc": "Dreaming uses your DeepSeek API quota.",
  "dream.intro":
    "Dream is Herta's downtime. While you are away, she looks back over your sessions and writes down the memorable moments — coming to know you a little better the longer you work together.",
  // Punctuation rule (owner 2026-08-27): a single-clause LABEL or status
  // carries no terminal period — only prose that explains or instructs keeps
  // one. So "Could not save — try again." keeps its period and "Restart to
  // apply" does not. (No contraction: UI copy is formal register.)
  "common.couldntSave": "Could not save — try again.",
  "common.restartToApply": "Restart to apply",
  // Not "stored encrypted" unconditionally (platform review 2026-09-23): on a
  // Linux desktop without a keyring the key is a plaintext, owner-only file,
  // and deepseek.unencrypted says so under this line.
  "deepseek.intro":
    "The API key is stored on this device, encrypted by the OS keychain when one is available. Get one at platform.deepseek.com.",
  "deepseek.checking": "Checking…",
  "deepseek.statusFailed": "Could not check the key status",
  "deepseek.connected": "Connected",
  "deepseek.noKey": "No key set",
  "deepseek.replaceKey": "Replace key…",
  "deepseek.keyAria": "DeepSeek API key",
  "deepseek.save": "Save",
  "deepseek.verifying": "Verifying…",
  "deepseek.deleteKey": "Delete key",
  "deepseek.deleting": "Deleting…",
  "deepseek.rejected": "DeepSeek rejected that key — check it and try again.",
  "deepseek.busy": "Finish the current turn first",
  "deepseek.unverified":
    "Saved, but could not reach DeepSeek to verify it — check your connection if Herta does not respond.",
  "deepseek.unencrypted":
    "Stored unencrypted — this device has no secure keychain available.",
  "deepseek.models.intro":
    "Model choice: Flash is faster and cheaper and can read images; Pro costs more. Changes apply after a restart.",
  "deepseek.model.actor": "Conversation model",
  "deepseek.model.actorDesc": "The model used when talking with Herta.",
  "deepseek.model.backend": "Coprocessor model",
  "deepseek.model.backendDesc": "The model Brick runs tasks with.",
  "deepseek.model.pro": "Pro",
  "deepseek.model.flash": "Flash",
  "keyprompt.title": "Connect Herta to DeepSeek",
  // "stored in your OS keychain", not "stored encrypted" (audit BL18):
  // key-store falls back to plaintext when safeStorage reports no encryption
  // available, and this card is shown BEFORE anything knows which it will be.
  // The honest per-state string (deepseek.unencrypted) exists and is used in
  // Settings once the key is saved.
  "keyprompt.body":
    "Herta needs a DeepSeek API key to think. It is stored on this device — in your OS keychain when one is available — and never leaves your machine except to call DeepSeek.",
  // Where to get one (audit BL19) — platform.deepseek.com appeared in exactly
  // one pane of the app and in neither the README nor the website, so a user
  // met with a key prompt on first launch had nowhere to go.
  "keyprompt.where": "Get a key at platform.deepseek.com",
  "keyprompt.notNow": "Not now",
  "keyprompt.saveSend": "Save & send",
  "keyprompt.saveFail": "Could not save the key — try again.",
  "device.state.idle": "Idle",
  "device.state.working": "Working",
  "device.state.reading": "Reading",
  "device.state.writing": "Writing",
  "device.state.runningCommand": "Running a command",
  "device.state.verifying": "Verifying",
  "device.state.awaitingApproval": "Awaiting approval",
  "device.state.done": "Done",
  "device.state.error": "Error",
  "banzhuan.legend.idle": "nothing delegated; it waits",
  "banzhuan.legend.delegated": "on the task you gave it",
  "banzhuan.legend.waitingApproval": "held on your approval",
  "banzhuan.legend.succeeded": "finished clean — a green light",
  "banzhuan.legend.failed": "it failed; the record says why",
  // The Coprocessor pane is written in Herta's own hand (owner 2026-09-29:
  // "the banzhuan section copy should be like The Herta's writing") — her
  // written register, not UI chrome: the intro, the row descriptions and the
  // legend. The formal-register rule for UI copy does not govern them.
  "banzhuan.intro":
    "The Differential Coprocessor. I call it the Brick: the grunt work of code is its job. Delegate with the full @板砖; without the @, it does not move. The ring on its face is its state:",
  "banzhuan.thinking": "Thinking effort",
  "banzhuan.thinkingDesc":
    "How long it thinks before acting: higher is more thorough, and slower and costlier. Applies on the next launch.",
  "banzhuan.thinking.low": "Low",
  "banzhuan.thinking.high": "High",
  "banzhuan.thinking.max": "Max",
  "banzhuan.contract": "Tool contract",
  "banzhuan.contractDesc":
    "Its tools. Standard: a full set of dedicated ones. Minimal: bash and an editor, at about half the cost; needs bash on this machine. Applies on the next launch.",
  "banzhuan.contract.noBash":
    "No bash on this machine: pick Minimal and it still runs Standard. Install Git for Windows, then restart.",
  "banzhuan.contract.standard": "Standard",
  "banzhuan.contract.minimal": "Minimal",
  "banzhuan.pdfPictures": "Transcribe PDF pictures",
  "banzhuan.pdfPicturesDesc":
    "When a PDF is attached, a model transcribes its pictures into text, at most 40 calls per document. When off, the pictures are still stored, and it can still look at them. Applies immediately.",
  "approval.title": "Permission request",
  "approval.allow": "Allow",
  "approval.alwaysAllow": "Allow for this task",
  "approval.allowProject": "Allow in project",
  "approval.projectRuleNote": "“Allow in project” remembers: {rule}",
  "approval.deny": "Deny",
  "approval.risk.read": "Read workspace",
  "approval.risk.write": "Write workspace",
  "approval.risk.destructive": "Destructive operation",
  "approval.risk.network": "Network access",
  "approval.reason.commandUnknown": "Unrecognized command — review carefully",
  "approval.reason.commandInterpreter":
    "Interpreter runs a script — review the script and arguments",
  "approval.reason.commandDestructive":
    "Destructive command — confirm before allowing",
  "approval.reason.commandNetwork": "This command makes a network call",
  "approval.reason.commandWrite": "This command writes files",
  "approval.reason.commandReaderPath":
    "Reads a sensitive or out-of-workspace path",
  "approval.reason.commandRecursiveRead":
    "Recursive read bypasses the credential guard",
  "approval.reason.commandVcs":
    "This git command changes the repository or working tree",
  "approval.reason.commandFs":
    "Filesystem operation (create / copy / move) — check the paths",
  "approval.reason.commandDelete":
    "This command deletes files — check the paths",
  "approval.reason.commandProcess":
    "This command ends processes — check the target",
  "approval.reason.commandCwdEscape":
    "This command leaves the workspace directory — later relative paths are unguarded",
  "approval.reason.commandUnresolved": "This command has unresolved parts",
  "approval.reason.commandSystem":
    "Changes system settings or drives other apps — asked every time",
  "approval.reason.commandHarnessState":
    "May reach .herta, the application's own state, in a way the line does not show — asked every time",
  "approval.reason.commandDownloadExec":
    "Downloads a package and runs it — asked every time",
  "approval.reason.commandOpaque":
    "What this runs cannot be read from the command (encoded, computed, or fed on input) — asked every time",
  "approval.reason.commandGitInternals":
    "Changes .git internals (hooks or config) that git later runs as commands — asked every time",
  "approval.reason.commandOutside":
    "Touches a path outside the workspace — check the path",
  "approval.reason.commandLocalExec":
    "Runs a program from the workspace — review it and its arguments",
  "approval.reason.commandInterpreterInline":
    "Interpreter runs inline code the record never showed — review it",
  "approval.reason.commandScript": "Runs a project script — review the script",
  "approval.reason.commandEnv":
    "Changes the environment or command paths later commands use — review it",
  "approval.alsoClasses": "Also: {list}",
  "approval.consequence.discardsUncommitted":
    "Note: discards uncommitted changes — they cannot be recovered.",
  "approval.consequence.deletesUntracked":
    "Note: deletes untracked files — they cannot be recovered.",
  "approval.consequence.deletesStash":
    "Note: deletes stashed work — it cannot be recovered.",
  "approval.consequence.rewritesLocalHistory":
    "Note: rewrites local commit history.",
  "approval.consequence.rewritesRemoteHistory":
    "Note: overwrites the remote branch's history.",
  "approval.consequence.concludesInProgressOperation":
    "Note: a merge/rebase is mid-flight — this step concludes it.",
  "app.fanNotice":
    "Herta is a character from Honkai: Star Rail, © HoYoverse. Unofficial fan project, unaffiliated with and not endorsed by HoYoverse.",
  "approval.diffShowAria":
    "Show the diff: {n} changed lines, {add} added, {del} removed",
  "approval.diffHideAria": "Hide the diff",
  "approval.reason.writeNewFile": "Creates a new file",
  "approval.reason.editFile": "Edits an existing file",
  "approval.reason.strReplaceEditor": "Writes a file",
  "approval.heredocFolded": "    ⋯ {n} lines folded — see the diff below ⋯",
  "approval.autoReviewEnable": "Turn on auto-review",
  "approval.autoReviewNote":
    "Once on, file writes in this workspace that undo can take back run directly, and a review model allows or denies everything else against what you asked; what it cannot judge still asks you. It can be turned off from the device card's menu.",
  "composer.placeholder": "Message Herta…",
  "composer.aria": "Message composer",
  "composer.send": "Send message",
  "composer.stop": "Interrupt the current turn",
  "composer.attach": "Add files",
  "composer.attach.formats":
    "Images .png .jpg, documents .pdf .docx, plus .md .txt .csv .json .py .ts and other text",
  // The composer-notice pill (owner 2026-08-27): terse, formal, and NO
  // trailing period — a pill is a label, not a sentence. Settings-row prose
  // keeps its periods; these do not.
  "composer.attach.busy":
    "The current turn is still in progress — files cannot be added",
  "composer.attach.tooMany": "Ten files at most",
  "composer.attach.failed": "Adding files failed",
  // While a document is read (2026-09-30): the read itself shows as the
  // file's row with a hairline (2026-10-01); these answer the user's acts.
  "composer.attach.stillReading": "Still reading the previous file",
  "composer.attach.waitToSend": "Sending waits until the file is read",
  "composer.attach.denied": "Credential-shaped — refused",
  // The staged strip (ADR 0048): pictures waiting to be sent WITH a message.
  "composer.staged": "Images to send",
  "composer.staged.remove": "Remove",
  // Enter with staged pictures and no words (owner 2026-08-27): pictures
  // ride a message; an empty user block is not a message.
  "composer.attach.needText": "Say something first",
  // The per-message picture cap (owner 2026-08-27): a message is a moment,
  // not an album.
  "composer.attach.imageLimit": "Five pictures at most",
  // A message while Brick works (ADR 0063): held above the composer, sent as
  // the next turn unless interjected or taken back. The composer keeps its
  // ordinary placeholder meanwhile (owner 2026-09-15): the card says it.
  "composer.hold.label": "Sent after Brick finishes",
  "composer.hold.aria": "Message queued to send",
  "composer.hold.steer": "Interject now",
  "composer.hold.edit": "Edit",
  "composer.hold.discard": "Withdraw",
  // 继续 (ADR 0071 §1.4): Brick's last run was interrupted — the app exited
  // under it, or the user pressed Stop — and can be continued where it stood.
  // @ mentions (ADR 0072 §2): @brick first while the query can still become
  // it, then the matching workspace files.
  "composer.mentions.aria": "Mentions",
  "composer.mentions.brick": "Delegate to the coprocessor",
  "composer.mentions.files": "Workspace files",
  "composer.resume.text": "Brick's last run was interrupted.",
  "composer.resume.action": "Continue",
  "composer.resume.aria": "Continue the interrupted run",
  // Click-to-enlarge lightbox (ADR 0048 §4a). `lightbox.open` prefixes the
  // thumb button's aria-label, followed by the filename.
  "lightbox.open": "View picture",
  "lightbox.close": "Close",
  "lightbox.zoomIn": "Zoom in",
  "lightbox.zoomOut": "Zoom out",
  // The pill's tooltip: a bare wheel scrolls, so the zoom gesture is said
  // here (owner 2026-08-28).
  "lightbox.zoomHint": "Ctrl + wheel to zoom, drag to pan",
  // macOS: ⌘, and the trackpad pinch a Mac user reaches for (2026-09-23).
  "lightbox.zoomHintMac": "Pinch or ⌘ + wheel to zoom, drag to pan",
  "connect.button": "Connect to Herta",
  "connect.failed": "Session start failed — try again",
  "workspace.rewind": "Rewind to here",
  // Copy a reply (ADR 0072 §3): her prose, without the code.
  "workspace.copyReply": "Copy reply",
  "workspace.copied": "Copied",
  "workspace.copyFailed": "Copy failed",
  "workspace.editsNotReverted": "Edited files were not reverted",
  "workspace.rewindFailed": "Rewind failed",
  "workspace.undoEdits": "Undo changes",
  "workspace.editsUndone": "Changes undone",
  "workspace.editsUndoneLeftAlone": "Changes undone; not restored: {files}",
  "workspace.undoFailed": "Undo failed",
  "workspace.listJoin": ", ",
  "activity.undo.chip": "Undo",
  "activity.undo.chipTitle": "Undo Brick's file changes from this turn",
  "activity.undo.chipDone": "Undone",
  "activity.undo.summary": "Changes from this turn undone",
  "activity.undo.count.restored": "{n} restored",
  "activity.undo.count.deleted": "{n} deleted",
  "activity.undo.count.left": "{n} not restored",
  "activity.undo.result.restored": "restored",
  "activity.undo.result.deleted": "deleted (created this turn)",
  "activity.undo.result.unchanged": "no restore needed",
  "activity.undo.result.changed_since": "modified since; not restored",
  "activity.undo.result.not_kept": "no backup kept; not restored",
  "activity.undo.result.outside_workspace":
    "outside the workspace; not restored",
  "activity.undo.result.failed": "write failed; not restored",
  "activity.undo.commands": "modified by a command; not restored",
  "activity.undo.commandsUnknown":
    "Commands ran this turn; any changes they made were not restored",
  "workspace.processing": "Working…",
  "workspace.took": "Took",
  "workspace.recapping": "Tidying conversation history…",
  "workspace.turnFailed":
    "Connection lost — this reply was not delivered. Please send again.",
  "workspace.turnFailed401":
    "Invalid or expired DeepSeek API key — replace it in Settings.",
  "workspace.turnFailed402":
    "Insufficient DeepSeek balance — top up and send again.",
  "workspace.turnFailed429":
    "Rate-limited by DeepSeek — wait a moment and send again.",
  "workspace.turnFailed500": "DeepSeek server error — please try again later.",
  "workspace.turnFailed503":
    "DeepSeek servers are busy — please try again later.",
  "workspace.turnFailedTls":
    "The secure connection to DeepSeek was refused — usually a company proxy or VPN. Resending will not help; check your network settings.",
  "workspace.sending": "Message is crossing the galaxy…",
  "workspace.gammaStorm": "Message caught in a gamma storm…",
  "workspace.gammaStormLong":
    "The storm has not passed — message still en route…",
  "workspace.jumpToLatest": "Back to bottom",
  "workspace.loadEarlier": "Load {n} earlier entries",
  "workspace.topicRailAria": "Topic guide",
  "activity.verb.reading": "Reading",
  "activity.verb.writing": "Writing",
  "activity.verb.running": "Running",
  "activity.verb.inspecting": "Inspecting",
  "activity.verb.searching": "Searching",
  "activity.verb.stopping": "Stopping",
  "activity.verb.digesting": "Digesting",
  "activity.result.digest": "digest",
  "activity.result.chunks": "chunks",
  "activity.result.cached": "cached",
  "activity.verb.savingMemory": "Saving memory",
  "activity.result.tests": "tests",
  "activity.result.failed": "failed",
  "activity.result.exit": "exit",
  "activity.result.lines": "lines",
  "activity.result.matches": "matches",
  "activity.result.files": "files",
  "activity.result.truncated": "truncated",
  "activity.result.finding": "finding",
  "activity.step.patchPreview": "patch preview",
  "activity.bg.label": "background",
  "activity.bg.running": "running",
  "activity.bg.stopped": "stopped",
  "activity.bg.exited": "exited",
  "activity.bg.signal": "signal",
  "activity.attachment.label": "attachment",
  "activity.attachment.chars": "chars",
  "activity.attachment.unreadable.binary": "not a text file",
  "activity.attachment.unreadable.tooLarge": "too large, no body taken",
  "activity.attachment.unreadable.empty": "no text extracted",
  "activity.attachment.unreadable.readError": "could not be read",
  "activity.attachment.unreadable.denied": "credential-shaped — refused",
  "activity.attachment.unreadable.removed": "removed",
  "activity.attachment.unreadable.encrypted":
    "password-protected, no body taken",
  "activity.attachment.unreadable.unsupported": "unsupported document format",
  "activity.attachment.unreadable.scanned":
    "no text extracted — probably a scan",
  "activity.attachment.unreadable.tooManyPages":
    "too many pages, not extracted",
  "activity.attachment.unreadable.textTooLong": "text too long, no head taken",
  "activity.attachment.format.pdf": "PDF",
  "activity.attachment.format.docx": "Word document",
  // Images (ADR 0048). `{f}` is the format token (PNG/JPEG) — data, not
  // chrome, so it is substituted rather than translated.
  "activity.attachment.image": "image {f}",
  "activity.attachment.unreadable.imageTooLarge": "too large to read",
  "activity.attachment.unreadable.noCaption": "stored, not read",
  "activity.attachment.pages": "pages",
  "activity.attachment.extracted": "text extracted",
  "activity.attachment.outline": "outline · {n} entries",
  // The pending row of an attach in flight (2026-10-01).
  "activity.attachment.progress.waiting": "waiting",
  "activity.attachment.progress.reading": "reading",
  "activity.attachment.progress.page": "page {done} of {total}",
  "activity.attachment.progress.pictures":
    "transcribing pictures {done} of {total}",
  "activity.attachment.remove": "Remove this attachment",
  "activity.attachment.removeFailed": "Removing the attachment failed",
  "activity.attachment.removeInUse":
    "The attachment is open in another program. Close it, then remove it again",
  "activity.file.openAria": "View file",
  "activity.commit.openAria": "View commit",
  "activity.diff.openAria": "View changes",
  "viewer.close": "Close",
  "viewer.closeTab": "Close file",
  "viewer.copyPath": "Copy path",
  "viewer.copySha": "Copy commit id",
  "viewer.copied": "Copied",
  "viewer.copyFailed": "Copy failed",
  "viewer.openExternal": "Open in default app",
  "viewer.notFound": "File no longer exists or was moved",
  "viewer.binary": "Binary file — open with the default app",
  "viewer.outside": "This path is outside the workspace",
  "viewer.unreadable": "Could not read this file",
  "viewer.truncatedNote":
    "Long file — showing the head; open externally for the rest",
  "viewer.tooLarge": "Too large to view here — open with the default app",
  "viewer.renderFailed":
    "Could not render this file — open with the default app",
  "viewer.showSource": "View source",
  "viewer.showRendered": "View rendered",
  "viewer.rendering": "Rendering…",
  "viewer.diagramFailed": "The diagram did not render — its source is below",
  "viewer.imageFit": "Fit to panel",
  "viewer.imageActual": "Actual size",
  "viewer.pdfPages": "{n} pages",
  "viewer.rowsCapped": "Showing the first {n} rows",
  "viewer.colsCapped": "Showing the first {n} columns",
  "viewer.emptySheet": "Empty sheet",
  "viewer.chart": "Chart",
  "viewer.object": "Embedded object",
  "viewer.slidesCapped": "Showing the first {n} slides",
  "viewer.prevSlide": "Previous slide",
  "viewer.nextSlide": "Next slide",
  "viewer.slideAria": "Slide {n}",
  "viewer.commit.notFound": "This commit could not be read",
  "viewer.timeout":
    "Timed out reading — the repository is large or git is busy; try again",
  "viewer.commit.files": "{n} files",
  "viewer.commit.merge": "merge commit",
  "viewer.commit.binary": "binary",
  "viewer.commit.truncated": "Long patch — showing the head",
  "viewer.commit.moreFiles": "{n} more files not listed",
  "viewer.diff.against": "Changes against HEAD",
  "viewer.diff.none": "No changes against HEAD",
  "viewer.diff.truncated": "Long diff — showing the head",
  "viewer.diff.notFound": "Could not read the changes for this path",
  "viewer.log.tab": "History",
  "viewer.log.more": "Load more",
  "viewer.log.end": "Beginning of history",
  "viewer.log.notFound": "Could not read the history",
  "viewer.log.branch": "Branch",
  "viewer.log.search": "Search commit messages",
  "viewer.log.noMatch": "No matching commits",
  "trace.card.title": "Operation trace",
  "trace.card.steps": "{n} steps",
  "trace.card.files": "{n} files",
  "trace.phase.explore": "Explore",
  "trace.phase.modify": "Edit",
  "trace.phase.verify": "Verify",
  "trace.sum.readOne": "Read {name}",
  "trace.sum.readMany": "Read {n} files, {name} first",
  "trace.sum.searchOne": "Searched once",
  "trace.sum.searchMany": "Searched {n} times",
  "trace.sum.inspect": "Checked the repository",
  "trace.sum.writeOne": "Edited {name}",
  "trace.sum.writeMany": "Edited {n} files, {name} first",
  "trace.sum.runOne": "Ran {cmd}",
  "trace.sum.runMany": "Ran {n} commands",
  "trace.sum.digestOne": "Digested a document",
  "trace.sum.digestMany": "Digested {n} documents",
  "trace.sum.memoryOne": "Saved a memory",
  "trace.sum.memoryMany": "Saved {n} memories",
  "trace.sum.stopOne": "Stopped a background command",
  "trace.sum.stopMany": "Stopped {n} background commands",
  "trace.sum.sep": " · ",
  "trace.sum.failed": "{n} failed",
  "trace.live.lineOne": "1 line",
  "trace.live.lines": "{n} lines",
  "trace.live.noOutput": "No output yet",
  "repo.card.title": "Repository",
  "repo.card.clean": "Working tree clean",
  "repo.card.dirty": "{n} changes",
  "repo.card.detached": "Detached HEAD",
  "repo.card.unborn": "No commits yet",
  "repo.card.upstream": "Upstream {name}",
  "repo.card.upstreamGone": "Upstream {name} is gone",
  "repo.card.gone": "gone",
  "repo.card.ahead": "{n} ahead",
  "repo.card.behind": "{n} behind",
  "repo.card.conflicts": "{n} conflicts",
  "repo.card.more": "{n} more",
  "repo.card.scope": "Workspace at {prefix}",
  "repo.card.recent": "Recent commits",
  "repo.card.all": "All",
  "repo.card.unpushed": "Not pushed",
  "repo.card.inProgress.merge": "Merge in progress",
  "repo.card.inProgress.rebase": "Rebase in progress",
  "repo.card.inProgress.cherryPick": "Cherry-pick in progress",
  "repo.card.inProgress.revert": "Revert in progress",
  "repo.card.inProgress.bisect": "Bisect in progress",
  "repo.card.status.modified": "Modified",
  "repo.card.status.added": "Added",
  "repo.card.status.deleted": "Deleted",
  "repo.card.status.renamed": "Renamed",
  "repo.card.status.untracked": "Untracked",
  "repo.card.status.conflict": "Conflict",
  "repo.card.status.other": "Changed",
  "activity.result.detail": "result detail",
  "evidence.output": "output",
  "evidence.excerpt": "excerpt",
  "evidence.attachment": "attachment",
  "evidence.attachment.clipped": "(head only — the file continues)",
  "evidence.outline": "outline · {n} entries",
  "evidence.outline.shown": "(first {n})",
  "evidence.matches": "matches",
  "evidence.matches.omitted": "({n} more not listed)",
  "evidence.digest":
    "digest of {source} (model-generated, {n} chunks — per-chunk entries in {path})",
  "evidence.findings": "findings",
  "evidence.hint": "hint",
  "evidence.files": "changed files",
  "evidence.risks": "risks",
  "evidence.todos": "to do",
  "evidence.evidence": "findings",
  "evidence.error": "error",
  // The crash marker's open steps (ADR 0071 §1.2), each with the outcome the
  // harness decided for it when the session next opened.
  "evidence.cutoff": "when the app exited",
  "evidence.cutoff.notStarted": "not started",
  "evidence.cutoff.readInterrupted": "read cut off",
  "evidence.cutoff.writeApplied": "written",
  "evidence.cutoff.writeNotApplied": "not written",
  "evidence.cutoff.writeChangedSince": "changed since",
  "evidence.cutoff.stateNotApplied": "not applied",
  "evidence.cutoff.outcomeUnknown": "outcome unknown",
  "activity.detail.show": "show detail",
  "activity.detail.hide": "hide detail",
  "workspace.codeChip": "code",
  "workspace.diffExpand": "Expand diff · {n} lines (+{add} −{del})",
  "workspace.diffCollapse": "Collapse",
  "device.aria": "Agent device",
  // The drag affordance's own label. Terse (owner 2026-08-27) — its context
  // comes from the enclosing card, labelled "Coprocessor: {state}", and from
  // the device image's own alt text above.
  "device.dragHint": "Drag upward",
  "device.ariaLabel": "Coprocessor: {state}",
  "record.chip.coprocessor": "Coprocessor",
  "record.chip.system": "System",
  "record.marker.completed": "Done",
  "record.marker.blocked": "Blocked",
  "record.marker.failed": "Failed",
  "record.marker.interrupted": "Stopped",
  "record.marker.partial": "Partial",
  "record.marker.file": "{n} file",
  "record.marker.files": "{n} files",
  "record.marker.tests": "tests {passed}/{total}",
  "record.marker.testsFailed": "tests {passed} passed, {failed} failed",
  "record.marker.risk": "{n} risk",
  "record.marker.risks": "{n} risks",
  "record.marker.aborted": "run aborted",
  "record.marker.crashed": "the app exited unexpectedly",
  "record.marker.stepLimit": "step limit reached",
  "record.marker.commit": "committed {sha}",
  "record.marker.pushed": "pushed {ref}",
  "record.marker.noop": "No output",
  "card.workspace": "Workspace",
  "card.workspaceDefault": "Workspace · default",
  "card.setWorkspace": "Set workspace…",
  "card.resetDefault": "Reset to default",
  "card.workspaceSetError": "could not set workspace",
  "card.openFolder": "Open the workspace folder",
  "card.openFolderError": "could not open the workspace folder",
  "card.copyPath": "Copy path",
  "card.pathCopied": "Copied",
  "card.copyFailed": "Copy failed",
  "card.rules": "Remembered commands",
  "card.rulesEmpty": "No commands remembered",
  "card.rulesRemove": "Remove rule {rule}",
  "card.autoReview": "Auto-review",
  "card.autoReviewOn": "On",
  "card.autoReviewOff": "Off",
  "card.autoReviewEnable": "Turn on auto-review",
  "card.autoReviewDisable": "Turn off auto-review",
  "card.deviceInfoAria": "device card info",
  "card.deviceInfo":
    "The device card represents Brick (the differential coprocessor) — " +
    "Herta's coding execution backend. The ring color and breathing " +
    "rate reflect the backend's current state (idle, reading, writing, " +
    "running, waiting for approval, etc.).",
  "time.justNow": "just now",
  "time.minAgo": "{n} min ago",
  "app.cantStart": "Herta could not start",
  "app.cantStartBody":
    "Restart the app. If this keeps happening, check the logs. (Your DeepSeek key is set in Settings → DeepSeek — a missing key no longer blocks startup.)",
  "app.bridgeUnavailable":
    "The desktop bridge ({bridge}) is unavailable — the preload script failed to load.",
  "app.bridgeUnavailableBody":
    "Restart the app. If this persists, the preload build output or its path in the main process is misconfigured.",
  "app.crashTitle": "Interface error",
  "app.crashBody":
    "Your session record is safe — reload the interface to continue.",
  "app.crashReload": "Reload",
  "conversation.rowError": "This entry failed to render and was skipped.",
} satisfies Record<MessageKey, string>;
