CREATE TABLE `extracted_documents` (
	`bookmarkId` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`document` text NOT NULL,
	`plainText` text NOT NULL,
	`extractedAt` integer NOT NULL,
	FOREIGN KEY (`bookmarkId`) REFERENCES `bookmarks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `work_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`subject` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`dedupeKey` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`availableAt` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`maxAttempts` integer DEFAULT 5 NOT NULL,
	`token` text,
	`leaseUntil` integer,
	`fingerprint` text,
	`checkpoint` text,
	`error` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_jobs_pending_key` ON `work_jobs` (`dedupeKey`) WHERE "work_jobs"."state"='pending';
--> statement-breakpoint
CREATE INDEX `work_jobs_due` ON `work_jobs` (`state`,`availableAt`,`priority`);
--> statement-breakpoint
CREATE INDEX `work_jobs_subject` ON `work_jobs` (`subject`,`state`);
--> statement-breakpoint
CREATE TABLE `work_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
INSERT INTO work_settings(key,value) VALUES ('enabled','0');
--> statement-breakpoint
INSERT INTO work_settings(key,value) VALUES ('applying_result','0');
--> statement-breakpoint
CREATE TRIGGER work_bookmark_created AFTER INSERT ON bookmarks
WHEN (SELECT value FROM work_settings WHERE key='enabled')='1' AND coalesce((SELECT value FROM work_settings WHERE key='applying_result'),'0')!='1'
BEGIN
 INSERT INTO work_jobs (id,kind,payload,subject,dedupeKey,availableAt,createdAt,updatedAt)
 VALUES (lower(hex(randomblob(16))), 'domain',
   json_object('bookmarkId',NEW.id,'operation','created','userId',NEW.userId),
   NEW.id, 'event:created:'||NEW.id, unixepoch()*1000,unixepoch()*1000,unixepoch()*1000)
 ON CONFLICT(dedupeKey) WHERE state='pending' DO UPDATE SET payload=excluded.payload,updatedAt=excluded.updatedAt;
END;
--> statement-breakpoint
CREATE TRIGGER work_bookmark_deleted AFTER DELETE ON bookmarks
WHEN (SELECT value FROM work_settings WHERE key='enabled')='1' AND coalesce((SELECT value FROM work_settings WHERE key='applying_result'),'0')!='1'
BEGIN
 INSERT INTO work_jobs (id,kind,payload,subject,dedupeKey,availableAt,createdAt,updatedAt)
 VALUES (lower(hex(randomblob(16))), 'domain',
   json_object('bookmarkId',OLD.id,'operation','deleted','userId',OLD.userId),
   OLD.id, 'event:deleted:'||OLD.id, unixepoch()*1000,unixepoch()*1000,unixepoch()*1000)
 ON CONFLICT(dedupeKey) WHERE state='pending' DO UPDATE SET payload=excluded.payload,updatedAt=excluded.updatedAt;
END;
--> statement-breakpoint
CREATE TRIGGER work_bookmark_edited AFTER UPDATE OF title,note,summary,archived,favourited,type ON bookmarks
WHEN (SELECT value FROM work_settings WHERE key='enabled')='1' AND coalesce((SELECT value FROM work_settings WHERE key='applying_result'),'0')!='1' AND (NEW.title IS NOT OLD.title OR NEW.note IS NOT OLD.note OR NEW.summary IS NOT OLD.summary OR NEW.archived IS NOT OLD.archived OR NEW.favourited IS NOT OLD.favourited OR NEW.type IS NOT OLD.type)
BEGIN
 INSERT INTO work_jobs (id,kind,payload,subject,dedupeKey,availableAt,createdAt,updatedAt)
 VALUES (lower(hex(randomblob(16))), 'domain',
   json_object('bookmarkId',NEW.id,'operation','edited','userId',NEW.userId),
   NEW.id, 'event:edited:'||NEW.id, unixepoch()*1000,unixepoch()*1000,unixepoch()*1000)
 ON CONFLICT(dedupeKey) WHERE state='pending' DO UPDATE SET payload=excluded.payload,updatedAt=excluded.updatedAt;
END;
--> statement-breakpoint
CREATE TRIGGER work_link_source AFTER UPDATE OF url ON bookmarkLinks
WHEN (SELECT value FROM work_settings WHERE key='enabled')='1' AND coalesce((SELECT value FROM work_settings WHERE key='applying_result'),'0')!='1' AND (NEW.url IS NOT OLD.url)
BEGIN
 INSERT INTO work_jobs (id,kind,payload,subject,dedupeKey,availableAt,createdAt,updatedAt)
 VALUES (lower(hex(randomblob(16))), 'domain',
   json_object('bookmarkId',NEW.id,'operation','source','userId',NULL),
   NEW.id, 'event:source:'||NEW.id, unixepoch()*1000,unixepoch()*1000,unixepoch()*1000)
 ON CONFLICT(dedupeKey) WHERE state='pending' DO UPDATE SET payload=excluded.payload,updatedAt=excluded.updatedAt;
END;
--> statement-breakpoint
CREATE TRIGGER work_text_source AFTER UPDATE OF text ON bookmarkTexts
WHEN (SELECT value FROM work_settings WHERE key='enabled')='1' AND coalesce((SELECT value FROM work_settings WHERE key='applying_result'),'0')!='1' AND (NEW.text IS NOT OLD.text)
BEGIN
 INSERT INTO work_jobs (id,kind,payload,subject,dedupeKey,availableAt,createdAt,updatedAt)
 VALUES (lower(hex(randomblob(16))), 'domain',
   json_object('bookmarkId',NEW.id,'operation','source','userId',NULL),
   NEW.id, 'event:source:'||NEW.id, unixepoch()*1000,unixepoch()*1000,unixepoch()*1000)
 ON CONFLICT(dedupeKey) WHERE state='pending' DO UPDATE SET payload=excluded.payload,updatedAt=excluded.updatedAt;
END;
--> statement-breakpoint
CREATE TRIGGER work_asset_source AFTER UPDATE OF assetId ON bookmarkAssets
WHEN (SELECT value FROM work_settings WHERE key='enabled')='1' AND coalesce((SELECT value FROM work_settings WHERE key='applying_result'),'0')!='1' AND (NEW.assetId IS NOT OLD.assetId)
BEGIN
 INSERT INTO work_jobs (id,kind,payload,subject,dedupeKey,availableAt,createdAt,updatedAt)
 VALUES (lower(hex(randomblob(16))), 'domain',
   json_object('bookmarkId',NEW.id,'operation','source','userId',NULL),
   NEW.id, 'event:source:'||NEW.id, unixepoch()*1000,unixepoch()*1000,unixepoch()*1000)
 ON CONFLICT(dedupeKey) WHERE state='pending' DO UPDATE SET payload=excluded.payload,updatedAt=excluded.updatedAt;
END;
--> statement-breakpoint
CREATE TRIGGER work_projection_bookmarkLinks AFTER UPDATE OF title,description,author,publisher,htmlContent,contentAssetId ON bookmarkLinks
WHEN (SELECT value FROM work_settings WHERE key='enabled')='1' AND coalesce((SELECT value FROM work_settings WHERE key='applying_result'),'0')!='1'
BEGIN
 INSERT INTO work_jobs (id,kind,payload,subject,dedupeKey,availableAt,createdAt,updatedAt)
 VALUES (lower(hex(randomblob(16))), 'domain',
   json_object('bookmarkId',NEW.id,'operation','projection','userId',NULL),
   NEW.id, 'event:projection:'||NEW.id, unixepoch()*1000,unixepoch()*1000,unixepoch()*1000)
 ON CONFLICT(dedupeKey) WHERE state='pending' DO UPDATE SET payload=excluded.payload,updatedAt=excluded.updatedAt;
END;
--> statement-breakpoint
CREATE TRIGGER work_projection_bookmarkAssets AFTER UPDATE OF content,metadata ON bookmarkAssets
WHEN (SELECT value FROM work_settings WHERE key='enabled')='1' AND coalesce((SELECT value FROM work_settings WHERE key='applying_result'),'0')!='1'
BEGIN
 INSERT INTO work_jobs (id,kind,payload,subject,dedupeKey,availableAt,createdAt,updatedAt)
 VALUES (lower(hex(randomblob(16))), 'domain',
   json_object('bookmarkId',NEW.id,'operation','projection','userId',NULL),
   NEW.id, 'event:projection:'||NEW.id, unixepoch()*1000,unixepoch()*1000,unixepoch()*1000)
 ON CONFLICT(dedupeKey) WHERE state='pending' DO UPDATE SET payload=excluded.payload,updatedAt=excluded.updatedAt;
END;
--> statement-breakpoint
CREATE TRIGGER work_import_insert AFTER INSERT ON importStagingBookmarks
WHEN (SELECT value FROM work_settings WHERE key='enabled')='1' AND coalesce((SELECT value FROM work_settings WHERE key='applying_result'),'0')!='1' AND (NEW.status='pending')
BEGIN
 INSERT INTO work_jobs (id,kind,payload,subject,dedupeKey,availableAt,createdAt,updatedAt)
 VALUES (lower(hex(randomblob(16))), 'domain',
   json_object('bookmarkId',NEW.importSessionId,'operation','import','userId',NULL),
   NEW.importSessionId, 'event:import:'||NEW.importSessionId, unixepoch()*1000,unixepoch()*1000,unixepoch()*1000)
 ON CONFLICT(dedupeKey) WHERE state='pending' DO UPDATE SET payload=excluded.payload,updatedAt=excluded.updatedAt;
END;
--> statement-breakpoint
CREATE TRIGGER work_import_update AFTER UPDATE OF status ON importStagingBookmarks
WHEN (SELECT value FROM work_settings WHERE key='enabled')='1' AND coalesce((SELECT value FROM work_settings WHERE key='applying_result'),'0')!='1' AND (NEW.status='pending')
BEGIN
 INSERT INTO work_jobs (id,kind,payload,subject,dedupeKey,availableAt,createdAt,updatedAt)
 VALUES (lower(hex(randomblob(16))), 'domain',
   json_object('bookmarkId',NEW.importSessionId,'operation','import','userId',NULL),
   NEW.importSessionId, 'event:import:'||NEW.importSessionId, unixepoch()*1000,unixepoch()*1000,unixepoch()*1000)
 ON CONFLICT(dedupeKey) WHERE state='pending' DO UPDATE SET payload=excluded.payload,updatedAt=excluded.updatedAt;
END;
--> statement-breakpoint
CREATE TRIGGER work_feed_insert AFTER INSERT ON rssFeeds
WHEN (SELECT value FROM work_settings WHERE key='enabled')='1' AND coalesce((SELECT value FROM work_settings WHERE key='applying_result'),'0')!='1' AND (NEW.enabled=1)
BEGIN
 INSERT INTO work_jobs (id,kind,payload,subject,dedupeKey,availableAt,createdAt,updatedAt)
 VALUES (lower(hex(randomblob(16))), 'domain',
   json_object('bookmarkId',NEW.id,'operation','feed','userId',NULL),
   NEW.id, 'event:feed:'||NEW.id, unixepoch()*1000,unixepoch()*1000,unixepoch()*1000)
 ON CONFLICT(dedupeKey) WHERE state='pending' DO UPDATE SET payload=excluded.payload,updatedAt=excluded.updatedAt;
END;
--> statement-breakpoint
CREATE TRIGGER work_feed_update AFTER UPDATE OF url,enabled ON rssFeeds
WHEN (SELECT value FROM work_settings WHERE key='enabled')='1' AND coalesce((SELECT value FROM work_settings WHERE key='applying_result'),'0')!='1' AND (NEW.enabled=1)
BEGIN
 INSERT INTO work_jobs (id,kind,payload,subject,dedupeKey,availableAt,createdAt,updatedAt)
 VALUES (lower(hex(randomblob(16))), 'domain',
   json_object('bookmarkId',NEW.id,'operation','feed','userId',NULL),
   NEW.id, 'event:feed:'||NEW.id, unixepoch()*1000,unixepoch()*1000,unixepoch()*1000)
 ON CONFLICT(dedupeKey) WHERE state='pending' DO UPDATE SET payload=excluded.payload,updatedAt=excluded.updatedAt;
END;
--> statement-breakpoint
CREATE TRIGGER work_backup_schedule AFTER UPDATE OF backupsEnabled,backupsFrequency ON user
WHEN (SELECT value FROM work_settings WHERE key='enabled')='1' AND coalesce((SELECT value FROM work_settings WHERE key='applying_result'),'0')!='1' AND (NEW.backupsEnabled=1)
BEGIN
 INSERT INTO work_jobs (id,kind,payload,subject,dedupeKey,availableAt,createdAt,updatedAt)
 VALUES (lower(hex(randomblob(16))), 'domain',
   json_object('bookmarkId',NEW.id,'operation','backup_schedule','userId',NEW.id),
   NEW.id, 'event:backup_schedule:'||NEW.id, unixepoch()*1000,unixepoch()*1000,unixepoch()*1000)
 ON CONFLICT(dedupeKey) WHERE state='pending' DO UPDATE SET payload=excluded.payload,updatedAt=excluded.updatedAt;
END;
--> statement-breakpoint
CREATE TRIGGER work_import_finalized AFTER UPDATE OF status ON importSessions
WHEN (SELECT value FROM work_settings WHERE key='enabled')='1' AND coalesce((SELECT value FROM work_settings WHERE key='applying_result'),'0')!='1' AND NEW.status='pending'
BEGIN
 INSERT INTO work_jobs (id,kind,payload,subject,dedupeKey,availableAt,createdAt,updatedAt)
 VALUES (lower(hex(randomblob(16))),'import',json_object('importSessionId',NEW.id),
 'import:'||NEW.id,'import:'||NEW.id,unixepoch()*1000,unixepoch()*1000,unixepoch()*1000)
 ON CONFLICT(dedupeKey) WHERE state='pending' DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER work_tagsOnBookmarks_insert AFTER INSERT ON tagsOnBookmarks
WHEN (SELECT value FROM work_settings WHERE key='enabled')='1' AND coalesce((SELECT value FROM work_settings WHERE key='applying_result'),'0')!='1'
BEGIN
 INSERT INTO work_jobs(id,kind,payload,subject,dedupeKey,availableAt,createdAt,updatedAt)
 VALUES(lower(hex(randomblob(16))),'domain',json_object('bookmarkId',NEW.bookmarkId,'operation','tagAdded','tagId',NEW.tagId),
 NEW.bookmarkId,lower(hex(randomblob(16))),unixepoch()*1000,unixepoch()*1000,unixepoch()*1000);
END;
--> statement-breakpoint
CREATE TRIGGER work_tagsOnBookmarks_delete AFTER DELETE ON tagsOnBookmarks
WHEN (SELECT value FROM work_settings WHERE key='enabled')='1' AND coalesce((SELECT value FROM work_settings WHERE key='applying_result'),'0')!='1'
BEGIN
 INSERT INTO work_jobs(id,kind,payload,subject,dedupeKey,availableAt,createdAt,updatedAt)
 VALUES(lower(hex(randomblob(16))),'domain',json_object('bookmarkId',OLD.bookmarkId,'operation','tagRemoved','tagId',OLD.tagId),
 OLD.bookmarkId,lower(hex(randomblob(16))),unixepoch()*1000,unixepoch()*1000,unixepoch()*1000);
END;
--> statement-breakpoint
CREATE TRIGGER work_bookmarksInLists_insert AFTER INSERT ON bookmarksInLists
WHEN (SELECT value FROM work_settings WHERE key='enabled')='1' AND coalesce((SELECT value FROM work_settings WHERE key='applying_result'),'0')!='1'
BEGIN
 INSERT INTO work_jobs(id,kind,payload,subject,dedupeKey,availableAt,createdAt,updatedAt)
 VALUES(lower(hex(randomblob(16))),'domain',json_object('bookmarkId',NEW.bookmarkId,'operation','addedToList','listId',NEW.listId),
 NEW.bookmarkId,lower(hex(randomblob(16))),unixepoch()*1000,unixepoch()*1000,unixepoch()*1000);
END;
--> statement-breakpoint
CREATE TRIGGER work_bookmarksInLists_delete AFTER DELETE ON bookmarksInLists
WHEN (SELECT value FROM work_settings WHERE key='enabled')='1' AND coalesce((SELECT value FROM work_settings WHERE key='applying_result'),'0')!='1'
BEGIN
 INSERT INTO work_jobs(id,kind,payload,subject,dedupeKey,availableAt,createdAt,updatedAt)
 VALUES(lower(hex(randomblob(16))),'domain',json_object('bookmarkId',OLD.bookmarkId,'operation','removedFromList','listId',OLD.listId),
 OLD.bookmarkId,lower(hex(randomblob(16))),unixepoch()*1000,unixepoch()*1000,unixepoch()*1000);
END;

--> statement-breakpoint
CREATE TRIGGER work_favourited AFTER UPDATE OF favourited ON bookmarks
WHEN (SELECT value FROM work_settings WHERE key='enabled')='1' AND coalesce((SELECT value FROM work_settings WHERE key='applying_result'),'0')!='1' AND NEW.favourited=1 AND NEW.favourited IS NOT OLD.favourited
BEGIN
 INSERT INTO work_jobs(id,kind,payload,subject,dedupeKey,availableAt,createdAt,updatedAt)
 VALUES(lower(hex(randomblob(16))),'domain',json_object('bookmarkId',NEW.id,'operation','favourited','userId',NEW.userId),NEW.id,lower(hex(randomblob(16))),unixepoch()*1000,unixepoch()*1000,unixepoch()*1000);
END;

--> statement-breakpoint
CREATE TRIGGER work_archived AFTER UPDATE OF archived ON bookmarks
WHEN (SELECT value FROM work_settings WHERE key='enabled')='1' AND coalesce((SELECT value FROM work_settings WHERE key='applying_result'),'0')!='1' AND NEW.archived=1 AND NEW.archived IS NOT OLD.archived
BEGIN
 INSERT INTO work_jobs(id,kind,payload,subject,dedupeKey,availableAt,createdAt,updatedAt)
 VALUES(lower(hex(randomblob(16))),'domain',json_object('bookmarkId',NEW.id,'operation','archived','userId',NEW.userId),NEW.id,lower(hex(randomblob(16))),unixepoch()*1000,unixepoch()*1000,unixepoch()*1000);
END;
