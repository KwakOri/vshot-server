import { Router, Request, Response } from 'express';
import { ImageMerger } from '../services/ImageMerger.js';
import { V3RoomManager } from '../services/v3/V3RoomManager.js';
import { V3SignalingServer } from '../services/v3/V3SignalingServer.js';

/**
 * V3 Photo API Router
 *
 * Handles single-shot photo capture:
 * 1. Upload Host/Guest photo (base64 → R2)
 * 2. Auto-merge when both uploaded
 * 3. Broadcast completion via signaling
 */
export function createPhotoV3Router(
  imageMerger: ImageMerger,
  v3RoomManager: V3RoomManager,
  v3SignalingServer: V3SignalingServer
): Router {
  const router = Router();

  // Track merge in progress to prevent race condition
  const mergeInProgress = new Set<string>();

  // In-memory buffer store for merge (cleared after merge)
  const photoBuffers = new Map<string, { host?: Buffer; guest?: Buffer }>();

  /**
   * Upload photo (base64) - V3 version
   */
  router.post('/upload', async (req: Request, res: Response) => {
    try {
      const { roomId, userId, role, imageData } = req.body;

      if (!roomId || !userId || !role || !imageData) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      if (role !== 'host' && role !== 'guest') {
        return res.status(400).json({ error: 'Invalid role' });
      }

      // Get room
      const room = v3RoomManager.getRoom(roomId);
      if (!room) {
        return res.status(404).json({ error: 'Room not found' });
      }

      // Verify role
      if (role === 'host' && room.hostId !== userId) {
        return res.status(403).json({ error: 'Not authorized as host' });
      }
      if (role === 'guest' && room.currentGuestId !== userId) {
        return res.status(403).json({ error: 'Not authorized as guest' });
      }

      // Save image to R2
      const { url: publicUrl, fileId } = await imageMerger.saveBase64Image(imageData);

      // Store buffer for merge
      const base64String = imageData.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64String, 'base64');
      if (!photoBuffers.has(roomId)) {
        photoBuffers.set(roomId, {});
      }
      const buffers = photoBuffers.get(roomId)!;
      buffers[role as 'host' | 'guest'] = buffer;

      // Log upload
      const estimatedSize = (buffer.length) / 1024 / 1024;
      console.log(`[PhotoV3] ${role} uploaded for room ${roomId}:`, {
        fileId,
        estimatedSizeMB: estimatedSize.toFixed(2),
      });

      // Update session
      v3RoomManager.updateSessionPhoto(roomId, role, publicUrl);

      // Check if ready for merge (with race condition protection)
      if (v3RoomManager.isSessionReadyForMerge(roomId) && !mergeInProgress.has(roomId)) {
        mergeInProgress.add(roomId);
        console.log(`[PhotoV3] Both photos ready, starting merge for room ${roomId}`);

        // Trigger merge asynchronously
        setImmediate(async () => {
          try {
            const mergedUrl = await mergePhotos(roomId, imageMerger, v3RoomManager, photoBuffers);

            if (mergedUrl) {
              // Broadcast merge complete to room via signaling
              v3SignalingServer.broadcastToRoom(roomId, {
                type: 'photos-merged-v3',
                roomId,
                mergedPhotoUrl: mergedUrl,
              });

              // Auto-complete session with merged photo as result
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
            console.error(`[PhotoV3] Merge failed for room ${roomId}:`, error);
          } finally {
            mergeInProgress.delete(roomId);
            photoBuffers.delete(roomId); // Cleanup buffers
          }
        });
      }

      res.json({
        success: true,
        url: publicUrl,
        fileId,
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

      // Update session with frame result
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

/**
 * Merge host and guest photos using in-memory buffers
 */
async function mergePhotos(
  roomId: string,
  imageMerger: ImageMerger,
  v3RoomManager: V3RoomManager,
  photoBuffers: Map<string, { host?: Buffer; guest?: Buffer }>
): Promise<string | null> {
  try {
    const session = v3RoomManager.getCurrentSession(roomId);
    if (!session || !session.hostPhotoUrl || !session.guestPhotoUrl) {
      console.error(`[PhotoV3] Cannot merge - photos not ready for room ${roomId}`);
      return null;
    }

    if (session.mergedPhotoUrl) {
      console.log(`[PhotoV3] Session already merged for room ${roomId}`);
      return session.mergedPhotoUrl;
    }

    const buffers = photoBuffers.get(roomId);
    if (!buffers?.host || !buffers?.guest) {
      console.error(`[PhotoV3] Cannot merge - buffers not available for room ${roomId}`);
      return null;
    }

    // Use guest image dimensions as the output size
    const sharp = (await import('sharp')).default;
    const guestMeta = await sharp(buffers.guest).metadata();
    const outputWidth = guestMeta.width || 1600;
    const outputHeight = guestMeta.height || 2400;

    console.log(`[PhotoV3] Merging at ${outputWidth}x${outputHeight} (from guest image native size)`);

    const { url: mergedUrl } = await imageMerger.mergeAndUpload(buffers.guest, buffers.host, {
      layout: 'overlap',
      outputWidth,
      outputHeight,
    });

    // Update session
    v3RoomManager.updateSessionMergedPhoto(roomId, mergedUrl);

    console.log(`[PhotoV3] Photos merged successfully for room ${roomId}`);
    return mergedUrl;
  } catch (error) {
    console.error(`[PhotoV3] Merge error for room ${roomId}:`, error);
    throw error;
  }
}
