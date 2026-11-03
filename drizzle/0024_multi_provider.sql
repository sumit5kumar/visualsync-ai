ALTER TABLE `projects` ADD `transcriptionProvider` enum('GROQ_WHISPER','DEEPGRAM_NOVA2','LOCAL_FASTER_WHISPER') DEFAULT 'GROQ_WHISPER' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `visionSyncProvider` enum('GROQ','GEMINI_FLASH') DEFAULT 'GROQ' NOT NULL;--> statement-breakpoint
ALTER TABLE `geminiApiKeys` ADD `lastUsedAt` timestamp;--> statement-breakpoint
ALTER TABLE `geminiApiKeys` ADD `lastFailureAt` timestamp;--> statement-breakpoint
ALTER TABLE `geminiApiKeys` ADD `cooldownUntil` timestamp;--> statement-breakpoint
ALTER TABLE `geminiApiKeys` ADD `consecutiveRateLimits` int DEFAULT 0 NOT NULL;
