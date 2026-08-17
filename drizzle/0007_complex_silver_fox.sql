ALTER TABLE `projects` ADD `zoomEnabled` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `zoomAmountPercent` int DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `zoomDirection` enum('IN','OUT','AUTO') DEFAULT 'AUTO' NOT NULL;