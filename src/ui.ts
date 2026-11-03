import type { AvatarStyle } from './scene';

/**
 * MoTopi UI Controller:
 * Handles user interactions, camera selection, body calibration, avatar selector,
 * HUD metrics, tracking alerts, and phone guide modal.
 */

export interface UIEvents {
  onStartCamera: () => void;
  onStopCamera: () => void;
  onSelectCamera: (deviceId: string) => void;
  onCalibrateBody: () => void;
  onToggleMirror: () => void;
  onSelectAvatar: (style: AvatarStyle) => void;
  onResetPose: () => void;
  onToggleSkeleton: () => void;
  onSmoothingChange: (value: number) => void;
  onMotionStrengthChange: (value: number) => void;
}

export class UIManager {
  private events: UIEvents;

  // DOM Elements
  public videoElement: HTMLVideoElement;
  public canvasElement: HTMLCanvasElement;
  public viewportContainer: HTMLElement;

  private btnStartCamera: HTMLButtonElement;
  private selectCamera: HTMLSelectElement;
  private btnCalibrateBody: HTMLButtonElement;
  private bodyCalibrationStatus: HTMLElement;
  private bodyCalibrationPanel: HTMLElement;
  private calibrationProgressFill: HTMLElement;
  private calibrationCollapseTimer: ReturnType<typeof setTimeout> | null = null;
  private btnMirror: HTMLButtonElement;
  private btnResetPose: HTMLButtonElement;
  private btnToggleSkeleton: HTMLButtonElement;

  private avatarButtons: HTMLButtonElement[];
  private activeModelBadge: HTMLElement;

  private sliderSmoothing: HTMLInputElement;
  private smoothingValueLabel: HTMLElement;
  private sliderMotionStrength: HTMLInputElement;
  private motionStrengthValueLabel: HTMLElement;

  private fpsBadge: HTMLElement;
  private trackingBadge: HTMLElement;
  private alertBanner: HTMLElement;
  private tipBanner: HTMLElement;

  private phoneModal: HTMLElement;
  private btnPhoneGuide: HTMLButtonElement;
  private btnCloseModal: HTMLButtonElement;
  private cameraDevices: MediaDeviceInfo[] = [];

  constructor(events: UIEvents) {
    this.events = events;

    // Grab elements
    this.videoElement = document.getElementById('webcam-video') as HTMLVideoElement;
    this.canvasElement = document.getElementById('skeleton-canvas') as HTMLCanvasElement;
    this.viewportContainer = document.getElementById('viewport-container') as HTMLElement;

    this.btnStartCamera = document.getElementById('btn-camera') as HTMLButtonElement;
    this.selectCamera = document.getElementById('select-camera') as HTMLSelectElement;
    this.btnCalibrateBody = document.getElementById('btn-calibrate-body') as HTMLButtonElement;
    this.bodyCalibrationStatus = document.getElementById('body-calibration-status') as HTMLElement;
    this.bodyCalibrationPanel = document.querySelector('.body-calibration-panel') as HTMLElement;
    this.calibrationProgressFill = document.getElementById('calibration-progress-fill') as HTMLElement;
    this.btnMirror = document.getElementById('btn-mirror') as HTMLButtonElement;
    this.btnResetPose = document.getElementById('btn-reset-pose') as HTMLButtonElement;
    this.btnToggleSkeleton = document.getElementById('btn-toggle-skeleton') as HTMLButtonElement;

    this.avatarButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-avatar-style]'));
    this.activeModelBadge = document.getElementById('active-model-name') as HTMLElement;

    this.sliderSmoothing = document.getElementById('slider-smoothing') as HTMLInputElement;
    this.smoothingValueLabel = document.getElementById('smoothing-value') as HTMLElement;
    this.sliderMotionStrength = document.getElementById('slider-motion-strength') as HTMLInputElement;
    this.motionStrengthValueLabel = document.getElementById('motion-strength-value') as HTMLElement;

    this.fpsBadge = document.getElementById('badge-fps') as HTMLElement;
    this.trackingBadge = document.getElementById('badge-tracking') as HTMLElement;
    this.alertBanner = document.getElementById('alert-banner') as HTMLElement;
    this.tipBanner = document.getElementById('tip-banner') as HTMLElement;

    this.phoneModal = document.getElementById('phone-guide-modal') as HTMLElement;
    this.btnPhoneGuide = document.getElementById('btn-phone-guide') as HTMLButtonElement;
    this.btnCloseModal = document.getElementById('btn-close-modal') as HTMLButtonElement;

    this.setupListeners();
  }

  private setupListeners(): void {
    // Camera Toggle
    this.btnStartCamera.addEventListener('click', () => {
      if (this.btnStartCamera.dataset.state === 'running') {
        this.events.onStopCamera();
      } else {
        this.events.onStartCamera();
      }
    });

    // Camera Device Selection
    this.selectCamera.addEventListener('change', () => {
      this.events.onSelectCamera(this.selectCamera.value);
    });

    this.btnCalibrateBody.addEventListener('click', () => this.events.onCalibrateBody());

    // Mirror Toggle
    this.btnMirror.addEventListener('click', () => {
      this.events.onToggleMirror();
    });

    this.avatarButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const style = button.dataset.avatarStyle;
        if (style === 'cyber' || style === 'feminine' || style === 'crash-test') {
          this.events.onSelectAvatar(style);
        }
      });
    });

    // Reset Pose & Skeleton Toggle
    this.btnResetPose.addEventListener('click', () => {
      this.events.onResetPose();
    });

    this.btnToggleSkeleton.addEventListener('click', () => {
      this.events.onToggleSkeleton();
    });

    // Smoothing Slider
    this.sliderSmoothing.addEventListener('input', (e) => {
      const val = parseFloat((e.target as HTMLInputElement).value);
      this.smoothingValueLabel.textContent = val.toFixed(1);
      this.events.onSmoothingChange(val);
    });

    this.sliderMotionStrength.addEventListener('input', (e) => {
      const val = parseFloat((e.target as HTMLInputElement).value);
      this.motionStrengthValueLabel.textContent = `${Math.round(val * 100)}%`;
      this.events.onMotionStrengthChange(val);
    });

    // Phone Guide Modal
    this.btnPhoneGuide.addEventListener('click', () => {
      this.phoneModal.classList.add('visible');
    });

    this.btnCloseModal.addEventListener('click', () => {
      this.phoneModal.classList.remove('visible');
    });

    this.phoneModal.addEventListener('click', (e) => {
      if (e.target === this.phoneModal) {
        this.phoneModal.classList.remove('visible');
      }
    });
  }

  public populateCameraDevices(devices: MediaDeviceInfo[], activeDeviceId?: string): void {
    this.cameraDevices = devices;
    const previousPrimary = this.selectCamera.value;
    this.selectCamera.innerHTML = '';

    if (devices.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Default Camera';
      this.selectCamera.appendChild(opt);
      return;
    }

    devices.forEach((dev, idx) => {
      const opt = document.createElement('option');
      opt.value = dev.deviceId;
      opt.textContent = dev.label ? dev.label : `Camera ${idx + 1}`;
      if (dev.deviceId === (activeDeviceId ?? previousPrimary)) {
        opt.selected = true;
      }
      this.selectCamera.appendChild(opt);
    });

    if (!activeDeviceId && !previousPrimary) this.selectCamera.selectedIndex = 0;
  }

  public updateActiveModel(name: string, style: AvatarStyle): void {
    this.activeModelBadge.textContent = `Active: ${name}`;
    this.avatarButtons.forEach((button) => {
      const isActive = button.dataset.avatarStyle === style;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
  }

  public setCameraState(isRunning: boolean): void {
    this.btnStartCamera.dataset.state = isRunning ? 'running' : 'idle';
    this.btnStartCamera.innerHTML = isRunning
      ? '<span class="icon">⏹</span> Stop Camera'
      : '<span class="icon">📷</span> Start Camera';

    this.btnMirror.disabled = !isRunning;
    this.btnCalibrateBody.disabled = !isRunning;
  }

  public get selectedCameraId(): string {
    return this.selectCamera.value;
  }

  public setBodyCalibrationStatus(progress: number, isCalibrating: boolean, isCalibrated: boolean): void {
    const boundedProgress = Math.max(0, Math.min(100, progress));
    if (this.calibrationCollapseTimer !== null) {
      clearTimeout(this.calibrationCollapseTimer);
      this.calibrationCollapseTimer = null;
    }

    this.bodyCalibrationPanel.classList.toggle('is-calibrating', isCalibrating);
    this.bodyCalibrationPanel.classList.toggle('is-complete', isCalibrated && !isCalibrating);
    this.bodyCalibrationPanel.classList.remove('is-collapsed');
    this.calibrationProgressFill.style.width = `${isCalibrated ? 100 : boundedProgress}%`;
    this.calibrationProgressFill.setAttribute('aria-valuenow', String(isCalibrated ? 100 : boundedProgress));

    this.btnCalibrateBody.textContent = isCalibrating
      ? `Calibrating... ${boundedProgress}%`
      : isCalibrated
        ? '✓ Calibration complete'
        : 'Calibrate body';
    this.btnCalibrateBody.disabled = this.btnStartCamera.dataset.state !== 'running' || isCalibrating;
    this.bodyCalibrationStatus.textContent = isCalibrating
      ? `Hold still with your full body visible (${boundedProgress}%).`
      : isCalibrated
        ? 'Body profile saved — proportion-aware tracking is active.'
        : 'Optional: calibration improves estimates when elbows or knees are briefly hidden.';

    if (isCalibrated && !isCalibrating) {
      this.calibrationCollapseTimer = setTimeout(() => {
        this.bodyCalibrationPanel.classList.add('is-collapsed');
        this.btnCalibrateBody.textContent = 'Recalibrate';
        this.calibrationCollapseTimer = null;
      }, 2200);
    }
  }

  public updateFPS(fps: number): void {
    this.fpsBadge.textContent = `${Math.round(fps)} FPS`;
  }

  public setTrackingStatus(status: 'ready' | 'tracking' | 'lost' | 'low_confidence'): void {
    this.trackingBadge.className = `status-badge status-${status}`;

    if (status === 'tracking') {
      this.trackingBadge.textContent = '● Tracking OK';
      this.alertBanner.classList.remove('visible');
    } else if (status === 'lost') {
      this.trackingBadge.textContent = '▲ Tracking Lost';
      this.alertBanner.textContent = '⚠️ Pose tracking lost: Keep your full body visible in the camera';
      this.alertBanner.classList.add('visible');
    } else if (status === 'low_confidence') {
      this.trackingBadge.textContent = '▲ Low Confidence';
    } else {
      this.trackingBadge.textContent = '○ Camera Off';
      this.alertBanner.classList.remove('visible');
    }
  }

  public showNotification(message: string, isError = false): void {
    this.alertBanner.textContent = message;
    this.alertBanner.className = isError ? 'alert-banner visible error' : 'alert-banner visible info';
    setTimeout(() => {
      this.alertBanner.classList.remove('visible');
    }, 4500);
  }

  public showTrackingTip(visible: boolean): void {
    if (visible) {
      this.tipBanner.classList.add('visible');
    } else {
      this.tipBanner.classList.remove('visible');
    }
  }
}
