ALTER TABLE `bookmarks` ADD `metadata` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `importStagingBookmarks` ADD `metadata` text;
--> statement-breakpoint
DROP TRIGGER work_bookmark_edited;
--> statement-breakpoint
CREATE TRIGGER work_bookmark_edited AFTER UPDATE OF title,note,summary,archived,favourited,type,metadata ON bookmarks
WHEN (SELECT value FROM work_settings WHERE key='enabled')='1'
 AND coalesce((SELECT value FROM work_settings WHERE key='applying_result'),'0')!='1'
 AND (NEW.title IS NOT OLD.title OR NEW.note IS NOT OLD.note OR NEW.summary IS NOT OLD.summary
   OR NEW.archived IS NOT OLD.archived OR NEW.favourited IS NOT OLD.favourited
   OR NEW.type IS NOT OLD.type OR NEW.metadata IS NOT OLD.metadata)
BEGIN
 INSERT INTO work_jobs(id,kind,payload,subject,dedupeKey,availableAt,createdAt,updatedAt)
 VALUES(lower(hex(randomblob(16))), 'domain',
   json_object('bookmarkId',NEW.id,'operation','edited','userId',NEW.userId,
     'previousContext',json_object('title',OLD.title,'note',OLD.note,'summary',OLD.summary,'metadata',json(OLD.metadata))),
   NEW.id,'event:edited:'||NEW.id,unixepoch()*1000,unixepoch()*1000,unixepoch()*1000)
 ON CONFLICT(dedupeKey) WHERE state='pending' DO UPDATE SET updatedAt=excluded.updatedAt;
END;
