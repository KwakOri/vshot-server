import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import type { SignalingServer } from '../services/SignalingServer';
import { VideoConverter } from '../services/VideoConverter';

const router = express.Router();

// Configure multer for video upload (max 100MB)
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadPath = path.join(__dirname, '../../uploads/videos');
    await fs.mkdir(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    // Determine extension from original filename or default to webm
    const ext = path.extname(file.originalname).toLowerCase() || '.webm';
    const uniqueName = `${uuidv4()}-${Date.now()}${ext}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB
  },
  fileFilter: (req, file, cb) => {
    console.log('[Video] Upload file mimetype:', file.mimetype);
    console.log('[Video] Upload file originalname:', file.originalname);

    // Accept video files by MIME type or extension
    const allowedMimes = ['video/mp4', 'video/webm', 'video/x-matroska', 'application/octet-stream'];
    const allowedExtensions = ['.mp4', '.webm', '.mkv'];

    const hasValidMime = allowedMimes.includes(file.mimetype);
    const hasValidExtension = allowedExtensions.some(ext =>
      file.originalname.toLowerCase().endsWith(ext)
    );

    if (hasValidMime || hasValidExtension) {
      cb(null, true);
    } else {
      console.error('[Video] Invalid file type:', {
        mimetype: file.mimetype,
        originalname: file.originalname
      });
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

      // Determine Content-Type based on file extension
      const ext = path.extname(filename).toLowerCase();
      const contentType = ext === '.webm' ? 'video/webm' : 'video/mp4';

      // Set proper headers for Mac compatibility
      res.setHeader('Content-Type', contentType);
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

  /**
   * Convert WebM to MP4
   * POST /api/video/convert
   * Body: multipart/form-data with 'video' field (WebM file)
   */
  router.post('/convert', upload.single('video'), async (req, res) => {
    let tempWebMPath: string | undefined;
    let outputMP4Path: string | undefined;

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No video file provided' });
      }

      tempWebMPath = req.file.path;
      const outputFilename = `${uuidv4()}-${Date.now()}.mp4`;

      console.log('[Video] Converting WebM to MP4...');
      console.log('[Video] Input:', tempWebMPath);
      console.log('[Video] Input size:', (req.file.size / 1024 / 1024).toFixed(2), 'MB');

      // Initialize VideoConverter
      const converter = new VideoConverter(path.join(__dirname, '../../uploads/videos'));

      // Convert WebM to MP4
      outputMP4Path = await converter.convertToMP4(
        tempWebMPath,
        outputFilename,
        (progress) => {
          console.log(`[Video] Conversion progress: ${progress.percent}% - ${progress.currentTime}`);
        }
      );

      // Get output file stats
      const stats = await fs.stat(outputMP4Path);

      console.log('[Video] Conversion complete!');
      console.log('[Video] Output:', outputMP4Path);
      console.log('[Video] Output size:', (stats.size / 1024 / 1024).toFixed(2), 'MB');

      // Delete temporary WebM file
      await converter.deleteTempFile(tempWebMPath);

      // Return download URL
      const downloadUrl = `/api/video/${outputFilename}`;

      res.json({
        success: true,
        mp4Url: downloadUrl,
        filename: outputFilename,
        size: stats.size,
        originalSize: req.file.size,
        compressionRatio: ((1 - stats.size / req.file.size) * 100).toFixed(1) + '%',
      });

    } catch (error) {
      console.error('[Video] Conversion error:', error);

      // Clean up temp files on error
      if (tempWebMPath) {
        try {
          await fs.unlink(tempWebMPath);
        } catch (err) {
          console.error('[Video] Failed to clean up temp WebM:', err);
        }
      }

      if (outputMP4Path) {
        try {
          await fs.unlink(outputMP4Path);
        } catch (err) {
          console.error('[Video] Failed to clean up temp MP4:', err);
        }
      }

      res.status(500).json({
        error: 'Failed to convert video',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  return router;
}
