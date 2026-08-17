ALTER TABLE `projects` MODIFY COLUMN `zoomAmountPercent` int NOT NULL DEFAULT 8;--> statement-breakpoint
ALTER TABLE `projects` MODIFY COLUMN `zoomDirection` enum('IN','OUT','AUTO') NOT NULL DEFAULT 'IN';--> statement-breakpoint
ALTER TABLE `projects` ADD `crossfadeDurationMs` int DEFAULT 800 NOT NULL;