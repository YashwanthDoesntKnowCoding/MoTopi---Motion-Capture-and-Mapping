/**
 * MoTopi - Main Application Entrypoint
 * Coordinates single-camera tracking, body calibration, 3D scene,
 * adaptive jitter filtering, and biomechanical retargeting.
 */
import './style.css';
import { CameraManager } from './camera';
import { PoseTracker } from './pose';
import { LandmarkSmoother } from './smoothing';
import { SceneManager, type AvatarStyle } from './scene';
import { PoseRetargeter } from './retarget';
import { UIManager } from './ui';
import { BodyPoseEstimator } from './pose-estimation';

class MoTopiApp {
  private camera!: CameraManager;
  private poseTracker!: PoseTracker;
  private poseEstimator!: BodyPoseEstimator;
  private smoother!: LandmarkSmoother;
  private scene!: SceneManager;
  private retargeter!: PoseRetargeter;
  private ui!: UIManager;

  private isRunning = false;
  private frameCount = 0;
  private fpsLastCalc = performance.now();
  private lastDetectedTime = 0;
  private lastProcessedVideoTime = Number.NaN;

  constructor() {
    this.init();
  }

  private async init(): Promise<void> {
    // 1. Initialize UI with callbacks
    this.ui = new UIManager({
      onStartCamera: () => this.handleStartCamera(),
      onStopCamera: () => this.handleStopCamera(),
      onSelectCamera: (id) => this.handleSelectCamera(id),
      onCalibrateBody: () => this.handleCalibrateBody(),
      onToggleMirror: () => this.handleToggleMirror(),
      onSelectAvatar: (style) => this.handleSelectAvatar(style),
      onResetPose: () => this.handleResetPose(),
      onToggleSkeleton: () => this.handleToggleSkeleton(),
      onSmoothingChange: (val) => this.handleSmoothingChange(val),
      onMotionStrengthChange: (val) => this.retargeter.setMotionStrength(val),
    });

    // 2. Initialize Camera & Vision
    this.camera = new CameraManager(this.ui.videoElement);
    this.poseTracker = new PoseTracker(this.ui.canvasElement);
    this.poseEstimator = new BodyPoseEstimator();

    // Initial check for available cameras
    this.refreshDevices();
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => this.refreshDevices());
    }

    // 3. Initialize Smoothing (1 Euro Filter)
    this.smoother = new LandmarkSmoother(33, {
      minCutoff: 1.0,
      beta: 0.007,
      dCutoff: 1.0,
    });

    // 4. Initialize Retargeter
    this.retargeter = new PoseRetargeter();

    // 5. Initialize Three.js 3D Scene
    this.scene = new SceneManager(this.ui.viewportContainer);
    this.ui.updateActiveModel(this.scene.loadedModelName, this.scene.currentAvatarStyle);

    // 6. Preload MediaPipe Pose Landmarker model in the background
    try {
      this.ui.showNotification('Initializing AI Pose Tracker...', false);
      await this.poseTracker.initialize();
      this.ui.showNotification('Ready! Click "Start Camera" to begin live mocap.', false);
    } catch (err) {
      console.error(err);
      this.ui.showNotification('Vision model loading error. Please check your internet connection.', true);
    }

    // 7. Synchronize Canvas dimensions with video container
    this.syncCanvasDimensions();
    window.addEventListener('resize', () => this.syncCanvasDimensions());

    // 8. Start requestAnimationFrame tracking loop
    requestAnimationFrame(this.trackingLoop);
  }

  private async refreshDevices(): Promise<void> {
    const devices = await CameraManager.getVideoDevices();
    this.ui.populateCameraDevices(devices, this.camera.currentDeviceId);
  }

  private syncCanvasDimensions(): void {
    const rect = this.ui.videoElement.parentElement?.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.height > 0) {
      this.ui.canvasElement.width = rect.width;
      this.ui.canvasElement.height = rect.height;
    }
  }

  private async handleStartCamera(): Promise<void> {
    try {
      this.ui.showNotification('Accessing camera...', false);
      await this.startSelectedCameras();
    } catch (err: unknown) {
      this.camera.stop();
      this.isRunning = false;
      this.poseEstimator.cancelCalibration();
      this.ui.setCameraState(false);
      this.ui.setBodyCalibrationStatus(0, false, this.poseEstimator.isCalibrated);
      const msg = err instanceof Error ? err.message : String(err);
      this.ui.showNotification(msg, true);
      this.ui.setTrackingStatus('ready');
    }
  }

  private async handleSelectCamera(deviceId: string): Promise<void> {
    if (!this.isRunning) return;
    await this.restartSelectedCameras();
  }

  private async restartSelectedCameras(): Promise<void> {
    this.camera.stop();
    this.isRunning = false;
    this.poseEstimator.cancelCalibration();
    this.ui.setCameraState(false);
    this.ui.setBodyCalibrationStatus(0, false, this.poseEstimator.isCalibrated);
    try {
      await this.startSelectedCameras();
    } catch (err: unknown) {
      this.camera.stop();
      this.isRunning = false;
      this.ui.setCameraState(false);
      this.ui.setBodyCalibrationStatus(0, false, this.poseEstimator.isCalibrated);
      this.ui.showNotification(
        `Could not switch cameras: ${err instanceof Error ? err.message : String(err)}`,
        true
      );
    }
  }

  private async startSelectedCameras(): Promise<void> {
    const primaryId = this.ui.selectedCameraId;
    await this.camera.start(primaryId ? { deviceId: primaryId } : {});

    if (!this.poseTracker.isReady) await this.poseTracker.initialize();
    await this.refreshDevices();
    this.syncCanvasDimensions();
    this.ui.setCameraState(true);
    this.ui.setTrackingStatus('ready');
    this.isRunning = true;
    this.smoother.reset();
    this.poseEstimator.resetTracking();
    this.retargeter.resetCalibration();
    this.lastDetectedTime = performance.now();
    this.lastProcessedVideoTime = Number.NaN;
    this.ui.setBodyCalibrationStatus(0, false, this.poseEstimator.isCalibrated);
    this.ui.showNotification('Live single-camera tracking active!', false);
  }

  private handleCalibrateBody(): void {
    if (!this.camera.isPlaying) {
      this.ui.showNotification('Start the camera before calibrating your body.', true);
      return;
    }
    this.poseEstimator.startCalibration();
    this.ui.setBodyCalibrationStatus(0, true, this.poseEstimator.isCalibrated);
    this.ui.showNotification('Calibration started. Face the camera and hold a steady full-body pose.', false);
  }

  private handleStopCamera(): void {
    this.camera.stop();
    this.isRunning = false;
    this.lastProcessedVideoTime = Number.NaN;
    this.poseEstimator.cancelCalibration();
    this.poseTracker.clearOverlay();
    this.poseEstimator.resetTracking();
    this.ui.setCameraState(false);
    this.ui.setBodyCalibrationStatus(0, false, this.poseEstimator.isCalibrated);
    this.ui.setTrackingStatus('ready');
    this.ui.showTrackingTip(false);
    this.scene.resetToRestPose();
    this.smoother.reset();
  }

  private handleToggleMirror(): void {
    this.camera.toggleMirror();
  }

  private handleSelectAvatar(style: AvatarStyle): void {
    this.scene.createProceduralMannequin(style);
    this.ui.updateActiveModel(this.scene.loadedModelName, style);
    this.ui.showNotification(`Active: ${this.scene.loadedModelName}`, false);
  }

  private handleResetPose(): void {
    this.scene.resetToRestPose();
    this.smoother.reset();
    this.poseEstimator.resetTracking();
    this.retargeter.resetCalibration();
    this.ui.showNotification('Pose and root position reset to center.', false);
  }

  private handleToggleSkeleton(): void {
    const visible = this.scene.toggleSkeletonHelper();
    this.ui.showNotification(`Skeleton visualizer ${visible ? 'ON' : 'OFF'}`, false);
  }

  private handleSmoothingChange(val: number): void {
    // val is 0.1 to 5.0
    const minCutoff = Math.max(0.2, (5.1 - val) * 0.8);
    const beta = val * 0.005;
    this.smoother.updateConfig({ minCutoff, beta });
  }

  /**
   * Main High-Frequency Detection & Retargeting Loop (requestAnimationFrame)
   */
  private trackingLoop = (now: number): void => {
    requestAnimationFrame(this.trackingLoop);

    // Calculate FPS
    this.frameCount++;
    if (now - this.fpsLastCalc >= 1000) {
      const fps = (this.frameCount * 1000) / (now - this.fpsLastCalc);
      this.ui.updateFPS(fps);
      this.frameCount = 0;
      this.fpsLastCalc = now;
    }

    if (!this.isRunning || !this.camera.isPlaying) {
      return;
    }

    const video = this.camera.video;
    let detectedPose = null;
    if (video.currentTime !== this.lastProcessedVideoTime) {
      this.lastProcessedVideoTime = video.currentTime;
      detectedPose = this.poseTracker.detect(video, now);
    }

    if (detectedPose && detectedPose.worldLandmarks3D.length >= 33) {
      const wasCalibrating = this.poseEstimator.isCalibrating;
      const poseData = this.poseEstimator.process(detectedPose);
      if (wasCalibrating || this.poseEstimator.isCalibrating) {
        this.ui.setBodyCalibrationStatus(
          this.poseEstimator.calibrationProgress,
          this.poseEstimator.isCalibrating,
          this.poseEstimator.isCalibrated
        );
      }
      if (wasCalibrating && !this.poseEstimator.isCalibrating && this.poseEstimator.isCalibrated) {
        this.ui.showNotification('Body calibration complete. Proportion-based joint estimation is active.', false);
      }

      this.lastDetectedTime = now;
      this.ui.setTrackingStatus('tracking');

      // 1. Adaptive smoothing with 1€ filter
      const smoothedWorld = this.smoother.filterLandmarks(poseData.worldLandmarks3D, now);

      // 2. Check visibility of torso and leg landmarks used for retargeting
      const isBodyVisible = [11, 12, 23, 24, 25, 26, 27, 28].every(
        (index) => (poseData.worldLandmarks3D[index].visibility ?? 1.0) > 0.4
      );
      this.ui.showTrackingTip(!isBodyVisible);

      // 3. Retarget the complete tracked body
      this.retargeter.retarget(
        smoothedWorld,
        this.scene.bones,
        this.scene.boneRestDirections,
        this.scene.initialBoneRotations,
        this.scene.initialBonePositions,
        now,
        this.scene.initialWorldRotations,
        this.scene.character,
        detectedPose.landmarks2D
      );

      // 4. Draw 2D neon skeleton overlay
      this.poseTracker.drawOverlay(detectedPose.landmarks2D, this.camera.mirrored);
    } else {
      // If tracking lost for more than 450ms
      if (now - this.lastDetectedTime > 450) {
        this.ui.setTrackingStatus('lost');
        this.poseTracker.clearOverlay();
      }
    }
  };
}

// Instantiate application on DOM ready
window.addEventListener('DOMContentLoaded', () => {
  new MoTopiApp();
});
