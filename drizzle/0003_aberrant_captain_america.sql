CREATE TABLE `groqApiKeys` (
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
	CONSTRAINT `groqApiKeys_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `groq_keys_user_idx` ON `groqApiKeys` (`userId`);