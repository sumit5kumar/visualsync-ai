CREATE TABLE `groqKeyRotationStates` (
	`userId` int NOT NULL,
	`nextRotationOrder` int NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `groqKeyRotationStates_userId` PRIMARY KEY(`userId`)
);
