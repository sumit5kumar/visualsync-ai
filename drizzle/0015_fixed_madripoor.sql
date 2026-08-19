ALTER TABLE `groqApiKeys` ADD `transcriptionProbeAt` timestamp;--> statement-breakpoint
ALTER TABLE `groqApiKeys` ADD `generationProbeAt` timestamp;--> statement-breakpoint
ALTER TABLE `groqApiKeys` ADD `projectVerifiedAt` timestamp;--> statement-breakpoint
ALTER TABLE `groqApiKeys` ADD `projectVerificationError` text;