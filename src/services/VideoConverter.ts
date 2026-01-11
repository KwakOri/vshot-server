import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs/promises';
import ffmpegStatic from 'ffmpeg-static';

export interface ConversionProgress {
  percent: number;
  currentTime: string;
  targetSize: string;
}

export class VideoConverter {
  private outputDir: string;

  constructor(outputDir: string) {
    this.outputDir = outputDir;

    // Set FFmpeg binary path from ffmpeg-static
    if (ffmpegStatic) {
      ffmpeg.setFfmpegPath(ffmpegStatic);
      console.log('[VideoConverter] FFmpeg path set to:', ffmpegStatic);
    } else {
      console.warn('[VideoConverter] ffmpeg-static path not found, using system FFmpeg');
    }
  }

  /**
   * Convert WebM to MP4 using FFmpeg
   * @param inputPath Path to input WebM file
   * @param outputFilename Desired output filename (e.g., "video.mp4")
   * @param onProgress Progress callback
   * @returns Path to converted MP4 file
   */
  async convertToMP4(
    inputPath: string,
    outputFilename: string,
    onProgress?: (progress: ConversionProgress) => void
  ): Promise<string> {
    // Ensure output directory exists
    await fs.mkdir(this.outputDir, { recursive: true });

    const outputPath = path.join(this.outputDir, outputFilename);

    console.log('[VideoConverter] Starting conversion...');
    console.log('[VideoConverter] Input:', inputPath);
    console.log('[VideoConverter] Output:', outputPath);

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        // Video codec: H.264 (most compatible)
        .videoCodec('libx264')
        // Preset: faster = quicker encoding, still good quality
        .outputOptions([
          '-preset fast',
          '-crf 23', // Quality: 18-28 (lower = better, 23 = default)
          '-movflags +faststart', // Enable streaming (moov atom at start)
        ])
        // Audio codec: AAC (most compatible)
        .audioCodec('aac')
        .audioBitrate('128k')
        // Output format
        .format('mp4')
        // Progress tracking
        .on('progress', (progress) => {
          if (onProgress && progress.percent) {
            onProgress({
              percent: Math.round(progress.percent * 10) / 10,
              currentTime: progress.timemark || '00:00:00',
              targetSize: progress.targetSize || '0kB',
            });
          }
        })
        // Conversion complete
        .on('end', () => {
          console.log('[VideoConverter] Conversion complete:', outputPath);
          resolve(outputPath);
        })
        // Error handling
        .on('error', (err) => {
          console.error('[VideoConverter] Conversion failed:', err.message);
          reject(new Error(`FFmpeg conversion failed: ${err.message}`));
        })
        // Save to output path
        .save(outputPath);
    });
  }

  /**
   * Delete temporary file
   */
  async deleteTempFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
      console.log('[VideoConverter] Deleted temp file:', filePath);
    } catch (error) {
      console.error('[VideoConverter] Failed to delete temp file:', filePath, error);
    }
  }

  /**
   * Get video metadata
   */
  async getVideoMetadata(filePath: string): Promise<any> {
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
}
