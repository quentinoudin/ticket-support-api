-- CreateEnum
CREATE TYPE "AiHandling" AS ENUM ('NONE', 'PENDING', 'ANSWERED', 'ESCALATED', 'OFF_TOPIC');

-- CreateEnum
CREATE TYPE "AiCategory" AS ENUM ('HARDWARE', 'SOFTWARE', 'NETWORK', 'ACCOUNT_ACCESS', 'EMAIL', 'PRINTING', 'SECURITY', 'OTHER');

-- CreateEnum
CREATE TYPE "MessageSender" AS ENUM ('USER', 'STAFF', 'AI');

-- CreateEnum
CREATE TYPE "AiRunKind" AS ENUM ('TRIAGE', 'REPLY');

-- CreateEnum
CREATE TYPE "AiRunOutcome" AS ENUM ('OK', 'INVALID_OUTPUT', 'ERROR', 'TIMEOUT', 'BUDGET');

-- CreateEnum
CREATE TYPE "AiJobType" AS ENUM ('TRIAGE_AND_REPLY', 'FOLLOW_UP');

-- CreateEnum
CREATE TYPE "AiJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "aiCategory" "AiCategory",
ADD COLUMN     "aiEscalationReason" VARCHAR(60),
ADD COLUMN     "aiHandling" "AiHandling" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "aiPriorityReason" VARCHAR(200),
ADD COLUMN     "priorityLockedByHuman" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requestedPriority" "TicketPriority";

-- CreateTable
CREATE TABLE "TicketMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "sender" "MessageSender" NOT NULL,
    "authorId" TEXT,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiRun" (
    "id" TEXT NOT NULL,
    "kind" "AiRunKind" NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "outcome" "AiRunOutcome" NOT NULL,
    "ticketId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiJob" (
    "id" TEXT NOT NULL,
    "type" "AiJobType" NOT NULL,
    "ticketId" TEXT NOT NULL,
    "messageId" TEXT,
    "status" "AiJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lastError" VARCHAR(120),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TicketMessage_ticketId_createdAt_idx" ON "TicketMessage"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "AiRun_createdAt_idx" ON "AiRun"("createdAt");

-- CreateIndex
CREATE INDEX "AiRun_userId_createdAt_idx" ON "AiRun"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiRun_ticketId_idx" ON "AiRun"("ticketId");

-- CreateIndex
CREATE INDEX "AiJob_status_runAfter_idx" ON "AiJob"("status", "runAfter");

-- CreateIndex
CREATE INDEX "AiJob_ticketId_idx" ON "AiJob"("ticketId");

-- CreateIndex
CREATE INDEX "Ticket_aiHandling_idx" ON "Ticket"("aiHandling");

-- AddForeignKey
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiJob" ADD CONSTRAINT "AiJob_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
