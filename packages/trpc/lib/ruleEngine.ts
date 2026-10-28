import deepEql from "deep-equal";
import { and, eq } from "drizzle-orm";

import { db as globalDb, DB } from "@karakeep/db";
import {
  bookmarks,
  ruleEngineRulesTable,
  tagsOnBookmarks,
} from "@karakeep/db/schema";
import {
  buildCrawlIdempotencyKey,
  LowPriorityCrawlerQueue,
  QueuePriority,
  RuleEngineQueue,
} from "@karakeep/shared-server";
import { EnqueueOptions } from "@karakeep/shared/queueing";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import {
  rustEngineEnabled,
  workLedger,
} from "@karakeep/shared-server/work/runtime";
import {
  RuleEngineAction,
  RuleEngineCondition,
  RuleEngineEvent,
  RuleEngineRule,
  zRuleEngineRuleEventSchema,
} from "@karakeep/shared/types/rules";

import { AuthedContext } from "..";
import { List } from "../models/lists";
import { RuleEngineRuleModel } from "../models/rules";

async function fetchBookmark(db: AuthedContext["db"], bookmarkId: string) {
  return await db.query.bookmarks.findFirst({
    where: eq(bookmarks.id, bookmarkId),
    with: {
      link: {
        columns: {
          url: true,
          title: true,
        },
      },
      text: true,
      asset: true,
      tagsOnBookmarks: true,
      rssFeeds: {
        columns: {
          rssFeedId: true,
        },
      },
      user: {
        columns: {},
        with: {
          rules: {
            with: {
              actions: true,
            },
          },
        },
      },
    },
  });
}

type ReturnedBookmark = NonNullable<Awaited<ReturnType<typeof fetchBookmark>>>;

export interface RuleEngineEvaluationResult {
  type: "success" | "failure";
  ruleId: string;
  message: string;
}

export class RuleEngine {
  private constructor(
    private ctx: AuthedContext,
    private bookmark: Omit<ReturnedBookmark, "user">,
    private rules: RuleEngineRule[],
  ) {}

  private get bookmarkTitle(): string {
    return (
      this.bookmark.title ??
      (this.bookmark.type === BookmarkTypes.LINK
        ? this.bookmark.link?.title
        : "") ??
      ""
    );
  }

  static doesEventMatchRule(
    ruleEvent: RuleEngineRule["event"],
    event: RuleEngineEvent,
  ) {
    if (
      ruleEvent.type === event.type &&
      "listIds" in ruleEvent &&
      (event.type === "addedToList" || event.type === "removedFromList")
    ) {
      return ruleEvent.listIds.includes(event.listId);
    }
    return deepEql(ruleEvent, event, { strict: true });
  }

  /**
   * Checks whether any enabled rule for the given user matches any of the events.
   * Only fetches the minimal data needed (rule events, no actions or bookmark data).
   */
  static async matchesAnyRule(
    userId: string,
    events: RuleEngineEvent[],
    db: DB = globalDb,
  ): Promise<boolean> {
    if (events.length === 0) {
      return false;
    }

    const enabledRules = await db.query.ruleEngineRulesTable.findMany({
      where: and(
        eq(ruleEngineRulesTable.userId, userId),
        eq(ruleEngineRulesTable.enabled, true),
      ),
      columns: {
        event: true,
      },
    });
    return enabledRules.some((rule) => {
      let parsedEvent: unknown;
      try {
        parsedEvent = JSON.parse(rule.event);
      } catch {
        return false;
      }
      const ruleEvent = zRuleEngineRuleEventSchema.safeParse(parsedEvent);
      if (!ruleEvent.success) {
        return false;
      }
      return events.some((event) =>
        this.doesEventMatchRule(ruleEvent.data, event),
      );
    });
  }

  /**
   * Checks whether any enabled rule for the given user matches any of the events,
   * and only then enqueues the job to the rule engine queue.
   */
  static async triggerOnEvent(
    userId: string,
    bookmarkId: string,
    events: RuleEngineEvent[],
    opts?: EnqueueOptions,
    db: DB = globalDb,
  ): Promise<void> {
    if (!(await this.matchesAnyRule(userId, events, db))) {
      return;
    }

    await RuleEngineQueue.enqueue({ bookmarkId, events }, opts);
  }

  static async forBookmark(
    ctx: AuthedContext,
    bookmarkId: string,
  ): Promise<RuleEngine | null> {
    const [bookmark, rules] = await Promise.all([
      fetchBookmark(ctx.db, bookmarkId),
      RuleEngineRuleModel.getAll(ctx),
    ]);
    if (!bookmark) {
      return null;
    }
    return new RuleEngine(
      ctx,
      bookmark,
      rules.map((r) => r.rule),
    );
  }

  doesBookmarkMatchConditions(condition: RuleEngineCondition): boolean {
    switch (condition.type) {
      case "alwaysTrue": {
        return true;
      }
      case "urlContains": {
        return (this.bookmark.link?.url ?? "").includes(condition.str);
      }
      case "urlDoesNotContain": {
        return (
          this.bookmark.type == BookmarkTypes.LINK &&
          !(this.bookmark.link?.url ?? "").includes(condition.str)
        );
      }
      case "titleContains": {
        return this.bookmarkTitle.includes(condition.str);
      }
      case "titleDoesNotContain": {
        return !this.bookmarkTitle.includes(condition.str);
      }
      case "importedFromFeed": {
        return this.bookmark.rssFeeds.some(
          (f) => f.rssFeedId === condition.feedId,
        );
      }
      case "bookmarkTypeIs": {
        return this.bookmark.type === condition.bookmarkType;
      }
      case "bookmarkSourceIs": {
        return this.bookmark.source === condition.source;
      }
      case "hasTag": {
        return this.bookmark.tagsOnBookmarks.some(
          (t) => t.tagId === condition.tagId,
        );
      }
      case "isFavourited": {
        return this.bookmark.favourited;
      }
      case "isArchived": {
        return this.bookmark.archived;
      }
      case "and": {
        return condition.conditions.every((c) =>
          this.doesBookmarkMatchConditions(c),
        );
      }
      case "or": {
        return condition.conditions.some((c) =>
          this.doesBookmarkMatchConditions(c),
        );
      }
      default: {
        const _exhaustiveCheck: never = condition;
        return false;
      }
    }
  }

  async evaluateRule(
    rule: RuleEngineRule,
    event: RuleEngineEvent,
  ): Promise<RuleEngineEvaluationResult[]> {
    if (!rule.enabled) {
      return [];
    }
    if (!RuleEngine.doesEventMatchRule(rule.event, event)) {
      return [];
    }
    if (!this.doesBookmarkMatchConditions(rule.condition)) {
      return [];
    }
    const results = await Promise.allSettled(
      rule.actions.map((action) => this.executeAction(action)),
    );
    return results.map((result) => {
      if (result.status === "fulfilled") {
        return {
          type: "success",
          ruleId: rule.id,
          message: result.value,
        };
      } else {
        return {
          type: "failure",
          ruleId: rule.id,
          message: (result.reason as Error).message,
        };
      }
    });
  }

  private mutate(fn: () => void) {
    if (!rustEngineEnabled()) {
      fn();
      return;
    }
    const sql = this.ctx.db.$client;
    sql
      .transaction(() => {
        const previous = sql
          .prepare(
            "SELECT value FROM work_settings WHERE key='applying_result'",
          )
          .get() as { value: string };
        sql
          .prepare(
            "UPDATE work_settings SET value='1' WHERE key='applying_result'",
          )
          .run();
        fn();
        // Preserve the existing rule semantics: tag/favourite/archive actions do
        // not recursively trigger more rules. Their search update is durable.
        workLedger().enqueue("publish", {
          bookmarkId: this.bookmark.id,
          type: "index",
        });
        sql
          .prepare(
            "UPDATE work_settings SET value=? WHERE key='applying_result'",
          )
          .run(previous.value);
      })
      .immediate();
  }

  async executeAction(action: RuleEngineAction): Promise<string> {
    switch (action.type) {
      case "addTag": {
        this.mutate(() =>
          this.ctx.db
            .insert(tagsOnBookmarks)
            .values([
              {
                attachedBy: "human",
                bookmarkId: this.bookmark.id,
                tagId: action.tagId,
              },
            ])
            .onConflictDoNothing()
            .run(),
        );
        return `Added tag ${action.tagId}`;
      }
      case "removeTag": {
        this.mutate(() =>
          this.ctx.db
            .delete(tagsOnBookmarks)
            .where(
              and(
                eq(tagsOnBookmarks.tagId, action.tagId),
                eq(tagsOnBookmarks.bookmarkId, this.bookmark.id),
              ),
            )
            .run(),
        );
        return `Removed tag ${action.tagId}`;
      }
      case "addToList": {
        const list = await List.fromId(this.ctx, action.listId);
        await list.addBookmark(this.bookmark.id);
        return `Added to list ${action.listId}`;
      }
      case "removeFromList": {
        const list = await List.fromId(this.ctx, action.listId);
        await list.removeBookmark(this.bookmark.id);
        return `Removed from list ${action.listId}`;
      }
      case "downloadFullPageArchive": {
        const payload = {
          bookmarkId: this.bookmark.id,
          archiveFullPage: true,
          runInference: false,
        };
        await LowPriorityCrawlerQueue.enqueue(payload, {
          groupId: this.bookmark.userId,
          priority: QueuePriority.Low,
          idempotencyKey: buildCrawlIdempotencyKey(payload),
        });
        return `Enqueued full page archive`;
      }
      case "favouriteBookmark": {
        this.mutate(() =>
          this.ctx.db
            .update(bookmarks)
            .set({
              favourited: true,
            })
            .where(eq(bookmarks.id, this.bookmark.id))
            .run(),
        );
        return `Marked as favourited`;
      }
      case "archiveBookmark": {
        this.mutate(() =>
          this.ctx.db
            .update(bookmarks)
            .set({
              archived: true,
            })
            .where(eq(bookmarks.id, this.bookmark.id))
            .run(),
        );
        return `Marked as archived`;
      }
      default: {
        const _exhaustiveCheck: never = action;
        return "";
      }
    }
  }

  async onEvent(event: RuleEngineEvent): Promise<RuleEngineEvaluationResult[]> {
    const results = await Promise.all(
      this.rules.map((rule) => this.evaluateRule(rule, event)),
    );
    return results.flat();
  }
}
