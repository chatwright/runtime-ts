/**
 * Transcript rendering: a chronological, human-readable dump of one chat's
 * journal, ported as an algorithm from `runtime-go`'s
 * `telegram.Emulator.Transcript`/`renderTranscript`
 * (`chatwright/runtime-go/telegram/emulator.go`) — never shared as code, per
 * decision
 * {@link https://github.com/chatwright/chatwright/blob/main/spec/decisions/0012-black-box-bot-protocol.md | 0012}.
 *
 * @remarks
 * This is the piece that makes {@link "./chat.js".Chat} and
 * {@link "./bot-message.js".BotMessageExpectation} failures self-contained:
 * every thrown `Error` embeds the transcript so far, mirroring Go's
 * "transcript-in-failure" convention (`cw.Chat`'s `ExpectBotMessage` /
 * `BotMessage.resolve` failures via `t.Fatalf(...emu.Transcript(chatID))`).
 *
 * An edit does not append a new line — it rewrites the message's existing
 * line in place, at its original position, so a message keeps its
 * conversational position in the rendered transcript even after being
 * edited (matching `renderTranscript`'s `posByID` bookkeeping in Go).
 */

import type { JournalEntry } from "../journal/journal.js";

/**
 * Renders `entries` (one chat's chronological journal) as prose, for
 * inclusion in an assertion failure. Independent of any consumption cursor —
 * this is the chat's own record, not what any expectation has consumed.
 */
export function renderTranscript(chatId: number, entries: readonly JournalEntry[]): string {
  const lines: string[] = [];
  const lineIndexByMessageId = new Map<number, number>();

  for (const entry of entries) {
    if (entry.kind === "message") {
      const existing = lineIndexByMessageId.get(entry.messageId);
      if (existing !== undefined) {
        lines[existing] = renderEntry(entry); // an edit: update this message's line in place, no new line
        continue;
      }
      lineIndexByMessageId.set(entry.messageId, lines.length);
    }
    lines.push(renderEntry(entry));
  }

  if (lines.length === 0) {
    return `chat ${chatId} transcript: (empty — no messages yet)`;
  }
  return `chat ${chatId} transcript: ${lines.join(" / ")}`;
}

function renderEntry(entry: JournalEntry): string {
  switch (entry.kind) {
    case "action":
      return `[user] clicked ${JSON.stringify(entry.text)} on message ${entry.refMessageId}`;
    case "uncaptured":
      return `bot also called ${entry.method} (uncaptured)`;
    default: {
      const who = entry.direction === "bot" ? "bot" : "user";
      // version is 0 for the original send; displayed 1-indexed once edited,
      // matching runtime-go's renderJournalEntry (en.Version+1 in "vN, edited").
      if (entry.version > 0) {
        return `[${entry.messageId} ${who}] ${entry.text} (v${entry.version + 1}, edited)`;
      }
      return `[${entry.messageId} ${who}] ${entry.text}`;
    }
  }
}
