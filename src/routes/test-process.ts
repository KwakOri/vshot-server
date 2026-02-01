import { Router, Request, Response } from 'express';
import { ImageMerger } from '../services/ImageMerger';
import { VideoConverter } from '../services/VideoConverter';
import { VideoComposer, FRAME_LAYOUTS } from '../services/VideoComposer';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';

/**
 * Test Process Router
 *
 * 테스트용 API 엔드포인트. RoomManager 없이 독립적으로 동작하며,
 * 서버의 사진/영상 처리 성능을 테스트할 수 있습니다.
 *
 * 기존 /api/photo, /api/video API에 영향을 주지 않습니다.
 */

// Configure multer for video upload (max 100MB)
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadPath = path.join(__dirname, '../../uploads/test');
    await fs.mkdir(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.webm';
    const uniqueName = `test-${uuidv4()}-${Date.now()}${ext}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB
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
  }
});

export function createTestProcessRouter(imageMerger: ImageMerger): Router {
  const router = Router();

  /**
   * 단일 사진 처리 테스트
   * POST /api/test/photo-single
   *
   * Host 사진 하나만 받아서 저장하고 처리 시간 측정
   */
  router.post('/photo-single', async (req: Request, res: Response) => {
    const startTime = Date.now();

    try {
      const { imageData, photoNumber = 1 } = req.body;

      if (!imageData) {
        return res.status(400).json({ error: 'imageData is required' });
      }

      const testId = uuidv4().slice(0, 8);
      const filename = `test_${testId}_photo_${photoNumber}_${Date.now()}.png`;

      // 이미지 저장
      const saveStart = Date.now();
      const filePath = await imageMerger.saveBase64Image(imageData, filename);
      const saveTime = Date.now() - saveStart;

      const publicUrl = imageMerger.getPublicUrl(filename);
      const totalTime = Date.now() - startTime;

      // 파일 크기 계산
      const base64Length = imageData.replace(/^data:image\/\w+;base64,/, '').length;
      const estimatedSizeMB = (base64Length * 0.75) / 1024 / 1024;

      console.log(`[TestAPI] Photo saved:`, {
        testId,
        filename,
        sizeMB: estimatedSizeMB.toFixed(2),
        saveTimeMs: saveTime,
        totalTimeMs: totalTime,
      });

      res.json({
        success: true,
        testId,
        url: publicUrl,
        photoNumber,
        timing: {
          saveTimeMs: saveTime,
          totalTimeMs: totalTime,
        },
        fileInfo: {
          filename,
          estimatedSizeMB: parseFloat(estimatedSizeMB.toFixed(2)),
        }
      });

    } catch (error) {
      const totalTime = Date.now() - startTime;
      console.error('[TestAPI] Photo single error:', error);
      res.status(500).json({
        error: 'Failed to process photo',
        details: error instanceof Error ? error.message : 'Unknown error',
        timing: { totalTimeMs: totalTime }
      });
    }
  });

  /**
   * 여러 사진 배치 처리 테스트
   * POST /api/test/photo-batch
   *
   * 여러 장의 Host 사진을 받아서 저장하고 처리 시간 측정
   */
  router.post('/photo-batch', async (req: Request, res: Response) => {
    const startTime = Date.now();

    try {
      const { images } = req.body;

      if (!images || !Array.isArray(images) || images.length === 0) {
        return res.status(400).json({ error: 'images array is required' });
      }

      const testId = uuidv4().slice(0, 8);
      const results: Array<{
        photoNumber: number;
        url: string;
        saveTimeMs: number;
        sizeMB: number;
      }> = [];

      for (let i = 0; i < images.length; i++) {
        const imageData = images[i];
        const photoNumber = i + 1;
        const filename = `test_${testId}_batch_${photoNumber}_${Date.now()}.png`;

        const saveStart = Date.now();
        await imageMerger.saveBase64Image(imageData, filename);
        const saveTime = Date.now() - saveStart;

        const publicUrl = imageMerger.getPublicUrl(filename);

        const base64Length = imageData.replace(/^data:image\/\w+;base64,/, '').length;
        const sizeMB = (base64Length * 0.75) / 1024 / 1024;

        results.push({
          photoNumber,
          url: publicUrl,
          saveTimeMs: saveTime,
          sizeMB: parseFloat(sizeMB.toFixed(2)),
        });
      }

      const totalTime = Date.now() - startTime;
      const avgSaveTime = results.reduce((sum, r) => sum + r.saveTimeMs, 0) / results.length;

      console.log(`[TestAPI] Batch photos saved:`, {
        testId,
        count: results.length,
        avgSaveTimeMs: avgSaveTime.toFixed(0),
        totalTimeMs: totalTime,
      });

      res.json({
        success: true,
        testId,
        photos: results,
        timing: {
          totalTimeMs: totalTime,
          avgSaveTimeMs: parseFloat(avgSaveTime.toFixed(0)),
          perPhotoTimeMs: results.map(r => r.saveTimeMs),
        },
        summary: {
          totalPhotos: results.length,
          totalSizeMB: parseFloat(results.reduce((sum, r) => sum + r.sizeMB, 0).toFixed(2)),
        }
      });

    } catch (error) {
      const totalTime = Date.now() - startTime;
      console.error('[TestAPI] Photo batch error:', error);
      res.status(500).json({
        error: 'Failed to process photos',
        details: error instanceof Error ? error.message : 'Unknown error',
        timing: { totalTimeMs: totalTime }
      });
    }
  });

  /**
   * 사진 합성 테스트 (dummy guest 이미지 사용)
   * POST /api/test/photo-merge
   *
   * Host 사진과 dummy guest 이미지(투명 또는 흰색 배경)를 합성
   */
  router.post('/photo-merge', async (req: Request, res: Response) => {
    const startTime = Date.now();

    try {
      const { hostImageData, guestImageData, layout = 'overlap', outputWidth = 1600, outputHeight = 2400 } = req.body;

      if (!hostImageData) {
        return res.status(400).json({ error: 'hostImageData is required' });
      }

      const testId = uuidv4().slice(0, 8);

      // Host 이미지 저장
      const hostFilename = `test_${testId}_host_${Date.now()}.png`;
      const hostSaveStart = Date.now();
      const hostPath = await imageMerger.saveBase64Image(hostImageData, hostFilename);
      const hostSaveTime = Date.now() - hostSaveStart;

      let guestPath: string;
      let guestSaveTime = 0;

      if (guestImageData) {
        // Guest 이미지가 제공된 경우
        const guestFilename = `test_${testId}_guest_${Date.now()}.png`;
        const guestSaveStart = Date.now();
        guestPath = await imageMerger.saveBase64Image(guestImageData, guestFilename);
        guestSaveTime = Date.now() - guestSaveStart;
      } else {
        // Guest 이미지가 없으면 Host 이미지를 그대로 사용 (자기 자신과 합성)
        guestPath = hostPath;
      }

      // 합성
      const mergeStart = Date.now();
      const mergedFilename = `test_${testId}_merged_${Date.now()}.png`;
      const mergedPath = imageMerger.getFilePath(mergedFilename);

      await imageMerger.mergeImages(guestPath, hostPath, mergedPath, {
        layout,
        outputWidth,
        outputHeight,
      });
      const mergeTime = Date.now() - mergeStart;

      const mergedUrl = imageMerger.getPublicUrl(mergedFilename);
      const totalTime = Date.now() - startTime;

      console.log(`[TestAPI] Photo merge complete:`, {
        testId,
        layout,
        outputSize: `${outputWidth}x${outputHeight}`,
        hostSaveTimeMs: hostSaveTime,
        guestSaveTimeMs: guestSaveTime,
        mergeTimeMs: mergeTime,
        totalTimeMs: totalTime,
      });

      res.json({
        success: true,
        testId,
        mergedUrl,
        timing: {
          hostSaveTimeMs: hostSaveTime,
          guestSaveTimeMs: guestSaveTime,
          mergeTimeMs: mergeTime,
          totalTimeMs: totalTime,
        },
        options: {
          layout,
          outputWidth,
          outputHeight,
        }
      });

    } catch (error) {
      const totalTime = Date.now() - startTime;
      console.error('[TestAPI] Photo merge error:', error);
      res.status(500).json({
        error: 'Failed to merge photos',
        details: error instanceof Error ? error.message : 'Unknown error',
        timing: { totalTimeMs: totalTime }
      });
    }
  });

  /**
   * 영상 업로드 테스트
   * POST /api/test/video-upload
   *
   * 영상 파일을 업로드하고 처리 시간 측정
   */
  router.post('/video-upload', upload.single('video'), async (req: Request, res: Response) => {
    const startTime = Date.now();

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No video file provided' });
      }

      const testId = uuidv4().slice(0, 8);
      const videoUrl = `/uploads/test/${req.file.filename}`;
      const totalTime = Date.now() - startTime;
      const sizeMB = req.file.size / 1024 / 1024;

      console.log(`[TestAPI] Video uploaded:`, {
        testId,
        filename: req.file.filename,
        sizeMB: sizeMB.toFixed(2),
        totalTimeMs: totalTime,
      });

      res.json({
        success: true,
        testId,
        videoUrl,
        timing: {
          uploadTimeMs: totalTime,
        },
        fileInfo: {
          filename: req.file.filename,
          sizeMB: parseFloat(sizeMB.toFixed(2)),
          mimetype: req.file.mimetype,
        }
      });

    } catch (error) {
      const totalTime = Date.now() - startTime;
      console.error('[TestAPI] Video upload error:', error);
      res.status(500).json({
        error: 'Failed to upload video',
        details: error instanceof Error ? error.message : 'Unknown error',
        timing: { totalTimeMs: totalTime }
      });
    }
  });

  /**
   * 영상 변환 테스트 (WebM -> MP4)
   * POST /api/test/video-convert
   *
   * 영상 파일을 업로드하고 MP4로 변환
   */
  router.post('/video-convert', upload.single('video'), async (req: Request, res: Response) => {
    const startTime = Date.now();
    let tempPath: string | undefined;

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No video file provided' });
      }

      tempPath = req.file.path;
      const testId = uuidv4().slice(0, 8);
      const uploadTime = Date.now() - startTime;

      // 변환
      const convertStart = Date.now();
      const outputFilename = `test-${testId}-converted-${Date.now()}.mp4`;
      const converter = new VideoConverter(path.join(__dirname, '../../uploads/test'));

      const outputPath = await converter.convertToMP4(
        tempPath,
        outputFilename,
        (progress) => {
          console.log(`[TestAPI] Convert progress: ${progress.percent}%`);
        }
      );
      const convertTime = Date.now() - convertStart;

      // 파일 정보
      const stats = await fs.stat(outputPath);
      const inputSizeMB = req.file.size / 1024 / 1024;
      const outputSizeMB = stats.size / 1024 / 1024;

      // 원본 파일 삭제
      await converter.deleteTempFile(tempPath);

      const totalTime = Date.now() - startTime;

      console.log(`[TestAPI] Video converted:`, {
        testId,
        inputSizeMB: inputSizeMB.toFixed(2),
        outputSizeMB: outputSizeMB.toFixed(2),
        convertTimeMs: convertTime,
        totalTimeMs: totalTime,
      });

      res.json({
        success: true,
        testId,
        mp4Url: `/uploads/test/${outputFilename}`,
        timing: {
          uploadTimeMs: uploadTime,
          convertTimeMs: convertTime,
          totalTimeMs: totalTime,
        },
        fileInfo: {
          inputSizeMB: parseFloat(inputSizeMB.toFixed(2)),
          outputSizeMB: parseFloat(outputSizeMB.toFixed(2)),
          compressionRatio: ((1 - outputSizeMB / inputSizeMB) * 100).toFixed(1) + '%',
        }
      });

    } catch (error) {
      const totalTime = Date.now() - startTime;
      console.error('[TestAPI] Video convert error:', error);

      // 임시 파일 정리
      if (tempPath) {
        try {
          await fs.unlink(tempPath);
        } catch (e) {
          // ignore
        }
      }

      res.status(500).json({
        error: 'Failed to convert video',
        details: error instanceof Error ? error.message : 'Unknown error',
        timing: { totalTimeMs: totalTime }
      });
    }
  });

  /**
   * 영상 합성 테스트 (서버 측 FFmpeg 합성)
   * POST /api/test/video-compose
   *
   * 여러 영상 파일을 업로드하고 프레임 레이아웃으로 합성
   */
  router.post('/video-compose', upload.array('videos', 8), async (req: Request, res: Response) => {
    const startTime = Date.now();
    const uploadedFiles: string[] = [];

    try {
      const files = req.files as Express.Multer.File[];

      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No video files provided' });
      }

      const { layoutId = '4cut-grid' } = req.body;

      // Get layout configuration
      const layout = FRAME_LAYOUTS[layoutId];
      if (!layout) {
        // Clean up uploaded files
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
        // Clean up uploaded files
        for (const file of files) {
          await fs.unlink(file.path).catch(() => {});
        }
        return res.status(400).json({
          error: `Layout ${layoutId} requires ${layout.slotCount} videos, got ${files.length}`,
        });
      }

      const testId = uuidv4().slice(0, 8);
      const uploadTime = Date.now() - startTime;

      // Collect uploaded file paths
      for (const file of files) {
        uploadedFiles.push(file.path);
      }

      const totalInputSize = files.reduce((sum, f) => sum + f.size, 0);

      console.log(`[TestAPI] Video compose started:`, {
        testId,
        layoutId,
        videoCount: files.length,
        totalInputSizeMB: (totalInputSize / 1024 / 1024).toFixed(2),
      });

      // Initialize VideoComposer
      const composer = new VideoComposer(path.join(__dirname, '../../uploads/test'));

      // Compose videos
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
          console.log(`[TestAPI] Compose progress: ${progress.percent}% - ${progress.stage}`);
        }
      );
      const composeTime = Date.now() - composeStart;

      // Clean up input files
      await composer.cleanup(uploadedFiles);

      const totalTime = Date.now() - startTime;

      console.log(`[TestAPI] Video compose complete:`, {
        testId,
        layoutId,
        outputSizeMB: (result.fileSize / 1024 / 1024).toFixed(2),
        duration: `${result.duration.toFixed(2)}s`,
        composeTimeMs: composeTime,
        totalTimeMs: totalTime,
      });

      res.json({
        success: true,
        testId,
        videoUrl: result.outputUrl,
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
      console.error('[TestAPI] Video compose error:', error);

      // Clean up uploaded files on error
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
   * 사용 가능한 레이아웃 목록 조회
   * GET /api/test/layouts
   */
  router.get('/layouts', (req: Request, res: Response) => {
    const layouts = Object.values(FRAME_LAYOUTS).map(layout => ({
      id: layout.id,
      label: layout.label,
      slotCount: layout.slotCount,
      canvasSize: `${layout.canvasWidth}x${layout.canvasHeight}`,
    }));

    res.json({
      success: true,
      layouts,
    });
  });

  /**
   * 테스트 파일 정리
   * DELETE /api/test/cleanup
   *
   * 테스트 폴더의 모든 파일 삭제
   */
  router.delete('/cleanup', async (req: Request, res: Response) => {
    try {
      const testDir = path.join(__dirname, '../../uploads/test');

      try {
        const files = await fs.readdir(testDir);
        let deletedCount = 0;

        for (const file of files) {
          await fs.unlink(path.join(testDir, file));
          deletedCount++;
        }

        console.log(`[TestAPI] Cleanup complete: ${deletedCount} files deleted`);

        res.json({
          success: true,
          deletedFiles: deletedCount,
        });
      } catch (error) {
        // 폴더가 없으면 무시
        res.json({
          success: true,
          deletedFiles: 0,
          message: 'No test files to clean up',
        });
      }

    } catch (error) {
      console.error('[TestAPI] Cleanup error:', error);
      res.status(500).json({
        error: 'Failed to cleanup test files',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
