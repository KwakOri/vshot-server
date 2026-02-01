import { Router, Request, Response } from 'express';
import { ImageMerger } from '../services/ImageMerger';
import { RoomManager } from '../services/RoomManager';
import { SignalingServer } from '../services/SignalingServer';
import { v4 as uuidv4 } from 'uuid';

export function createPhotoRouter(imageMerger: ImageMerger, roomManager: RoomManager, signalingServer: SignalingServer): Router {
  const router = Router();

  // Upload photo (base64)
  router.post('/upload', async (req: Request, res: Response) => {
    try {
      const { roomId, userId, photoNumber, imageData } = req.body;

      if (!roomId || !userId || photoNumber === undefined || !imageData) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Get room to determine role
      const room = roomManager.getRoom(roomId);
      if (!room) {
        return res.status(404).json({ error: 'Room not found' });
      }

      const role = room.hostId === userId ? 'host' : 'guest';
      const filename = `${roomId}_${role}_${photoNumber}_${uuidv4()}.png`;

      const filePath = await imageMerger.saveBase64Image(imageData, filename);
      const publicUrl = imageMerger.getPublicUrl(filename);

      // Log image data size for debugging
      const base64Length = imageData.replace(/^data:image\/\w+;base64,/, '').length;
      const estimatedSize = (base64Length * 0.75) / 1024 / 1024; // MB
      console.log(`[PhotoAPI] ${role} uploaded photo ${photoNumber} for room ${roomId}:`, {
        filename,
        estimatedSizeMB: estimatedSize.toFixed(2),
        base64Preview: imageData.substring(0, 50) + '...',
      });

      // Update room with uploaded image URL
      roomManager.updatePhotoUrl(roomId, photoNumber, role, publicUrl);

      // Check if ALL photos are now uploaded (based on frame layout settings)
      const expectedPhotoCount = room.frameLayoutSettings?.totalPhotos || 8;
      const allPhotosUploaded = room.capturedPhotos.length === expectedPhotoCount &&
        room.capturedPhotos.every(p => p.hostImageUrl && p.guestImageUrl);

      if (allPhotosUploaded) {
        console.log(`[PhotoAPI] All ${expectedPhotoCount} photos uploaded for room ${roomId}, starting batch merge...`);

        // Merge all photos
        const mergedPhotos: Array<{ photoNumber: number; mergedImageUrl: string }> = [];

        for (const photo of room.capturedPhotos) {
          if (!photo.mergedImageUrl && photo.hostImageUrl && photo.guestImageUrl) {
            try {
              const hostImagePath = imageMerger.getFilePath(photo.hostImageUrl.replace('/uploads/', ''));
              const guestImagePath = imageMerger.getFilePath(photo.guestImageUrl.replace('/uploads/', ''));

              const mergedFilename = `${roomId}_merged_${photo.photoNumber}_${uuidv4()}.png`;
              const mergedPath = imageMerger.getFilePath(mergedFilename);

              await imageMerger.mergeImages(guestImagePath, hostImagePath, mergedPath, {
                layout: 'overlap',
                outputWidth: 1600,  // Match input resolution (2:3 ratio)
                outputHeight: 2400,
              });

              const mergedUrl = imageMerger.getPublicUrl(mergedFilename);
              roomManager.updateMergedPhotoUrl(roomId, photo.photoNumber, mergedUrl);

              mergedPhotos.push({
                photoNumber: photo.photoNumber,
                mergedImageUrl: mergedUrl
              });

              console.log(`[PhotoAPI] Merged photo ${photo.photoNumber} for room ${roomId}`);
            } catch (mergeError) {
              console.error(`[PhotoAPI] Failed to merge photo ${photo.photoNumber}:`, mergeError);
            }
          } else if (photo.mergedImageUrl) {
            mergedPhotos.push({
              photoNumber: photo.photoNumber,
              mergedImageUrl: photo.mergedImageUrl
            });
          }
        }

        // Broadcast merged photos to both clients
        signalingServer.broadcastToRoom(roomId, {
          type: 'photos-merged',
          roomId,
          photos: mergedPhotos
        });

        console.log(`[PhotoAPI] Broadcasted ${mergedPhotos.length} merged photos to room ${roomId}`);
      }

      res.json({
        success: true,
        url: publicUrl,
        photoNumber,
        role
      });
    } catch (error) {
      console.error('[PhotoAPI] Upload error:', error);
      res.status(500).json({ error: 'Failed to upload image' });
    }
  });

  // Merge photos
  router.post('/merge', async (req: Request, res: Response) => {
    try {
      const { roomId, photoNumber, layout = 'overlap' } = req.body;

      if (!roomId || photoNumber === undefined) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const room = roomManager.getRoom(roomId);
      if (!room) {
        return res.status(404).json({ error: 'Room not found' });
      }

      const photo = room.capturedPhotos.find(p => p.photoNumber === photoNumber);
      if (!photo || !photo.hostImageUrl || !photo.guestImageUrl) {
        return res.status(400).json({ error: 'Both images must be uploaded before merging' });
      }

      const hostImagePath = imageMerger.getFilePath(photo.hostImageUrl.replace('/uploads/', ''));
      const guestImagePath = imageMerger.getFilePath(photo.guestImageUrl.replace('/uploads/', ''));

      const mergedFilename = `${roomId}_merged_${photoNumber}_${uuidv4()}.png`;
      const mergedPath = imageMerger.getFilePath(mergedFilename);

      await imageMerger.mergeImages(guestImagePath, hostImagePath, mergedPath, {
        layout,
        outputWidth: 1600,  // Match input resolution (2:3 ratio)
        outputHeight: 2400,
      });

      const publicUrl = imageMerger.getPublicUrl(mergedFilename);
      roomManager.updateMergedPhotoUrl(roomId, photoNumber, publicUrl);

      console.log(`[PhotoAPI] Merged photo ${photoNumber} for room ${roomId}`);

      res.json({
        success: true,
        url: publicUrl,
        photoNumber
      });
    } catch (error) {
      console.error('[PhotoAPI] Merge error:', error);
      res.status(500).json({ error: 'Failed to merge images' });
    }
  });

  // Get room photos
  router.get('/room/:roomId', (req: Request, res: Response) => {
    try {
      const { roomId } = req.params;

      const room = roomManager.getRoom(roomId);
      if (!room) {
        return res.status(404).json({ error: 'Room not found' });
      }

      res.json({
        success: true,
        photos: room.capturedPhotos,
        selectedPhotos: room.selectedPhotos
      });
    } catch (error) {
      console.error('[PhotoAPI] Get photos error:', error);
      res.status(500).json({ error: 'Failed to get photos' });
    }
  });

  return router;
}
