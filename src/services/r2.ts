import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

let r2Client: S3Client | null = null;

export function isR2Configured(): boolean {
  return !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME);
}

function getR2Client(): S3Client {
  if (!r2Client) {
    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
      throw new Error('R2 environment variables are not fully configured');
    }
    r2Client = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return r2Client;
}

export function generateObjectKey(fileId: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `files/${year}/${month}/${fileId}`;
}

export async function uploadToR2(
  objectKey: string,
  body: Buffer | Uint8Array,
  contentType: string
): Promise<void> {
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET_NAME!,
    Key: objectKey,
    Body: body,
    ContentType: contentType,
  });
  await getR2Client().send(command);
}

export async function deleteFromR2(objectKey: string): Promise<void> {
  const command = new DeleteObjectCommand({
    Bucket: R2_BUCKET_NAME!,
    Key: objectKey,
  });
  await getR2Client().send(command);
}

export async function generateSignedUrl(
  objectKey: string,
  expiresIn = 3600,
  filename?: string
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET_NAME!,
    Key: objectKey,
    ResponseContentDisposition: filename
      ? `attachment; filename="${encodeURIComponent(filename)}"`
      : 'attachment',
  });
  return getSignedUrl(getR2Client(), command, { expiresIn });
}

export function getPublicFileUrl(objectKey: string): string {
  if (R2_PUBLIC_URL) {
    return `${R2_PUBLIC_URL}/${objectKey}`;
  }
  throw new Error('R2_PUBLIC_URL is not configured');
}
