CREATE TABLE `timelineGenerationJobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`userId` int NOT NULL,
	`status` enum('queued','processing','waiting_for_retry','completed','failed') NOT NULL DEFAULT 'queued',
	`currentStage` enum('queued','transcribing','analyzing_images','building_timeline','finalizing','completed','failed') NOT NULL DEFAULT 'queued',
	`attemptCount` int NOT NULL DEFAULT 0,
	`transientFailureCount` int NOT NULL DEFAULT 0,
	`retryAt` timestamp,
	`lastError` json,
	`scheduleCronTaskUid` varchar(65),
	`leaseToken` varchar(64),
	`leaseExpiresAt` timestamp,
	`startedAt` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `timelineGenerationJobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `timelineGenerationJobs_projectId_unique` UNIQUE(`projectId`)
);
--> statement-breakpoint
CREATE INDEX `timeline_generation_jobs_user_status_idx` ON `timelineGenerationJobs` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `timeline_generation_jobs_schedule_uid_idx` ON `timelineGenerationJobs` (`scheduleCronTaskUid`);