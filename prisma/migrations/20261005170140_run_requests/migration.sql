-- CreateEnum
CREATE TYPE "RunRequestStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RunClaimStatus" AS ENUM ('ACTIVE', 'REPORTED', 'ABANDONED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityType" ADD VALUE 'RUN_REQUESTED';
ALTER TYPE "ActivityType" ADD VALUE 'RUN_CLAIMED';
ALTER TYPE "ActivityType" ADD VALUE 'RUN_REPORTED';

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "runRequestId" TEXT;

-- CreateTable
CREATE TABLE "RunRequest" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "files" TEXT[],
    "notes" TEXT,
    "status" "RunRequestStatus" NOT NULL DEFAULT 'OPEN',
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunRequestVote" (
    "requestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunRequestVote_pkey" PRIMARY KEY ("requestId","userId")
);

-- CreateTable
CREATE TABLE "RunClaim" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "RunClaimStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "commitSha" TEXT,
    "toolName" TEXT,
    "toolVersion" TEXT,
    "command" TEXT,
    "generated" INTEGER,
    "killed" INTEGER,
    "survived" INTEGER,
    "durationSeconds" INTEGER,
    "environment" TEXT,
    "notes" TEXT,
    "reportedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RunRequest_projectId_status_createdAt_idx" ON "RunRequest"("projectId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "RunRequest_pullRequestId_status_idx" ON "RunRequest"("pullRequestId", "status");

-- CreateIndex
CREATE INDEX "RunRequestVote_userId_idx" ON "RunRequestVote"("userId");

-- CreateIndex
CREATE INDEX "RunClaim_requestId_status_idx" ON "RunClaim"("requestId", "status");

-- CreateIndex
CREATE INDEX "RunClaim_userId_status_idx" ON "RunClaim"("userId", "status");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_runRequestId_fkey" FOREIGN KEY ("runRequestId") REFERENCES "RunRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunRequest" ADD CONSTRAINT "RunRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunRequest" ADD CONSTRAINT "RunRequest_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunRequest" ADD CONSTRAINT "RunRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunRequest" ADD CONSTRAINT "RunRequest_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunRequestVote" ADD CONSTRAINT "RunRequestVote_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "RunRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunRequestVote" ADD CONSTRAINT "RunRequestVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunClaim" ADD CONSTRAINT "RunClaim_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "RunRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunClaim" ADD CONSTRAINT "RunClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
