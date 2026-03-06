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

  // In-memory buffer store for merge: keyed by `${roomId}:${tier}` (tier = 'insurance' | 'final')
  const photoBuffers = new Map<string, { host?: Buffer; guest?: Buffer }>();

  /**
   * Upload photo (base64) - V3 version
   * uploadType: 'insurance' (small JPEG, fast) | 'final' (full-res PNG, default)
   * Insurance uploads trigger a provisional merge; final uploads trigger the definitive merge.
   */
  router.post('/upload', async (req: Request, res: Response) => {
    try {
      const { roomId, userId, role, imageData, uploadType = 'final' } = req.body;

      if (!roomId || !userId || !role || !imageData) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      if (role !== 'host' && role !== 'guest') {
        return res.status(400).json({ error: 'Invalid role' });
      }

      if (uploadType !== 'insurance' && uploadType !== 'final') {
        return res.status(400).json({ error: 'uploadType must be insurance or final' });
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

      // Store buffer for merge (keyed by tier)
      const base64String = imageData.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64String, 'base64');
      const bufferKey = `${roomId}:${uploadType}`;
      if (!photoBuffers.has(bufferKey)) {
        photoBuffers.set(bufferKey, {});
      }
      const buffers = photoBuffers.get(bufferKey)!;
      buffers[role as 'host' | 'guest'] = buffer;

      const estimatedSize = buffer.length / 1024 / 1024;
      console.log(`[PhotoV3] ${role} ${uploadType} uploaded for room ${roomId}:`, {
        fileId,
        estimatedSizeMB: estimatedSize.toFixed(2),
      });

      if (uploadType === 'insurance') {
        // Update insurance URL in session
        v3RoomManager.updateSessionInsurance(roomId, role, publicUrl);

        // Provisional merge when both insurance images ready
        const provisionalKey = `${roomId}:provisional`;
        if (v3RoomManager.isSessionReadyForProvisionalMerge(roomId) && !mergeInProgress.has(provisionalKey)) {
          mergeInProgress.add(provisionalKey);
          console.log(`[PhotoV3] Both insurance images ready, starting provisional merge for room ${roomId}`);

          setImmediate(async () => {
            try {
              const mergedUrl = await mergePhotosFromBuffers(roomId, 'insurance', imageMerger, v3RoomManager, photoBuffers);

              if (mergedUrl) {
                // Mark session as provisional
                const session = v3RoomManager.getCurrentSession(roomId);
                if (session) {
                  session.mergeStatus = 'provisional';
                  session.mergedPhotoUrl = mergedUrl;
                }

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
              photoBuffers.delete(bufferKey);
            }
          });
        }
      } else {
        // Final upload
        v3RoomManager.updateSessionPhoto(roomId, role, publicUrl);

        // Final merge when both final images ready
        const finalKey = `${roomId}:final`;
        if (v3RoomManager.isSessionReadyForMerge(roomId) && !mergeInProgress.has(finalKey)) {
          mergeInProgress.add(finalKey);
          console.log(`[PhotoV3] Both final photos ready, starting final merge for room ${roomId}`);

          setImmediate(async () => {
            try {
              const mergedUrl = await mergePhotosFromBuffers(roomId, 'final', imageMerger, v3RoomManager, photoBuffers);

              if (mergedUrl) {
                v3SignalingServer.broadcastToRoom(roomId, {
                  type: 'photos-merged-v3',
                  roomId,
                  mergedPhotoUrl: mergedUrl,
                  mergeStatus: 'final',
                });

                // Complete session
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
      }

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
 * Merge host and guest photos from in-memory buffers
 * @param tier - 'insurance' (provisional) or 'final' (definitive)
 */
async function mergePhotosFromBuffers(
  roomId: string,
  tier: 'insurance' | 'final',
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

    // Use guest image dimensions as the output size
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

    // Update session merged URL
    v3RoomManager.updateSessionMergedPhoto(roomId, mergedUrl);

    console.log(`[PhotoV3] ${tier} merge complete for room ${roomId}`);
    return mergedUrl;
  } catch (error) {
    console.error(`[PhotoV3] ${tier} merge error for room ${roomId}:`, error);
    throw error;
  }
}
