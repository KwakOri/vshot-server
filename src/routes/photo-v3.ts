import express, { Request, Response, Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ImageMerger } from '../services/ImageMerger.js';
import { V3RoomManager } from '../services/v3/V3RoomManager.js';
import { V3SignalingServer } from '../services/v3/V3SignalingServer.js';

type UploadRole = 'host' | 'guest';
type UploadType = 'insurance' | 'final';

interface PhotoUploadSession {
  uploadId: string;
  roomId: string;
  userId: string;
  role: UploadRole;
  uploadType: UploadType;
  contentType: string;
  totalSize: number;
  chunkSize: number;
  chunks: Map<number, Buffer>;
  createdAt: number;
  expiresAt: number;
}

interface HandleUploadedPhotoOptions {
  roomId: string;
  role: UploadRole;
  uploadType: UploadType;
  publicUrl: string;
  buffer: Buffer;
  imageMerger: ImageMerger;
  v3RoomManager: V3RoomManager;
  v3SignalingServer: V3SignalingServer;
  photoBuffers: Map<string, { host?: Buffer; guest?: Buffer }>;
  mergeInProgress: Set<string>;
}

const PHOTO_UPLOAD_CHUNK_SIZE = 1024 * 1024;
const PHOTO_UPLOAD_TTL_MS = 10 * 60 * 1000;
const rawChunkParser = express.raw({ type: 'application/octet-stream', limit: '2mb' });

/**
 * V3 Photo API Router
 *
 * Handles single-shot photo capture:
 * 1. Upload Host/Guest insurance photo (base64 → R2)
 * 2. Upload Host/Guest final photo through resumable chunks
 * 3. Auto-merge when both uploaded
 * 4. Broadcast completion via signaling
 */
export function createPhotoV3Router(
  imageMerger: ImageMerger,
  v3RoomManager: V3RoomManager,
  v3SignalingServer: V3SignalingServer
): Router {
  const router = Router();

  const mergeInProgress = new Set<string>();
  const photoBuffers = new Map<string, { host?: Buffer; guest?: Buffer }>();
  const uploadSessions = new Map<string, PhotoUploadSession>();

  const cleanupTimer = setInterval(() => {
    cleanupExpiredUploadSessions(uploadSessions);
  }, 60_000);
  cleanupTimer.unref?.();

  /**
   * Upload photo (base64) - used for the insurance tier
   */
  router.post('/upload', async (req: Request, res: Response) => {
    try {
      const parsed = parsePhotoUploadPayload(req.body);
      if (!parsed.ok) {
        return res.status(400).json({ error: parsed.error });
      }

      const { roomId, userId, role, imageData, uploadType } = parsed.value;
      const access = authorizeRoomAccess(v3RoomManager, roomId, userId, role);
      if (!access.ok) {
        return res.status(access.status).json({ error: access.error });
      }

      const { url: publicUrl, fileId, buffer } = await imageMerger.saveBase64Image(imageData);

      await handleUploadedPhoto({
        roomId,
        role,
        uploadType,
        publicUrl,
        buffer,
        imageMerger,
        v3RoomManager,
        v3SignalingServer,
        photoBuffers,
        mergeInProgress,
      });

      res.json({
        success: true,
        url: publicUrl,
        fileId,
        uploadType,
      });
    } catch (error) {
      console.error('[PhotoV3] Upload error:', error);
      res.status(500).json({
        error: 'Failed to upload photo',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * Start resumable upload session for final images
   */
  router.post('/uploads/start', async (req: Request, res: Response) => {
    const { roomId, userId, role, uploadType = 'final', totalSize, contentType } = req.body ?? {};

    if (!roomId || !userId || !role) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (role !== 'host' && role !== 'guest') {
      return res.status(400).json({ error: 'Invalid role' });
    }

    if (uploadType !== 'final') {
      return res.status(400).json({ error: 'Only final uploads use resumable mode' });
    }

    if (!Number.isFinite(totalSize) || totalSize <= 0) {
      return res.status(400).json({ error: 'Invalid totalSize' });
    }

    const access = authorizeRoomAccess(v3RoomManager, roomId, userId, role);
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
    }

    const uploadId = uuidv4();
    const expiresAt = Date.now() + PHOTO_UPLOAD_TTL_MS;

    uploadSessions.set(uploadId, {
      uploadId,
      roomId,
      userId,
      role,
      uploadType,
      contentType: contentType || 'image/png',
      totalSize,
      chunkSize: PHOTO_UPLOAD_CHUNK_SIZE,
      chunks: new Map(),
      createdAt: Date.now(),
      expiresAt,
    });

    res.json({
      success: true,
      uploadId,
      chunkSize: PHOTO_UPLOAD_CHUNK_SIZE,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  });

  /**
   * Upload one resumable chunk
   */
  router.patch('/uploads/:uploadId/chunk', rawChunkParser, async (req: Request, res: Response) => {
    const session = getActiveUploadSession(uploadSessions, req.params.uploadId);
    if (!session) {
      return res.status(404).json({ error: 'Upload session not found or expired' });
    }

    const offset = Number.parseInt(String(req.headers['x-upload-offset'] || ''), 10);
    const chunkIndex = Number.parseInt(String(req.headers['x-chunk-index'] || ''), 10);
    const body = normalizeRawBody(req.body);

    if (!Number.isInteger(offset) || offset < 0) {
      return res.status(400).json({ error: 'Invalid X-Upload-Offset header' });
    }

    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      return res.status(400).json({ error: 'Invalid X-Chunk-Index header' });
    }

    const expectedOffset = chunkIndex * session.chunkSize;
    if (offset !== expectedOffset) {
      return res.status(409).json({
        error: 'Offset mismatch',
        nextOffset: computeNextOffset(session),
        receivedChunks: getReceivedChunkIndexes(session),
        completed: computeNextOffset(session) >= session.totalSize,
      });
    }

    const maxChunkLength = Math.min(session.chunkSize, session.totalSize - offset);
    if (body.length === 0 || body.length > maxChunkLength) {
      return res.status(400).json({ error: 'Invalid chunk size' });
    }

    const existingChunk = session.chunks.get(chunkIndex);
    if (existingChunk) {
      if (!existingChunk.equals(body)) {
        return res.status(409).json({
          error: 'Chunk already exists with different content',
          nextOffset: computeNextOffset(session),
          receivedChunks: getReceivedChunkIndexes(session),
          completed: computeNextOffset(session) >= session.totalSize,
        });
      }
    } else {
      session.chunks.set(chunkIndex, body);
    }

    session.expiresAt = Date.now() + PHOTO_UPLOAD_TTL_MS;
    const nextOffset = computeNextOffset(session);

    res.json({
      success: true,
      nextOffset,
      receivedChunks: getReceivedChunkIndexes(session),
      completed: nextOffset >= session.totalSize,
    });
  });

  /**
   * Check resumable upload status
   */
  router.get('/uploads/:uploadId/status', (req: Request, res: Response) => {
    const session = getActiveUploadSession(uploadSessions, req.params.uploadId);
    if (!session) {
      return res.status(404).json({ error: 'Upload session not found or expired' });
    }

    const nextOffset = computeNextOffset(session);
    res.json({
      success: true,
      nextOffset,
      receivedChunks: getReceivedChunkIndexes(session),
      completed: nextOffset >= session.totalSize,
    });
  });

  /**
   * Finalize resumable upload and trigger final merge flow
   */
  router.post('/uploads/:uploadId/complete', async (req: Request, res: Response) => {
    try {
      const session = getActiveUploadSession(uploadSessions, req.params.uploadId);
      if (!session) {
        return res.status(404).json({ error: 'Upload session not found or expired' });
      }

      const nextOffset = computeNextOffset(session);
      if (nextOffset !== session.totalSize) {
        return res.status(409).json({
          error: 'Upload is incomplete',
          nextOffset,
          receivedChunks: getReceivedChunkIndexes(session),
          completed: false,
        });
      }

      const buffer = assembleUploadBuffer(session);
      const { url: publicUrl, fileId } = await imageMerger.saveImageBuffer(buffer, session.contentType);

      await handleUploadedPhoto({
        roomId: session.roomId,
        role: session.role,
        uploadType: session.uploadType,
        publicUrl,
        buffer,
        imageMerger,
        v3RoomManager,
        v3SignalingServer,
        photoBuffers,
        mergeInProgress,
      });

      uploadSessions.delete(session.uploadId);

      res.json({
        success: true,
        url: publicUrl,
        fileId,
        uploadType: session.uploadType,
      });
    } catch (error) {
      console.error('[PhotoV3] Resumable upload completion error:', error);
      res.status(500).json({
        error: 'Failed to complete photo upload',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * Apply frame to merged photo
   */
  router.post('/apply-frame', async (req: Request, res: Response) => {
    try {
      const { roomId, mergedPhotoUrl, frameLayout } = req.body;

      if (!roomId || !mergedPhotoUrl || !frameLayout) {
        return res.status(400).json({ error: 'Missing required fields (roomId, mergedPhotoUrl, frameLayout)' });
      }

      const room = v3RoomManager.getRoom(roomId);
      if (!room) {
        return res.status(404).json({ error: 'Room not found' });
      }

      if (!frameLayout.id || !frameLayout.canvasWidth || !frameLayout.canvasHeight) {
        return res.status(400).json({ error: 'Invalid frameLayout structure' });
      }

      // TODO: Implement actual frame overlay using Sharp
      // For now, return the merged photo URL as-is
      const framedUrl = mergedPhotoUrl;

      const session = v3RoomManager.getCurrentSession(roomId);
      if (session) {
        session.frameResultUrl = framedUrl;

        v3SignalingServer.broadcastToRoom(roomId, {
          type: 'session-complete-v3',
          roomId,
          sessionId: session.sessionId,
          frameResultUrl: framedUrl,
        });
      }

      console.log(`[PhotoV3] Frame applied for room ${roomId}`);

      res.json({
        success: true,
        frameResultUrl: framedUrl,
      });
    } catch (error) {
      console.error('[PhotoV3] Frame application error:', error);
      res.status(500).json({
        error: 'Failed to apply frame',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * Get session results
   */
  router.get('/session/:roomId', (req: Request, res: Response) => {
    try {
      const { roomId } = req.params;

      const room = v3RoomManager.getRoom(roomId);
      if (!room) {
        return res.status(404).json({ error: 'Room not found' });
      }

      const currentSession = v3RoomManager.getCurrentSession(roomId);
      const completedSessions = v3RoomManager.getCompletedSessions(roomId);

      res.json({
        success: true,
        room: {
          roomId: room.roomId,
          hostId: room.hostId,
          currentGuestId: room.currentGuestId,
          hostSettings: room.hostSettings,
        },
        currentSession,
        completedSessions,
      });
    } catch (error) {
      console.error('[PhotoV3] Get session error:', error);
      res.status(500).json({
        error: 'Failed to get session',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}

function parsePhotoUploadPayload(body: any):
  | { ok: true; value: { roomId: string; userId: string; role: UploadRole; imageData: string; uploadType: UploadType } }
  | { ok: false; error: string } {
  const { roomId, userId, role, imageData, uploadType = 'final' } = body ?? {};

  if (!roomId || !userId || !role || !imageData) {
    return { ok: false, error: 'Missing required fields' };
  }

  if (role !== 'host' && role !== 'guest') {
    return { ok: false, error: 'Invalid role' };
  }

  if (uploadType !== 'insurance' && uploadType !== 'final') {
    return { ok: false, error: 'uploadType must be insurance or final' };
  }

  return {
    ok: true,
    value: {
      roomId,
      userId,
      role,
      imageData,
      uploadType,
    },
  };
}

function authorizeRoomAccess(
  v3RoomManager: V3RoomManager,
  roomId: string,
  userId: string,
  role: UploadRole
): { ok: true } | { ok: false; status: number; error: string } {
  const room = v3RoomManager.getRoom(roomId);
  if (!room) {
    return { ok: false, status: 404, error: 'Room not found' };
  }

  if (role === 'host' && room.hostId !== userId) {
    return { ok: false, status: 403, error: 'Not authorized as host' };
  }

  if (role === 'guest' && room.currentGuestId !== userId) {
    return { ok: false, status: 403, error: 'Not authorized as guest' };
  }

  return { ok: true };
}

async function handleUploadedPhoto({
  roomId,
  role,
  uploadType,
  publicUrl,
  buffer,
  imageMerger,
  v3RoomManager,
  v3SignalingServer,
  photoBuffers,
  mergeInProgress,
}: HandleUploadedPhotoOptions): Promise<void> {
  storePhotoBuffer(photoBuffers, roomId, uploadType, role, buffer);

  const estimatedSize = buffer.length / 1024 / 1024;
  console.log(`[PhotoV3] ${role} ${uploadType} uploaded for room ${roomId}:`, {
    estimatedSizeMB: estimatedSize.toFixed(2),
  });

  if (uploadType === 'insurance') {
    v3RoomManager.updateSessionInsurance(roomId, role, publicUrl);

    const provisionalKey = `${roomId}:provisional`;
    if (!v3RoomManager.isSessionReadyForProvisionalMerge(roomId) || mergeInProgress.has(provisionalKey)) {
      return;
    }

    mergeInProgress.add(provisionalKey);
    console.log(`[PhotoV3] Both insurance images ready, starting provisional merge for room ${roomId}`);

    setImmediate(async () => {
      try {
        const mergedUrl = await mergePhotosFromBuffers(roomId, 'insurance', imageMerger, v3RoomManager, photoBuffers);

        if (mergedUrl) {
          v3RoomManager.updateSessionMergeStatus(roomId, 'provisional');

          v3SignalingServer.broadcastToRoom(roomId, {
            type: 'photos-merged-v3',
            roomId,
            mergedPhotoUrl: mergedUrl,
            mergeStatus: 'provisional',
          });

          console.log(`[PhotoV3] Provisional merge complete for room ${roomId}`);
        }
      } catch (error) {
        console.error(`[PhotoV3] Provisional merge failed for room ${roomId}:`, error);
      } finally {
        mergeInProgress.delete(provisionalKey);
        photoBuffers.delete(`${roomId}:insurance`);
      }
    });

    return;
  }

  v3RoomManager.updateSessionPhoto(roomId, role, publicUrl);

  const finalKey = `${roomId}:final`;
  if (!v3RoomManager.isSessionReadyForMerge(roomId) || mergeInProgress.has(finalKey)) {
    return;
  }

  mergeInProgress.add(finalKey);
  console.log(`[PhotoV3] Both final photos ready, starting final merge for room ${roomId}`);

  setImmediate(async () => {
    try {
      const mergedUrl = await mergePhotosFromBuffers(roomId, 'final', imageMerger, v3RoomManager, photoBuffers);

      if (mergedUrl) {
        v3RoomManager.updateSessionMergeStatus(roomId, 'final');

        v3SignalingServer.broadcastToRoom(roomId, {
          type: 'photos-merged-v3',
          roomId,
          mergedPhotoUrl: mergedUrl,
          mergeStatus: 'final',
        });

        const session = v3RoomManager.completeSession(roomId, mergedUrl);

        if (session) {
          v3SignalingServer.broadcastToRoom(roomId, {
            type: 'session-complete-v3',
            roomId,
            sessionId: session.sessionId,
            frameResultUrl: mergedUrl,
          });
        }
      }
    } catch (error) {
      console.error(`[PhotoV3] Final merge failed for room ${roomId}:`, error);
    } finally {
      mergeInProgress.delete(finalKey);
      photoBuffers.delete(`${roomId}:final`);
    }
  });
}

function storePhotoBuffer(
  photoBuffers: Map<string, { host?: Buffer; guest?: Buffer }>,
  roomId: string,
  uploadType: UploadType,
  role: UploadRole,
  buffer: Buffer
): void {
  const bufferKey = `${roomId}:${uploadType}`;
  if (!photoBuffers.has(bufferKey)) {
    photoBuffers.set(bufferKey, {});
  }
  const buffers = photoBuffers.get(bufferKey)!;
  buffers[role] = buffer;
}

function cleanupExpiredUploadSessions(uploadSessions: Map<string, PhotoUploadSession>): void {
  const now = Date.now();
  for (const [uploadId, session] of uploadSessions.entries()) {
    if (session.expiresAt <= now) {
      uploadSessions.delete(uploadId);
      console.warn(`[PhotoV3] Expired upload session cleaned up: ${uploadId}`);
    }
  }
}

function getActiveUploadSession(
  uploadSessions: Map<string, PhotoUploadSession>,
  uploadId: string
): PhotoUploadSession | null {
  const session = uploadSessions.get(uploadId);
  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    uploadSessions.delete(uploadId);
    return null;
  }

  return session;
}

function normalizeRawBody(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  return Buffer.alloc(0);
}

function getReceivedChunkIndexes(session: PhotoUploadSession): number[] {
  return Array.from(session.chunks.keys()).sort((a, b) => a - b);
}

function computeNextOffset(session: PhotoUploadSession): number {
  const totalChunks = Math.ceil(session.totalSize / session.chunkSize);
  let offset = 0;

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    const chunk = session.chunks.get(chunkIndex);
    if (!chunk) {
      break;
    }
    offset += chunk.length;
  }

  return offset;
}

function assembleUploadBuffer(session: PhotoUploadSession): Buffer {
  const totalChunks = Math.ceil(session.totalSize / session.chunkSize);
  const buffers: Buffer[] = [];

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    const chunk = session.chunks.get(chunkIndex);
    if (!chunk) {
      throw new Error(`Missing chunk ${chunkIndex} for upload ${session.uploadId}`);
    }
    buffers.push(chunk);
  }

  return Buffer.concat(buffers, session.totalSize);
}

/**
 * Merge host and guest photos from in-memory buffers
 * @param tier - 'insurance' (provisional) or 'final' (definitive)
 */
async function mergePhotosFromBuffers(
  roomId: string,
  tier: UploadType,
  imageMerger: ImageMerger,
  v3RoomManager: V3RoomManager,
  photoBuffers: Map<string, { host?: Buffer; guest?: Buffer }>
): Promise<string | null> {
  try {
    const bufferKey = `${roomId}:${tier}`;
    const buffers = photoBuffers.get(bufferKey);
    if (!buffers?.host || !buffers?.guest) {
      console.error(`[PhotoV3] Cannot merge - ${tier} buffers not available for room ${roomId}`);
      return null;
    }

    const sharp = (await import('sharp')).default;
    const guestMeta = await sharp(buffers.guest).metadata();
    const outputWidth = guestMeta.width || 1600;
    const outputHeight = guestMeta.height || 2400;

    console.log(`[PhotoV3] ${tier} merge at ${outputWidth}x${outputHeight} for room ${roomId}`);

    const { url: mergedUrl } = await imageMerger.mergeAndUpload(buffers.guest, buffers.host, {
      layout: 'overlap',
      outputWidth,
      outputHeight,
    });

    v3RoomManager.updateSessionMergedPhoto(roomId, mergedUrl);

    console.log(`[PhotoV3] ${tier} merge complete for room ${roomId}`);
    return mergedUrl;
  } catch (error) {
    console.error(`[PhotoV3] ${tier} merge error for room ${roomId}:`, error);
    throw error;
  }
}
