import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { VideoConverter } from '../services/VideoConverter';

const router = Router();

// Configure multer for video upload
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(process.cwd(), 'uploads', 'temp');
    await fs.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    cb(null, `temp-${uniqueSuffix}.mp4`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'video/mp4' || file.mimetype === 'video/webm') {
      cb(null, true);
    } else {
      cb(new Error('Only MP4 and WebM files are allowed'));
    }
  },
});

/**
 * POST /api/video/postprocess
 * Re-encode MP4 for maximum QuickTime compatibility
 */
router.post('/postprocess', upload.single('video'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    console.log('[VideoPostProcess] Received file:', req.file.filename);

    const tempPath = req.file.path;
    const outputDir = path.join(process.cwd(), 'uploads', 'videos');
    const outputFilename = `postprocessed-${Date.now()}.mp4`;

    // Initialize converter
    const converter = new VideoConverter(outputDir);

    // Re-encode for QuickTime compatibility
    const outputPath = await converter.convertToMP4(
      tempPath,
      outputFilename,
      (progress) => {
        console.log(`[VideoPostProcess] Progress: ${progress.percent}%`);
      }
    );

    // Delete temp file
    await converter.deleteTempFile(tempPath);

    // Return download URL
    const downloadUrl = `/uploads/videos/${outputFilename}`;

    console.log('[VideoPostProcess] Completed:', downloadUrl);

    res.json({
      success: true,
      url: downloadUrl,
      filename: outputFilename,
    });

  } catch (error) {
    console.error('[VideoPostProcess] Error:', error);

    // Clean up temp file on error
    if (req.file?.path) {
      try {
        await fs.unlink(req.file.path);
      } catch (unlinkError) {
        console.error('[VideoPostProcess] Failed to clean up temp file:', unlinkError);
      }
    }

    res.status(500).json({
      error: 'Video post-processing failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
