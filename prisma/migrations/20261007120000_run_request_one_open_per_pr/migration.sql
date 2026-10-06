-- At most one OPEN run request per pull request. Prisma cannot express a
-- partial index, so this lives only here (see RunRequest in schema.prisma).
CREATE UNIQUE INDEX "RunRequest_pullRequestId_open_key" ON "RunRequest"("pullRequestId") WHERE "status" = 'OPEN';
