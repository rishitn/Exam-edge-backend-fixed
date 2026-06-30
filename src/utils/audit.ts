import { prisma } from "../lib/prisma";
import { AuditAction } from "@prisma/client";
import { createLogger } from "../lib/logger";

const log = createLogger("audit");

// =============================================================================
// Audit Logger — called after every significant admin action
// Stored in audit_logs table. Never throws — audit failure must not break the request.
// =============================================================================

interface AuditLogInput {
  adminId: string;
  action: AuditAction;
  entityType: string;
  entityId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export async function writeAuditLog(input: AuditLogInput): Promise<void> {
  try {
    await prisma.auditLog.create({ data: input as any });
  } catch (err) {
    // Never throw from audit logging — log the failure and move on
    log.error({ err, input }, "Failed to write audit log");
  }
}

// Convenience wrappers
export const audit = {
  created: (adminId: string, entityType: string, entityId: string, meta?: Record<string, unknown>, ip?: string) =>
    writeAuditLog({ adminId, action: AuditAction.CREATE, entityType, entityId, metadata: meta, ipAddress: ip }),

  updated: (adminId: string, entityType: string, entityId: string, meta?: Record<string, unknown>, ip?: string) =>
    writeAuditLog({ adminId, action: AuditAction.UPDATE, entityType, entityId, metadata: meta, ipAddress: ip }),

  deleted: (adminId: string, entityType: string, entityId: string, ip?: string) =>
    writeAuditLog({ adminId, action: AuditAction.DELETE, entityType, entityId, ipAddress: ip }),

  published: (adminId: string, entityType: string, entityId: string, ip?: string) =>
    writeAuditLog({ adminId, action: AuditAction.PUBLISH, entityType, entityId, ipAddress: ip }),

  unpublished: (adminId: string, entityType: string, entityId: string, ip?: string) =>
    writeAuditLog({ adminId, action: AuditAction.UNPUBLISH, entityType, entityId, ipAddress: ip }),

  login: (adminId: string, ip?: string) =>
    writeAuditLog({ adminId, action: AuditAction.LOGIN, entityType: "Admin", entityId: adminId, ipAddress: ip }),

  bulkUpload: (adminId: string, entityId: string, meta?: Record<string, unknown>, ip?: string) =>
    writeAuditLog({ adminId, action: AuditAction.BULK_UPLOAD, entityType: "BulkUpload", entityId, metadata: meta, ipAddress: ip }),
};
