/**
 * `Session` — the orchestrator that ties this package's three seams
 * together for one running conversation: it hands a registered bot's
 * transport ({@link "../protocol/iframe-host.js".IframeHost} or any other
 * {@link "../transport/transport.js".BotTransport}) to the Telegram codec,
 * appends every event the codec produces to the right chat's journal, and
 * assembles the whole recording into a
 * {@link https://github.com/chatwright/chatwright/blob/main/formats/run-bundle/v1/schema.json | run-bundle v1}
 * document.
 *
 * @remarks
 * This is a deliberately small slice of the orchestration research item I-66
 * describes, not a claim to have designed the whole thing: one `Session`
 * drives one registered bot on one platform (Telegram) across as many chats
 * as callers address by `chatId`, and `toBundle()` always emits exactly one
 * run with one deterministic part spanning the whole journal. Multi-bot
 * registries, scenario execution, AI-goal parts and replay are out of scope
 * here — see `docs/architecture.md`.
 */

import type { BotCall, BotTransport } from "../transport/transport.js";
import type { Journal, JournalAction, JournalEntry } from "../journal/journal.js";
import { InMemoryJournal, systemClock, type Clock } from "../journal/in-memory-journal.js";
import { TELEGRAM_BOT_FIRST_NAME, TELEGRAM_BOT_USER_ID, TelegramCodec, type TelegramUser } from "../telegram/codec.js";

/** The run-bundle v1 format identifier every bundle this package produces declares. */
export const RUN_BUNDLE_FORMAT = "https://chatwright.dev/formats/run-bundle/v1";

/**
 * This package's version, echoed into a bundle's `metadata.chatwrightVersion`.
 * Kept as a literal (rather than reading `package.json` at runtime) to avoid
 * a build-time dependency on JSON module resolution; bump alongside
 * `package.json`'s `version`.
 */
const RUNTIME_VERSION = "0.0.1";

/** One roster entry for a run-bundle actor — id and type are required; name is optional. */
export interface SessionActor {
  readonly id: string;
  readonly type: string;
  readonly name?: string;
}

export interface SessionOptions {
  /** Produces "now"; defaults to the real wall clock. Inject for deterministic tests. */
  readonly clock?: Clock;
  /** The run id `toBundle()` assigns. Defaults to `"run-1"`. */
  readonly runId?: string;
  /** The human-side actor roster entry. Defaults to `{id:"human", type:"scripted", name:"Human"}`. */
  readonly human?: SessionActor;
  /** The bot-side actor roster entry. Defaults to `{id:"bot", type:"bot", name:"Bot"}`. */
  readonly bot?: SessionActor;
  /** The single deterministic part's id. Defaults to `"session"`. */
  readonly partId?: string;
  /** The single deterministic part's title. Defaults to `"Session transcript"`. */
  readonly partTitle?: string;
}

const DEFAULT_HUMAN: SessionActor = { id: "human", type: "scripted", name: "Human" };
const DEFAULT_BOT: SessionActor = { id: "bot", type: "bot", name: "Bot" };

/** A platform identity as it appears in a bundle's `actors[*].platformIdentities`. */
interface WirePlatformIdentity {
  readonly userId: number;
  readonly firstName?: string;
  readonly username?: string;
}

/**
 * Orchestrates one Telegram conversation: registers a bot transport, turns
 * `submitText`/`submitClick` calls into updates delivered to it, answers its
 * calls via {@link TelegramCodec}, journals every event per chat, and
 * assembles the recording into a run-bundle v1 document via {@link
 * Session.toBundle}.
 */
export class Session {
  private readonly clock: Clock;
  private readonly runId: string;
  private readonly humanActor: SessionActor;
  private readonly botActor: SessionActor;
  private readonly partId: string;
  private readonly partTitle: string;
  private readonly codec: TelegramCodec;

  private transport: BotTransport | undefined;
  private readonly journals = new Map<number, InMemoryJournal>();
  private humanPlatformIdentity: WirePlatformIdentity | undefined;

  constructor(options: SessionOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.runId = options.runId ?? "run-1";
    this.humanActor = options.human ?? DEFAULT_HUMAN;
    this.botActor = options.bot ?? DEFAULT_BOT;
    this.partId = options.partId ?? "session";
    this.partTitle = options.partTitle ?? "Session transcript";
    this.codec = new TelegramCodec(this.clock);
  }

  /**
   * Registers the bot this session drives, wiring its transport's incoming
   * calls to the Telegram codec and its answers back via `respond`. This v1
   * slice supports exactly one bot per session — a second call throws.
   */
  registerBot(transport: BotTransport): void {
    if (this.transport) {
      throw new Error(
        "Session.registerBot: a bot is already registered — this slice supports one bot per session",
      );
    }
    this.transport = transport;
    transport.onCall((call: BotCall) => {
      const result = this.codec.handleCall(call.method, call.payload, {
        journalFor: (chatId) => this.journalFor(chatId),
      });
      transport.respond(call.id, result);
    });
  }

  /** Delivers a user's submitted text to the registered bot as a Telegram `message` update. */
  submitText(chatId: number, user: TelegramUser, text: string): void {
    const transport = this.requireTransport();
    this.humanPlatformIdentity ??= toPlatformIdentity(user);
    const journal = this.journalFor(chatId);
    const update = this.codec.buildTextUpdate(chatId, user, text, journal);
    transport.deliverUpdate(update);
  }

  /**
   * Delivers a user's inline-keyboard button click to the registered bot as
   * a Telegram `callback_query` update, targeting the bot message that
   * carried the clicked action.
   */
  submitClick(chatId: number, user: TelegramUser, actionId: string, targetMessageId: number): void {
    const transport = this.requireTransport();
    this.humanPlatformIdentity ??= toPlatformIdentity(user);
    const journal = this.journalFor(chatId);
    const update = this.codec.buildCallbackUpdate(chatId, user, targetMessageId, actionId, journal);
    transport.deliverUpdate(update);
  }

  /** Returns (creating if necessary) the append-only journal for one chat. */
  journal(chatId: number): Journal {
    return this.journalFor(chatId);
  }

  /**
   * Assembles everything this session has recorded into a run-bundle v1
   * document: one run, an actor roster (human + bot, each with its Telegram
   * `platformIdentities` entry), every chat's journal, and one deterministic
   * part whose journal boundary spans the entire recording.
   *
   * @remarks
   * Returns `unknown` deliberately — this package does not generate types
   * from the run-bundle schema (decision 0012's "shared contracts are
   * formats, never code"); callers that need the schema's types import them
   * from wherever they generate/vendor them, and validate structurally
   * (e.g. with ajv) rather than relying on this method's return type.
   */
  toBundle(): unknown {
    const chats = Array.from(this.journals.entries())
      .sort(([a], [b]) => a - b)
      .map(([chatId, journal]) => ({
        chatId,
        entries: journal.entries().map(toWireJournalEntry),
      }));

    const chatBoundaries = chats.map((chat) => ({
      chatId: chat.chatId,
      firstEntry: 0,
      entryCount: chat.entries.length,
    }));

    return {
      format: RUN_BUNDLE_FORMAT,
      metadata: {
        createdAt: this.clock().toISOString(),
        chatwrightVersion: RUNTIME_VERSION,
      },
      runs: [
        {
          id: this.runId,
          platform: "telegram",
          endpointProfile: "platform-emulated",
          actors: [this.humanActorWire(), this.botActorWire()],
          chats,
          parts: [
            {
              id: this.partId,
              title: this.partTitle,
              kind: "deterministic",
              journalBoundary: { chats: chatBoundaries },
            },
          ],
        },
      ],
    };
  }

  private humanActorWire(): Record<string, unknown> {
    return {
      id: this.humanActor.id,
      type: this.humanActor.type,
      ...(this.humanActor.name !== undefined ? { name: this.humanActor.name } : {}),
      ...(this.humanPlatformIdentity !== undefined
        ? { platformIdentities: { telegram: this.humanPlatformIdentity } }
        : {}),
    };
  }

  private botActorWire(): Record<string, unknown> {
    return {
      id: this.botActor.id,
      type: this.botActor.type,
      ...(this.botActor.name !== undefined ? { name: this.botActor.name } : {}),
      platformIdentities: {
        telegram: { userId: TELEGRAM_BOT_USER_ID, firstName: TELEGRAM_BOT_FIRST_NAME },
      },
    };
  }

  private journalFor(chatId: number): InMemoryJournal {
    let journal = this.journals.get(chatId);
    if (!journal) {
      journal = new InMemoryJournal();
      this.journals.set(chatId, journal);
    }
    return journal;
  }

  private requireTransport(): BotTransport {
    if (!this.transport) {
      throw new Error("Session: no bot registered — call registerBot() before submitting events");
    }
    return this.transport;
  }
}

function toPlatformIdentity(user: TelegramUser): WirePlatformIdentity {
  return {
    userId: user.id,
    ...(user.firstName !== undefined && user.firstName !== "" ? { firstName: user.firstName } : {}),
    ...(user.username !== undefined && user.username !== "" ? { username: user.username } : {}),
  };
}

function toWireJournalEntry(entry: JournalEntry): Record<string, unknown> {
  return {
    direction: entry.direction,
    kind: entry.kind,
    messageId: entry.messageId,
    refMessageId: entry.refMessageId,
    version: entry.version,
    text: entry.text,
    actions: entry.actions ? entry.actions.map(cloneActionRow) : null,
    method: entry.method,
    at: entry.at,
    fromId: entry.fromId,
  };
}

function cloneActionRow(row: readonly JournalAction[]): Record<string, unknown>[] {
  return row.map((action) => ({ label: action.label, id: action.id, url: action.url }));
}
