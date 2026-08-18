ALTER TABLE `projects` ADD `processingStage` enum('idle','transcribing','analyzing_images','building_timeline','finalizing','failed') DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `processingStartedAt` timestamp;--> statement-breakpoint
ALTER TABLE `projects` ADD `processingStageStartedAt` timestamp;