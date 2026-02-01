import { Router, Request, Response } from 'express';
import { VideoComposer, FRAME_LAYOUTS } from '../services/VideoComposer';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import type { SignalingServer } from '../services/SignalingServer';
import type { RoomManager } from '../services/RoomManager';
import type { UploadedSegment } from '../types/signal';

/**
 * Video V2 Router — Production FFmpeg video composition endpoint.
 *
 * Receives multiple video segment files (multipart),
 * composes them via VideoComposer (FFmpeg), saves output to uploads/videos/,
 * and broadcasts the result to the room via signaling.
 *
 * New endpoints:
 * - POST /upload-segment: Upload individual segment immediately after recording
 * - POST /compose-from-uploaded: Compose video from already uploaded segments
 */

// Configure multer for video upload (max 100MB per file)
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadPath = path.join(__dirname, '../../uploads/videos');
    await fs.mkdir(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.webm';
    const uniqueName = `v2-${uuidv4()}-${Date.now()}${ext}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB per file
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['video/mp4', 'video/webm', 'video/x-matroska', 'application/octet-stream'];
    const allowedExtensions = ['.mp4', '.webm', '.mkv'];

    const hasValidMime = allowedMimes.includes(file.mimetype);
    const hasValidExtension = allowedExtensions.some(ext =>
      file.originalname.toLowerCase().endsWith(ext)
    );

    if (hasValidMime || hasValidExtension) {
      cb(null, true);
    } else {
      cb(new Error('Only MP4 and WebM videos are allowed'));
    }
  },
});

export function createVideoV2Router(signalingServer: SignalingServer, roomManager: RoomManager): Router {
  const router = Router();

  /**
   * Compose multiple video segments into a single framed video.
   * POST /api/video-v2/compose
   *
   * Form fields:
   *   videos   – multiple video files (multipart)
   *   layoutId – frame layout id (e.g. '4cut-grid')
   *   roomId   – room identifier
   *   userId   – uploader identifier
   */
  router.post('/compose', upload.array('videos', 8), async (req: Request, res: Response) => {
    const startTime = Date.now();
    const uploadedFiles: string[] = [];

    try {
      const files = req.files as Express.Multer.File[];

      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No video files provided' });
      }

      const { layoutId = '4cut-grid', roomId, userId } = req.body;

      if (!roomId || !userId) {
        for (const file of files) {
          await fs.unlink(file.path).catch(() => {});
        }
        return res.status(400).json({ error: 'roomId and userId are required' });
      }

      // Validate layout
      const layout = FRAME_LAYOUTS[layoutId];
      if (!layout) {
        for (const file of files) {
          await fs.unlink(file.path).catch(() => {});
        }
        return res.status(400).json({
          error: 'Invalid layout ID',
          availableLayouts: Object.keys(FRAME_LAYOUTS),
        });
      }

      // Validate video count matches layout
      if (files.length !== layout.slotCount) {
        for (const file of files) {
          await fs.unlink(file.path).catch(() => {});
        }
        return res.status(400).json({
          error: `Layout ${layoutId} requires ${layout.slotCount} videos, got ${files.length}`,
        });
      }

      const uploadTime = Date.now() - startTime;

      for (const file of files) {
        uploadedFiles.push(file.path);
      }

      const totalInputSize = files.reduce((sum, f) => sum + f.size, 0);

      console.log('[VideoV2] Compose started:', {
        layoutId,
        roomId,
        userId,
        videoCount: files.length,
        totalInputSizeMB: (totalInputSize / 1024 / 1024).toFixed(2),
      });

      // VideoComposer outputs to uploads/videos/ (production path)
      const composer = new VideoComposer(path.join(__dirname, '../../uploads/videos'));

      const composeStart = Date.now();
      const result = await composer.compose(
        uploadedFiles,
        {
          layout,
          outputFormat: 'mp4',
          frameRate: 24,
          quality: 23,
        },
        (progress) => {
          console.log(`[VideoV2] Compose progress: ${progress.percent}% - ${progress.stage}`);
        },
      );
      const composeTime = Date.now() - composeStart;

      // Clean up input files
      await composer.cleanup(uploadedFiles);

      // Build the correct public URL.
      // VideoComposer hardcodes outputUrl as /uploads/test/..., so we derive it
      // from the actual outputPath instead.
      const outputFilename = path.basename(result.outputPath);
      const videoUrl = `/uploads/videos/${outputFilename}`;

      const totalTime = Date.now() - startTime;

      console.log('[VideoV2] Compose complete:', {
        layoutId,
        roomId,
        outputSizeMB: (result.fileSize / 1024 / 1024).toFixed(2),
        duration: `${result.duration.toFixed(2)}s`,
        composeTimeMs: composeTime,
        totalTimeMs: totalTime,
      });

      // Broadcast to room via signaling
      signalingServer.broadcastToRoom(roomId, {
        type: 'video-frame-ready',
        roomId,
        fromUserId: userId,
        videoUrl,
        fileSize: result.fileSize,
      });

      res.json({
        success: true,
        videoUrl,
        timing: {
          uploadTimeMs: uploadTime,
          composeTimeMs: composeTime,
          totalTimeMs: totalTime,
          serverTiming: result.timing,
        },
        fileInfo: {
          inputCount: files.length,
          inputTotalSizeMB: parseFloat((totalInputSize / 1024 / 1024).toFixed(2)),
          outputSizeMB: parseFloat((result.fileSize / 1024 / 1024).toFixed(2)),
          duration: parseFloat(result.duration.toFixed(2)),
        },
        layout: {
          id: layoutId,
          label: layout.label,
          slotCount: layout.slotCount,
          canvasSize: `${layout.canvasWidth}x${layout.canvasHeight}`,
        },
      });
    } catch (error) {
      const totalTime = Date.now() - startTime;
      console.error('[VideoV2] Compose error:', error);

      for (const filePath of uploadedFiles) {
        await fs.unlink(filePath).catch(() => {});
      }

      res.status(500).json({
        error: 'Failed to compose videos',
        details: error instanceof Error ? error.message : 'Unknown error',
        timing: { totalTimeMs: totalTime },
      });
    }
  });

  /**
   * Upload a single video segment immediately after recording.
   * POST /api/video-v2/upload-segment
   *
   * Form fields:
   *   video       – single video file (multipart)
   *   roomId      – room identifier
   *   userId      – uploader identifier
   *   photoNumber – photo number (1-based, 1-8)
   */
  router.post('/upload-segment', upload.single('video'), async (req: Request, res: Response) => {
    const startTime = Date.now();

    try {
      const file = req.file;

      if (!file) {
        return res.status(400).json({ error: 'No video file provided' });
      }

      const { roomId, userId, photoNumber: photoNumberStr } = req.body;
      const photoNumber = parseInt(photoNumberStr, 10);

      if (!roomId || !userId || isNaN(photoNumber)) {
        await fs.unlink(file.path).catch(() => {});
        return res.status(400).json({ error: 'roomId, userId, and photoNumber are required' });
      }

      if (photoNumber < 1 || photoNumber > 8) {
        await fs.unlink(file.path).catch(() => {});
        return res.status(400).json({ error: 'photoNumber must be between 1 and 8' });
      }

      // Check if room exists
      const room = roomManager.getRoom(roomId);
      if (!room) {
        await fs.unlink(file.path).catch(() => {});
        return res.status(404).json({ error: 'Room not found' });
      }

      // Create segment record
      const segment: UploadedSegment = {
        photoNumber,
        filename: file.filename,
        filePath: file.path,
        fileSize: file.size,
        uploadedAt: new Date(),
        userId,
      };

      // Save to RoomManager
      roomManager.addUploadedSegment(roomId, segment);

      const uploadTime = Date.now() - startTime;

      console.log('[VideoV2] Segment uploaded:', {
        roomId,
        userId,
        photoNumber,
        filename: file.filename,
        sizeMB: (file.size / 1024 / 1024).toFixed(2),
        uploadTimeMs: uploadTime,
      });

      // Broadcast segment-uploaded to room
      signalingServer.broadcastToRoom(roomId, {
        type: 'segment-uploaded',
        roomId,
        photoNumber,
        filename: file.filename,
        userId,
      });

      // Check if all 8 segments are uploaded
      const uploadedSegments = roomManager.getUploadedSegments(roomId);
      if (uploadedSegments.length === 8) {
        signalingServer.broadcastToRoom(roomId, {
          type: 'all-segments-uploaded',
          roomId,
          segmentCount: 8,
        });
        console.log('[VideoV2] All 8 segments uploaded for room:', roomId);
      }

      res.json({
        success: true,
        photoNumber,
        filename: file.filename,
        fileSize: file.size,
        uploadTimeMs: uploadTime,
        totalUploaded: uploadedSegments.length,
      });
    } catch (error) {
      console.error('[VideoV2] Segment upload error:', error);
      res.status(500).json({
        error: 'Failed to upload segment',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * Compose video from already uploaded segments.
   * POST /api/video-v2/compose-from-uploaded
   *
   * JSON body:
   *   roomId              – room identifier
   *   userId              – requester identifier
   *   layoutId            – frame layout id (e.g. '4cut-grid')
   *   selectedPhotoNumbers – array of photo numbers to compose (1-based, e.g. [1, 3, 5, 7])
   */
  router.post('/compose-from-uploaded', async (req: Request, res: Response) => {
    const startTime = Date.now();

    try {
      const { roomId, userId, layoutId = '4cut-grid', selectedPhotoNumbers } = req.body;

      if (!roomId || !userId || !selectedPhotoNumbers) {
        return res.status(400).json({ error: 'roomId, userId, and selectedPhotoNumbers are required' });
      }

      if (!Array.isArray(selectedPhotoNumbers) || selectedPhotoNumbers.length === 0) {
        return res.status(400).json({ error: 'selectedPhotoNumbers must be a non-empty array' });
      }

      // Validate layout
      const layout = FRAME_LAYOUTS[layoutId];
      if (!layout) {
        return res.status(400).json({
          error: 'Invalid layout ID',
          availableLayouts: Object.keys(FRAME_LAYOUTS),
        });
      }

      // Validate selected count matches layout
      if (selectedPhotoNumbers.length !== layout.slotCount) {
        return res.status(400).json({
          error: `Layout ${layoutId} requires ${layout.slotCount} videos, got ${selectedPhotoNumbers.length}`,
        });
      }

      // Get segments from RoomManager
      const segments = roomManager.getSegmentsByPhotoNumbers(roomId, selectedPhotoNumbers);

      if (segments.length !== selectedPhotoNumbers.length) {
        const foundNumbers = segments.map(s => s.photoNumber);
        const missingNumbers = selectedPhotoNumbers.filter((n: number) => !foundNumbers.includes(n));
        return res.status(400).json({
          error: 'Some segments not found',
          missingPhotoNumbers: missingNumbers,
          foundPhotoNumbers: foundNumbers,
        });
      }

      // Sort segments by the order in selectedPhotoNumbers
      const sortedSegments = selectedPhotoNumbers.map((num: number) =>
        segments.find(s => s.photoNumber === num)!
      );

      const inputFiles = sortedSegments.map(s => s.filePath);
      const totalInputSize = sortedSegments.reduce((sum, s) => sum + s.fileSize, 0);

      console.log('[VideoV2] Compose from uploaded started:', {
        layoutId,
        roomId,
        userId,
        selectedPhotoNumbers,
        totalInputSizeMB: (totalInputSize / 1024 / 1024).toFixed(2),
      });

      // VideoComposer outputs to uploads/videos/
      const composer = new VideoComposer(path.join(__dirname, '../../uploads/videos'));

      const composeStart = Date.now();
      const result = await composer.compose(
        inputFiles,
        {
          layout,
          outputFormat: 'mp4',
          frameRate: 24,
          quality: 23,
        },
        (progress) => {
          console.log(`[VideoV2] Compose progress: ${progress.percent}% - ${progress.stage}`);
        },
      );
      const composeTime = Date.now() - composeStart;

      // NOTE: Do NOT cleanup input files since they are reusable uploaded segments

      const outputFilename = path.basename(result.outputPath);
      const videoUrl = `/uploads/videos/${outputFilename}`;

      const totalTime = Date.now() - startTime;

      console.log('[VideoV2] Compose from uploaded complete:', {
        layoutId,
        roomId,
        outputSizeMB: (result.fileSize / 1024 / 1024).toFixed(2),
        duration: `${result.duration.toFixed(2)}s`,
        composeTimeMs: composeTime,
        totalTimeMs: totalTime,
      });

      // Broadcast to room via signaling
      signalingServer.broadcastToRoom(roomId, {
        type: 'video-frame-ready',
        roomId,
        fromUserId: userId,
        videoUrl,
        fileSize: result.fileSize,
      });

      res.json({
        success: true,
        videoUrl,
        timing: {
          composeTimeMs: composeTime,
          totalTimeMs: totalTime,
          serverTiming: result.timing,
        },
        fileInfo: {
          inputCount: sortedSegments.length,
          inputTotalSizeMB: parseFloat((totalInputSize / 1024 / 1024).toFixed(2)),
          outputSizeMB: parseFloat((result.fileSize / 1024 / 1024).toFixed(2)),
          duration: parseFloat(result.duration.toFixed(2)),
        },
        layout: {
          id: layoutId,
          label: layout.label,
          slotCount: layout.slotCount,
          canvasSize: `${layout.canvasWidth}x${layout.canvasHeight}`,
        },
      });
    } catch (error) {
      const totalTime = Date.now() - startTime;
      console.error('[VideoV2] Compose from uploaded error:', error);

      res.status(500).json({
        error: 'Failed to compose videos',
        details: error instanceof Error ? error.message : 'Unknown error',
        timing: { totalTimeMs: totalTime },
      });
    }
  });

  /**
   * Clear uploaded segments for a room (for starting a new capture session).
   * POST /api/video-v2/clear-segments
   *
   * JSON body:
   *   roomId – room identifier
   */
  router.post('/clear-segments', async (req: Request, res: Response) => {
    try {
      const { roomId } = req.body;

      if (!roomId) {
        return res.status(400).json({ error: 'roomId is required' });
      }

      // Get existing segments to cleanup files
      const segments = roomManager.getUploadedSegments(roomId);

      // Delete files
      for (const segment of segments) {
        await fs.unlink(segment.filePath).catch(() => {});
      }

      // Clear from RoomManager
      roomManager.clearUploadedSegments(roomId);

      console.log('[VideoV2] Segments cleared for room:', roomId, 'count:', segments.length);

      res.json({
        success: true,
        clearedCount: segments.length,
      });
    } catch (error) {
      console.error('[VideoV2] Clear segments error:', error);
      res.status(500).json({
        error: 'Failed to clear segments',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
