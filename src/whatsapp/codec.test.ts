import { describe, expect, it } from "vitest";

import { InMemoryJournal } from "../journal/in-memory-journal.js";
import type { PlatformCodec } from "../platform/codec.js";
import { WhatsAppCodec, type WhatsAppCallContext } from "./codec.js";

function fixedClock(iso: string) {
  const date = new Date(iso);
  return () => date;
}

function contextFor(journal: InMemoryJournal): WhatsAppCallContext {
  return { journalFor: () => journal };
}

describe("WhatsAppCodec.buildTextUpdate", () => {
  it("journals an inbound message and builds a WhatsApp messages webhook update", () => {
    const codec = new WhatsAppCodec(fixedClock("2026-07-23T10:00:00.000Z"));
    const journal = new InMemoryJournal();

    const update = codec.buildTextUpdate(42, { id: 7, firstName: "Explorer" }, "1", journal);

    const message = update.entry[0]?.changes[0]?.value.messages?.[0];
    expect(message?.type).toBe("text");
    expect(message?.text.body).toBe("1");
    expect(message?.from).toBe("42");
    expect(message?.id).toBe("wamid.1");
    expect(update.entry[0]?.changes[0]?.value.contacts?.[0]).toEqual({
      profile: { name: "Explorer" },
      wa_id: "42",
    });
    expect(update.object).toBe("whatsapp_business_account");

    expect(journal.entries()).toEqual([
      {
        direction: "user",
        kind: "message",
        messageId: 1,
        refMessageId: 0,
        version: 0,
        text: "1",
        method: "",
        at: "2026-07-23T10:00:00.000Z",
        fromId: 0,
      },
    ]);
  });

  it("reserves message ids from a per-chat sequence shared with outbound sends", () => {
    const codec = new WhatsAppCodec();
    const journal = new InMemoryJournal();

    const first = codec.buildTextUpdate(42, { id: 7, firstName: "Explorer" }, "hi", journal);
    const second = codec.buildTextUpdate(42, { id: 7, firstName: "Explorer" }, "again", journal);
    const otherChat = codec.buildTextUpdate(99, { id: 8, firstName: "Other" }, "hi", journal);

    expect(first.entry[0]?.changes[0]?.value.messages?.[0]?.id).toBe("wamid.1");
    expect(second.entry[0]?.changes[0]?.value.messages?.[0]?.id).toBe("wamid.2");
    expect(otherChat.entry[0]?.changes[0]?.value.messages?.[0]?.id).toBe("wamid.1"); // separate per-chat sequence
  });
});

describe("WhatsAppCodec.handleCall: sendMessage (text)", () => {
  it("journals a bot text message and returns the Cloud API success envelope", () => {
    const codec = new WhatsAppCodec(fixedClock("2026-07-23T10:00:01.000Z"));
    const journal = new InMemoryJournal();

    const result = codec.handleCall(
      "sendMessage",
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: "42",
        type: "text",
        text: { body: "Choose your language: 1) English 2) Español 3) Français" },
      },
      contextFor(journal),
    );

    expect(result).toEqual({
      messaging_product: "whatsapp",
      contacts: [{ wa_id: "42" }],
      messages: [{ id: "wamid.reply" }],
    });

    expect(journal.entries()).toEqual([
      {
        direction: "bot",
        kind: "message",
        messageId: 1,
        refMessageId: 0,
        version: 0,
        text: "Choose your language: 1) English 2) Español 3) Français",
        method: "sendMessage",
        at: "2026-07-23T10:00:01.000Z",
        fromId: 0,
      },
    ]);
  });
});

describe("WhatsAppCodec.handleCall: unsupported calls", () => {
  it("returns the WhatsApp Cloud API error envelope and journals an uncaptured entry for a non-text type", () => {
    const codec = new WhatsAppCodec(fixedClock("2026-07-23T10:00:02.000Z"));
    const journal = new InMemoryJournal();

    const result = codec.handleCall(
      "sendMessage",
      { messaging_product: "whatsapp", to: "42", type: "image", image: { link: "https://example.com/cat.png" } },
      contextFor(journal),
    );

    expect(result).toEqual({
      error: {
        message: "chatwright: method not emulated: sendMessage:image",
        type: "ChatwrightNotEmulated",
        code: 501,
        error_subcode: 0,
        fbtrace_id: "chatwright",
      },
    });

    expect(journal.entries()).toEqual([
      {
        direction: "bot",
        kind: "uncaptured",
        messageId: 0,
        refMessageId: 0,
        version: 0,
        text: "",
        method: "sendMessage:image",
        at: "2026-07-23T10:00:02.000Z",
        fromId: 0,
      },
    ]);
  });

  it("returns the WhatsApp Cloud API error envelope for a method other than sendMessage", () => {
    const codec = new WhatsAppCodec();
    const journal = new InMemoryJournal();

    const result = codec.handleCall("markMessageAsRead", { to: "42" }, contextFor(journal));

    expect(result).toEqual({
      error: {
        message: "chatwright: method not emulated: markMessageAsRead",
        type: "ChatwrightNotEmulated",
        code: 501,
        error_subcode: 0,
        fbtrace_id: "chatwright",
      },
    });
    expect(journal.entries()).toMatchObject([{ kind: "uncaptured", method: "markMessageAsRead" }]);
  });

  it("has no buildCallbackUpdate — this codec declares no interactive-action support", () => {
    const codec: PlatformCodec = new WhatsAppCodec();
    expect(codec.buildCallbackUpdate).toBeUndefined();
  });
});

describe("WhatsAppCodec: platform and capabilities", () => {
  it("declares platform \"whatsapp\" and exactly the messaging.text capability", () => {
    const codec = new WhatsAppCodec();
    expect(codec.platform).toBe("whatsapp");
    expect(codec.capabilities).toEqual(["messaging.text"]);
  });
});
