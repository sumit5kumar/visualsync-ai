CREATE TABLE `geminiApiKeys` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`label` varchar(80) NOT NULL,
	`keyPrefix` varchar(8) NOT NULL,
	`keySuffix` varchar(8) NOT NULL,
	`keyFingerprint` varchar(64) NOT NULL,
	`encryptedCiphertext` text NOT NULL,
	`encryptionIv` varchar(32) NOT NULL,
	`encryptionTag` varchar(32) NOT NULL,
	`isActive` boolean NOT NULL DEFAULT false,
	`testStatus` enum('untested','verified','invalid','quota_limited','unavailable') NOT NULL DEFAULT 'untested',
	`lastTestedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `geminiApiKeys_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `mediaAssets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`projectId` int,
	`assetType` enum('narration','image') NOT NULL,
	`originalFilename` varchar(255) NOT NULL,
	`storageKey` varchar(512) NOT NULL,
	`mimeType` varchar(128),
	`byteSize` int,
	`sequenceNumber` int,
	`contentHash` varchar(128),
	`perceptualHash` varchar(128),
	`analysisState` enum('pending','cached','analyzed','failed') NOT NULL DEFAULT 'pending',
	`analysisJson` json,
	`embeddingSourceText` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `mediaAssets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`narrationStorageKey` varchar(512),
	`narrationOriginalName` varchar(255),
	`imageSourcePath` text,
	`outputPath` text,
	`resolutionWidth` int NOT NULL DEFAULT 1920,
	`resolutionHeight` int NOT NULL DEFAULT 1080,
	`aspectRatio` varchar(12) NOT NULL DEFAULT '16:9',
	`status` enum('draft','ready','analyzing','timeline_ready','rendering','completed','failed') NOT NULL DEFAULT 'draft',
	`workerState` enum('unconfigured','ready','processing','error') NOT NULL DEFAULT 'unconfigured',
	`audioDurationMs` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `projects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `timelineSegments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`imageAssetId` int,
	`startMs` int NOT NULL,
	`endMs` int NOT NULL,
	`narrationText` text NOT NULL,
	`confidence` decimal(5,4) NOT NULL,
	`selectionReason` text NOT NULL,
	`candidateImagesJson` json,
	`decisionType` enum('KEEP','CHANGE','SKIP','FALLBACK') NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `timelineSegments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `gemini_keys_user_idx` ON `geminiApiKeys` (`userId`);--> statement-breakpoint
CREATE INDEX `media_assets_user_hash_idx` ON `mediaAssets` (`userId`,`contentHash`);--> statement-breakpoint
CREATE INDEX `media_assets_project_sequence_idx` ON `mediaAssets` (`projectId`,`sequenceNumber`);--> statement-breakpoint
CREATE INDEX `projects_user_updated_idx` ON `projects` (`userId`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `timeline_segments_project_start_idx` ON `timelineSegments` (`projectId`,`startMs`);