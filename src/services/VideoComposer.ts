import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs/promises';
import ffmpegStatic from 'ffmpeg-static';
import { v4 as uuidv4 } from 'uuid';

/**
 * Frame layout position for video placement
 */
export interface FramePosition {
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
}

/**
 * Frame layout configuration
 */
export interface FrameLayout {
  id: string;
  label: string;
  slotCount: number;
  positions: FramePosition[];
  canvasWidth: number;
  canvasHeight: number;
  backgroundColor?: string;
  frameSrc?: string;
}

/**
 * Video composition options
 */
export interface ComposeOptions {
  layout: FrameLayout;
  outputFormat?: 'mp4' | 'webm';
  frameRate?: number;
  quality?: number; // CRF value (18-28, lower = better quality)
}

/**
 * Composition progress callback
 */
export interface ComposeProgress {
  percent: number;
  currentTime: string;
  stage: 'preparing' | 'composing' | 'finalizing';
}

/**
 * Composition result
 */
export interface ComposeResult {
  outputPath: string;
  outputUrl: string;
  duration: number;
  fileSize: number;
  timing: {
    totalMs: number;
    prepareMs: number;
    composeMs: number;
  };
}

/**
 * Video composition resolution (matches client RESOLUTION.VIDEO_WIDTH/HEIGHT)
 * Videos are recorded at this resolution — composition should match.
 * Photo layouts (3000×4500) are for still image capture only.
 */
const VIDEO_WIDTH = 720;
const VIDEO_HEIGHT = 1080;

/**
 * Scale a photo-resolution layout (3000×4500) to video resolution (720×1080)
 * Both share the same 2:3 aspect ratio, so a single scale factor applies.
 */
/** Round down to nearest even number (required for yuv420p) */
function toEven(n: number): number {
  const rounded = Math.round(n);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function scaleLayout(
  id: string,
  label: string,
  slotCount: number,
  photoPositions: FramePosition[],
  photoCanvasWidth: number,
  backgroundColor: string = '#1a1a2e',
  frameSrc?: string,
): FrameLayout {
  const scale = VIDEO_WIDTH / photoCanvasWidth;
  return {
    id,
    label,
    slotCount,
    positions: photoPositions.map((pos) => ({
      x: Math.round(pos.x * scale),
      y: Math.round(pos.y * scale),
      width: toEven(pos.width * scale),
      height: toEven(pos.height * scale),
      zIndex: pos.zIndex,
    })),
    canvasWidth: VIDEO_WIDTH,
    canvasHeight: VIDEO_HEIGHT,
    backgroundColor,
    frameSrc,
  };
}

/**
 * Predefined frame layouts for video composition (720×1080)
 * Scaled from photo layouts (3000×4500) to match recorded video resolution.
 */
export const FRAME_LAYOUTS: Record<string, FrameLayout> = {
  '4cut-grid': scaleLayout('4cut-grid', '인생네컷 (2x2)', 4, [
    { x: 40, y: 40, width: 1450, height: 2200, zIndex: 0 },
    { x: 1510, y: 40, width: 1450, height: 2200, zIndex: 1 },
    { x: 40, y: 2260, width: 1450, height: 2200, zIndex: 2 },
    { x: 1510, y: 2260, width: 1450, height: 2200, zIndex: 3 },
  ], 3000),
  '1cut-polaroid': scaleLayout('1cut-polaroid', '폴라로이드 (단일)', 1, [
    { x: 40, y: 40, width: 2920, height: 4420, zIndex: 0 },
  ], 3000),
  '4cut-quoka': scaleLayout('4cut-quoka', '쿼카 4컷', 4, [
    { x: 153, y: 1068, width: 1280, height: 1520, zIndex: 0 },
    { x: 153, y: 2673, width: 1280, height: 1520, zIndex: 1 },
    { x: 1587, y: 307, width: 1280, height: 1520, zIndex: 2 },
    { x: 1587, y: 1912, width: 1280, height: 1520, zIndex: 3 },
  ], 3000),
};

/**
 * VideoComposer - Server-side video composition using FFmpeg
 *
 * Composes multiple video segments into a single frame layout
 */
export class VideoComposer {
  private outputDir: string;

  constructor(outputDir: string) {
    this.outputDir = outputDir;

    // Set FFmpeg binary path from ffmpeg-static
    if (ffmpegStatic) {
      ffmpeg.setFfmpegPath(ffmpegStatic);
      console.log('[VideoComposer] FFmpeg path set to:', ffmpegStatic);
    } else {
      console.warn('[VideoComposer] ffmpeg-static path not found, using system FFmpeg');
    }
  }

  /**
   * Get layout by ID
   */
  getLayout(layoutId: string): FrameLayout | undefined {
    return FRAME_LAYOUTS[layoutId];
  }

  /**
   * Compose multiple videos into a frame layout
   *
   * @param videoPaths Array of input video file paths (in slot order)
   * @param options Composition options
   * @param onProgress Progress callback
   * @returns Composition result with output path and timing info
   */
  async compose(
    videoPaths: string[],
    options: ComposeOptions,
    onProgress?: (progress: ComposeProgress) => void
  ): Promise<ComposeResult> {
    const startTime = Date.now();
    const { layout, outputFormat = 'mp4', frameRate = 24, quality = 23 } = options;

    // Validate inputs
    if (videoPaths.length !== layout.slotCount) {
      throw new Error(`Expected ${layout.slotCount} videos, got ${videoPaths.length}`);
    }

    // Verify all input files exist
    for (const videoPath of videoPaths) {
      try {
        await fs.access(videoPath);
      } catch {
        throw new Error(`Input video not found: ${videoPath}`);
      }
    }

    // Ensure output directory exists
    await fs.mkdir(this.outputDir, { recursive: true });

    const prepareTime = Date.now();
    onProgress?.({ percent: 5, currentTime: '00:00:00', stage: 'preparing' });

    // Generate output filename
    const outputFilename = `composed-${uuidv4()}-${Date.now()}.${outputFormat}`;
    const outputPath = path.join(this.outputDir, outputFilename);

    console.log('[VideoComposer] Starting composition...');
    console.log('[VideoComposer] Layout:', layout.id, `(${layout.slotCount} slots)`);
    console.log('[VideoComposer] Canvas:', `${layout.canvasWidth}x${layout.canvasHeight}`);
    console.log('[VideoComposer] Inputs:', videoPaths);
    console.log('[VideoComposer] Output:', outputPath);

    // Build FFmpeg filter complex
    const filterComplex = this.buildFilterComplex(layout, videoPaths.length);

    const composeStartTime = Date.now();
    onProgress?.({ percent: 10, currentTime: '00:00:00', stage: 'composing' });

    return new Promise((resolve, reject) => {
      let command = ffmpeg();

      // Add all input videos
      for (const videoPath of videoPaths) {
        command = command.input(videoPath);
      }

      command
        .complexFilter(filterComplex)
        .outputOptions([
          '-map [outv]',
          `-r ${frameRate}`,
          `-crf ${quality}`,
          '-preset fast',
          '-movflags +faststart',
        ])
        .videoCodec('libx264')
        .format(outputFormat === 'mp4' ? 'mp4' : 'webm')
        .on('progress', (progress) => {
          const percent = Math.min(90, 10 + (progress.percent || 0) * 0.8);
          onProgress?.({
            percent: Math.round(percent),
            currentTime: progress.timemark || '00:00:00',
            stage: 'composing',
          });
        })
        .on('end', async () => {
          const endTime = Date.now();
          onProgress?.({ percent: 100, currentTime: '00:00:00', stage: 'finalizing' });

          try {
            const stats = await fs.stat(outputPath);
            const metadata = await this.getVideoMetadata(outputPath);

            const result: ComposeResult = {
              outputPath,
              outputUrl: `/uploads/test/${outputFilename}`,
              duration: metadata.format?.duration || 0,
              fileSize: stats.size,
              timing: {
                totalMs: endTime - startTime,
                prepareMs: composeStartTime - prepareTime,
                composeMs: endTime - composeStartTime,
              },
            };

            console.log('[VideoComposer] Composition complete:', {
              outputPath,
              duration: `${result.duration.toFixed(2)}s`,
              fileSize: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
              totalTime: `${result.timing.totalMs}ms`,
            });

            resolve(result);
          } catch (error) {
            reject(error);
          }
        })
        .on('start', (cmd) => {
          console.log('[VideoComposer] FFmpeg command:', cmd);
        })
        .on('error', (err, stdout, stderr) => {
          console.error('[VideoComposer] Composition failed:', err.message);
          if (stderr) {
            console.error('[VideoComposer] FFmpeg stderr:', stderr);
          }
          reject(new Error(`FFmpeg composition failed: ${err.message}`));
        })
        .save(outputPath);
    });
  }

  /**
   * Build FFmpeg filter complex string for the layout
   */
  private buildFilterComplex(layout: FrameLayout, inputCount: number): string {
    const { canvasWidth, canvasHeight, positions, backgroundColor = '#1a1a2e' } = layout;

    const filters: string[] = [];

    // Create base canvas with background color
    filters.push(
      `color=c=${backgroundColor}:s=${canvasWidth}x${canvasHeight}:d=999[base]`
    );

    // Scale and position each input video
    for (let i = 0; i < inputCount; i++) {
      const pos = positions[i];

      // Scale input to fit position (force_divisible_by=2 prevents yuv420p rounding issues with pad)
      filters.push(
        `[${i}:v]scale=${pos.width}:${pos.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `pad=${pos.width}:${pos.height}:(ow-iw)/2:(oh-ih)/2:color=${backgroundColor}[v${i}]`
      );
    }

    // Overlay each scaled video onto the base canvas
    let currentBase = 'base';
    for (let i = 0; i < inputCount; i++) {
      const pos = positions[i];
      const outputLabel = i === inputCount - 1 ? 'outv' : `tmp${i}`;

      filters.push(
        `[${currentBase}][v${i}]overlay=${pos.x}:${pos.y}:shortest=1[${outputLabel}]`
      );

      currentBase = outputLabel;
    }

    return filters.join(';');
  }

  /**
   * Get video metadata using ffprobe
   */
  private async getVideoMetadata(filePath: string): Promise<any> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          reject(err);
        } else {
          resolve(metadata);
        }
      });
    });
  }

  /**
   * Clean up temporary files
   */
  async cleanup(filePaths: string[]): Promise<void> {
    for (const filePath of filePaths) {
      try {
        await fs.unlink(filePath);
        console.log('[VideoComposer] Deleted temp file:', filePath);
      } catch (error) {
        console.error('[VideoComposer] Failed to delete temp file:', filePath, error);
      }
    }
  }
}
