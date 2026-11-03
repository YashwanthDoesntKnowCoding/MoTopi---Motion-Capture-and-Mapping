/**
 * Camera stream management: WebRTC access, permissions, mirroring, device switching, and lifecycle.
 */

export interface CameraOptions {
  deviceId?: string;
  width?: number;
  height?: number;
  facingMode?: 'user' | 'environment';
}

export class CameraManager {
  private videoElement: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private isMirrored = true;
  private isRunning = false;
  private selectedDeviceId: string | undefined = undefined;

  constructor(videoElement: HTMLVideoElement) {
    this.videoElement = videoElement;
    this.applyMirrorTransform();
  }

  public get isPlaying(): boolean {
    return this.isRunning && !this.videoElement.paused;
  }

  public get video(): HTMLVideoElement {
    return this.videoElement;
  }

  public get mirrored(): boolean {
    return this.isMirrored;
  }

  public get currentDeviceId(): string | undefined {
    return this.selectedDeviceId;
  }

  public setMirrored(mirrored: boolean): void {
    this.isMirrored = mirrored;
    this.applyMirrorTransform();
  }

  public toggleMirror(): boolean {
    this.setMirrored(!this.isMirrored);
    return this.isMirrored;
  }

  private applyMirrorTransform(): void {
    this.videoElement.style.transform = this.isMirrored ? 'scaleX(-1)' : 'scaleX(1)';
  }

  /**
   * Enumerate all connected video input devices (webcams, phone cameras, virtual cams).
   */
  public static async getVideoDevices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return [];
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput');
    } catch {
      return [];
    }
  }

  public async start(options: CameraOptions = {}): Promise<MediaStream> {
    if (this.isRunning && this.stream) {
      return this.stream;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('WebRTC Camera API is not supported in this browser. Please use Google Chrome or modern Edge/Firefox.');
    }

    if (options.deviceId) {
      this.selectedDeviceId = options.deviceId;
    }

    const videoConstraints: MediaTrackConstraints = {
      width: { ideal: options.width ?? 1280 },
      height: { ideal: options.height ?? 720 },
      frameRate: { ideal: 60 },
    };

    if (this.selectedDeviceId) {
      videoConstraints.deviceId = { exact: this.selectedDeviceId };
    } else {
      videoConstraints.facingMode = options.facingMode ?? 'user';
    }

    const constraints: MediaStreamConstraints = {
      audio: false,
      video: videoConstraints,
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.videoElement.srcObject = this.stream;

      // Extract active track's deviceId
      const activeTrack = this.stream.getVideoTracks()[0];
      if (activeTrack) {
        const settings = activeTrack.getSettings();
        if (settings.deviceId) {
          this.selectedDeviceId = settings.deviceId;
        }
      }

      await new Promise<void>((resolve, reject) => {
        this.videoElement.onloadedmetadata = () => {
          this.videoElement.play()
            .then(() => {
              this.isRunning = true;
              resolve();
            })
            .catch(reject);
        };
        this.videoElement.onerror = (e) => reject(new Error(`Failed to load video stream: ${e}`));
      });

      return this.stream;
    } catch (err: unknown) {
      this.stop();
      if (err instanceof DOMException) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          throw new Error('Camera permission was denied. Please grant camera access in browser settings.');
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          throw new Error('No webcam detected on this device. Please connect a camera.');
        } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
          throw new Error('Camera is already in use by another application. Close other camera apps and try again.');
        } else if (err.name === 'OverconstrainedError') {
          throw new Error('The selected camera is unavailable. Reconnect your iPhone, keep its webcam app open, and select the camera again.');
        }
      }
      throw new Error(err instanceof Error ? err.message : 'Unknown camera initialization error.');
    }
  }

  public async switchDevice(deviceId: string): Promise<MediaStream> {
    this.selectedDeviceId = deviceId;
    if (this.isRunning) {
      this.stop();
      return this.start({ deviceId });
    }
    return Promise.reject(new Error('Camera is not active'));
  }

  public stop(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    this.videoElement.srcObject = null;
    this.isRunning = false;
  }
}
