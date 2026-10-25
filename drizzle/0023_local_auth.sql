ALTER TABLE `users` MODIFY COLUMN `openId` varchar(320) NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `passwordHash` varchar(255);
