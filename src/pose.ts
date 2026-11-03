/**
 * MediaPipe Pose Landmarker detector and 2D canvas skeleton overlay renderer.
 * Fast, robust, and non-blocking.
 */
import { FilesetResolver, PoseLandmarker, type PoseLandmarkerResult } from '@mediapipe/tasks-vision';
import type { Point3D } from './smoothing';

export interface PoseFrameData {
  landmarks2D: Point3D[];        // 2D image coordinates (x, y normalized 0..1, z depth)
  worldLandmarks3D: Point3D[];   // 3D world coordinates in meters
  timestamp: number;
}

export const POSE_CONNECTIONS: [number, number][] = [
  // Torso
  [11, 12], [11, 23], [12, 24], [23, 24],
  // Left arm
  [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  // Right arm
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  // Face / Neck
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  // Left leg
  [23, 25], [25, 27], [27, 29], [27, 31], [29, 31],
  // Right leg
  [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
];

export class PoseTracker {
  private landmarker: PoseLandmarker | null = null;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private isModelLoading = false;
  private lastDetectTimestamp = -1;

  constructor(overlayCanvas: HTMLCanvasElement) {
    this.canvas = overlayCanvas;
    const context = this.canvas.getContext('2d');
    if (!context) {
      throw new Error('Failed to obtain 2D canvas rendering context for skeleton overlay.');
    }
    this.ctx = context;
  }

  public get isReady(): boolean {
    return this.landmarker !== null;
  }

  public async initialize(): Promise<void> {
    if (this.landmarker || this.isModelLoading) return;
    this.isModelLoading = true;

    try {
      // Must match installed @mediapipe/tasks-vision version (1.1.1)
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm'
      );

      // Use the full model for more stable body and leg landmarks.
      this.landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.45,
        minPosePresenceConfidence: 0.45,
        minTrackingConfidence: 0.45,
      });

      console.log('MediaPipe Pose Landmarker successfully initialized!');
    } catch (err) {
      console.warn('GPU delegate failed or network error, attempting CPU fallback:', err);
      try {
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm'
        );
        this.landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
            delegate: 'CPU',
          },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.45,
          minPosePresenceConfidence: 0.45,
          minTrackingConfidence: 0.45,
        });
        console.log('MediaPipe Pose Landmarker initialized on CPU fallback!');
      } catch (fallbackErr) {
        console.error('Fatal: MediaPipe Pose model could not be initialized:', fallbackErr);
        throw fallbackErr;
      }
    } finally {
      this.isModelLoading = false;
    }
  }

  public detect(video: HTMLVideoElement, timestampMs: number): PoseFrameData | null {
    if (!this.landmarker || video.readyState < 2 || video.paused || video.ended) {
      return null;
    }

    // MediaPipe requires strictly increasing timestamps (in ms)
    const safeTimestamp = Math.max(timestampMs, this.lastDetectTimestamp + 1);
    this.lastDetectTimestamp = safeTimestamp;

    try {
      const result: PoseLandmarkerResult = this.landmarker.detectForVideo(video, safeTimestamp);

      if (
        !result ||
        !result.landmarks ||
        result.landmarks.length === 0 ||
        !result.worldLandmarks ||
        result.worldLandmarks.length === 0
      ) {
        return null;
      }

      const landmarks2D: Point3D[] = result.landmarks[0].map((pt) => ({
        x: pt.x,
        y: pt.y,
        z: pt.z,
        visibility: pt.visibility,
      }));

      const worldLandmarks3D: Point3D[] = result.worldLandmarks[0].map((pt) => ({
        x: pt.x,
        y: pt.y,
        z: pt.z,
        visibility: pt.visibility,
      }));

      return {
        landmarks2D,
        worldLandmarks3D,
        timestamp: safeTimestamp,
      };
    } catch (err) {
      console.warn('Pose detect frame error (non-fatal):', err);
      return null;
    }
  }

  public clearOverlay(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Render 2D skeleton overlay on top of webcam preview
   */
  public drawOverlay(landmarks: Point3D[], isMirrored: boolean): void {
    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);

    if (!landmarks || landmarks.length === 0) return;

    this.ctx.save();

    // Map 2D normalized points to canvas dimensions
    const points = landmarks.map((lm) => {
      let x = lm.x * width;
      if (isMirrored) {
        x = width - x;
      }
      return {
        x,
        y: lm.y * height,
        visibility: lm.visibility ?? 1.0,
      };
    });

    // Draw connecting bones
    this.ctx.lineWidth = 3;
    this.ctx.lineCap = 'round';

    for (const [startIndex, endIndex] of POSE_CONNECTIONS) {
      const p1 = points[startIndex];
      const p2 = points[endIndex];

      if (!p1 || !p2) continue;
      if (p1.visibility < 0.35 || p2.visibility < 0.35) continue;

      const grad = this.ctx.createLinearGradient(p1.x, p1.y, p2.x, p2.y);
      grad.addColorStop(0, 'rgba(0, 240, 255, 0.9)');
      grad.addColorStop(1, 'rgba(168, 85, 247, 0.9)');

      this.ctx.strokeStyle = grad;
      this.ctx.beginPath();
      this.ctx.moveTo(p1.x, p1.y);
      this.ctx.lineTo(p2.x, p2.y);
      this.ctx.stroke();
    }

    // Draw landmark keypoint dots
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!p || p.visibility < 0.35) continue;

      this.ctx.shadowColor = 'rgba(0, 240, 255, 0.9)';
      this.ctx.shadowBlur = 8;

      this.ctx.fillStyle = i >= 11 && i <= 16 ? '#ec4899' : '#00f0ff';
      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, i >= 11 && i <= 16 ? 5 : 4, 0, 2 * Math.PI);
      this.ctx.fill();
    }

    this.ctx.restore();
  }

  public dispose(): void {
    if (this.landmarker) {
      this.landmarker.close();
      this.landmarker = null;
    }
  }
}
