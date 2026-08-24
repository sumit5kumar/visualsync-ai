ALTER TABLE `projects` ADD `transitionType` varchar(24) DEFAULT 'CROSSFADE' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `enabledTransitions` varchar(200) DEFAULT 'CROSSFADE' NOT NULL;
