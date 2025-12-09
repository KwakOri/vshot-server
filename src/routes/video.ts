import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import type { SignalingServer } from '../services/SignalingServer';

const router = express.Router();

// Configure multer for video upload (max 100MB)
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadPath = path.join(__dirname, '../../uploads/videos');
    await fs.mkdir(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}-${Date.now()}.mp4`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['video/mp4', 'video/webm'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only MP4 and WebM videos are allowed'));
    }
  }
});

export function createVideoRouter(signalingServer: SignalingServer) {
  /**
   * Upload video frame
   * POST /api/video/upload
   */
  router.post('/upload', upload.single('video'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No video file provided' });
      }

      const { roomId, userId } = req.body;

      if (!roomId || !userId) {
        // Clean up uploaded file
        await fs.unlink(req.file.path);
        return res.status(400).json({ error: 'roomId and userId are required' });
      }

      const videoUrl = `/uploads/videos/${req.file.filename}`;

      console.log(`[Video] Uploaded: ${req.file.filename} for room ${roomId}`);
      console.log(`[Video] Size: ${(req.file.size / 1024 / 1024).toFixed(2)} MB`);

      // Broadcast video ready to room
      signalingServer.broadcastToRoom(roomId, {
        type: 'video-frame-ready',
        roomId,
        fromUserId: userId,
        videoUrl,
        fileSize: req.file.size,
      });

      res.json({
        success: true,
        videoUrl,
        filename: req.file.filename,
        size: req.file.size,
      });

    } catch (error) {
      console.error('[Video] Upload error:', error);
      res.status(500).json({ error: 'Failed to upload video' });
    }
  });

  /**
   * Download video
   * GET /api/video/:filename
   */
  router.get('/:filename', async (req, res) => {
    try {
      const { filename } = req.params;

      // Validate filename (prevent directory traversal)
      if (filename.includes('..') || filename.includes('/')) {
        return res.status(400).json({ error: 'Invalid filename' });
      }

      const videoPath = path.join(__dirname, '../../uploads/videos', filename);

      // Check if file exists
      let stats;
      try {
        stats = await fs.stat(videoPath);
      } catch {
        return res.status(404).json({ error: 'Video not found' });
      }

      // Set proper headers for Mac compatibility
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=0');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      console.log(`[Video] Serving ${filename} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

      // Stream the video file
      res.sendFile(videoPath);

    } catch (error) {
      console.error('[Video] Download error:', error);
      res.status(500).json({ error: 'Failed to download video' });
    }
  });

  return router;
}
