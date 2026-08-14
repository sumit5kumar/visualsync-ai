CREATE TABLE `timelineApprovals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`userId` int NOT NULL,
	`status` enum('pending','approved','revoked') NOT NULL DEFAULT 'pending',
	`approvedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `timelineApprovals_id` PRIMARY KEY(`id`),
	CONSTRAINT `timelineApprovals_projectId_unique` UNIQUE(`projectId`)
);
--> statement-breakpoint
CREATE INDEX `timeline_approvals_user_idx` ON `timelineApprovals` (`userId`);