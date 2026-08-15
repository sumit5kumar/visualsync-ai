ALTER TABLE `groqApiKeys` ADD `rotationOrder` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `groqApiKeys` ADD `rotationOrder` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `groqApiKeys` ADD `lastUsedAt` timestamp;--> statement-breakpoint
ALTER TABLE `groqApiKeys` ADD `lastFailureAt` timestamp;--> statement-breakpoint
ALTER TABLE `groqApiKeys` ADD `cooldownUntil` timestamp;--> statement-breakpoint
ALTER TABLE `groqApiKeys` ADD `consecutiveRateLimits` int DEFAULT 0 NOT NULL;
