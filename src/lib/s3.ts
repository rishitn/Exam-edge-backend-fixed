import AWS from "aws-sdk";
import { env } from "../config/env";
import { CONSTANTS } from "../config/constants";
import { Errors, ErrorCode } from "../utils/errors";
import { createLogger } from "./logger";
import { prisma } from "./prisma";
import crypto from "crypto";
import path from "path";

const log = createLogger("s3");

// =============================================================================
// S3 Upload Service
// Handles image uploads for question content and solutions
// =============================================================================

let s3Instance: AWS.S3 | null = null;

function getS3(): AWS.S3 {
  if (s3Instance) return s3Instance;
  s3Instance = new AWS.S3({
    accessKeyId:     env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region:          env.AWS_REGION,
  });
  return s3Instance;
}

export interface UploadResult {
  s3Key:     string;
  publicUrl: string;
  bucket:    string;
}

// =============================================================================
// Upload a Buffer (for images from multipart form)
// =============================================================================
export async function uploadImageToS3(
  buffer:     Buffer,
  mimeType:   string,
  entityType: string,        // "question" | "solution" | "test"
  entityId:   string,
  uploadedById: string,
  originalName?: string
): Promise<UploadResult> {
  // Validate MIME type
  if (!CONSTANTS.ALLOWED_IMAGE_TYPES.includes(mimeType as any)) {
    throw Errors.badRequest(
      `Invalid file type: ${mimeType}. Allowed: ${CONSTANTS.ALLOWED_IMAGE_TYPES.join(", ")}`,
      ErrorCode.INVALID_INPUT
    );
  }

  // Validate size
  const sizeMb = buffer.length / (1024 * 1024);
  if (sizeMb > CONSTANTS.MAX_UPLOAD_SIZE_MB) {
    throw Errors.badRequest(
      `File too large: ${sizeMb.toFixed(1)}MB. Maximum: ${CONSTANTS.MAX_UPLOAD_SIZE_MB}MB`,
      ErrorCode.INVALID_INPUT
    );
  }

  // Build a deterministic, collision-resistant S3 key
  const ext = mimeType.split("/")[1] ?? "jpg";
  const hash = crypto.randomBytes(8).toString("hex");
  const s3Key = `${entityType}/${entityId}/${hash}.${ext}`;

  try {
    await getS3()
      .putObject({
        Bucket:      env.AWS_S3_BUCKET!,
        Key:         s3Key,
        Body:        buffer,
        ContentType: mimeType,
        CacheControl: "public, max-age=31536000, immutable", // 1 year — content-addressed
        Metadata: {
          uploadedBy: uploadedById,
          entityType,
          entityId,
          originalName: originalName ?? "",
        },
      })
      .promise();
  } catch (err) {
    log.error({ err, s3Key }, "S3: Upload failed");
    throw Errors.internal("Image upload failed. Please try again.");
  }

  const publicUrl = `${env.AWS_S3_BASE_URL}/${s3Key}`;

  // Register in media_assets table for lifecycle tracking
  await prisma.mediaAsset.create({
    data: {
      s3Key,
      s3Bucket:    env.AWS_S3_BUCKET!,
      publicUrl,
      mimeType,
      sizeBytes:   buffer.length,
      uploadedById,
      entityType,
      entityId,
    },
  }).catch((err) => {
    // Don't fail the upload if DB registration fails — log it
    log.error({ err, s3Key }, "Failed to register media asset in DB");
  });

  log.info({ s3Key, entityType, entityId, sizeMb: sizeMb.toFixed(2) }, "S3: Upload complete");
  return { s3Key, publicUrl, bucket: env.AWS_S3_BUCKET! };
}

// =============================================================================
// Generate a pre-signed URL for direct client-side upload (Phase 2)
// =============================================================================
export async function getPresignedUploadUrl(
  entityType: string,
  entityId:   string,
  mimeType:   string
): Promise<{ uploadUrl: string; s3Key: string; publicUrl: string }> {
  if (!CONSTANTS.ALLOWED_IMAGE_TYPES.includes(mimeType as any)) {
    throw Errors.badRequest(`Invalid file type: ${mimeType}`);
  }

  const ext = mimeType.split("/")[1] ?? "jpg";
  const hash = crypto.randomBytes(8).toString("hex");
  const s3Key = `${entityType}/${entityId}/${hash}.${ext}`;

  const uploadUrl = getS3().getSignedUrl("putObject", {
    Bucket:      env.AWS_S3_BUCKET!,
    Key:         s3Key,
    ContentType: mimeType,
    Expires:     300, // 5 minutes
  });

  const publicUrl = `${env.AWS_S3_BASE_URL}/${s3Key}`;
  return { uploadUrl, s3Key, publicUrl };
}

// =============================================================================
// Delete from S3 (called when question is hard deleted in cleanup jobs)
// =============================================================================
export async function deleteFromS3(s3Key: string): Promise<void> {
  try {
    await getS3()
      .deleteObject({ Bucket: env.AWS_S3_BUCKET!, Key: s3Key })
      .promise();
    log.info({ s3Key }, "S3: Object deleted");
  } catch (err) {
    log.error({ err, s3Key }, "S3: Delete failed");
  }
}
