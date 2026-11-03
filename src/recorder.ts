/**
 * Motion Capture Recorder:
 * Records bone transformations and landmark states per frame,
 * with real-time playback and scrubbing capabilities.
 */
import * as THREE from 'three';
import type { HumanoidBones } from './scene';
import type { Point3D } from './smoothing';

export interface RecordedFrame {
  timestamp: number; // in milliseconds
  rootPosition: { x: number; y: number; z: number };
  boneRotations: Record<string, { x: number; y: number; z: number; w: number }>;
  landmarks?: Point3D[];
}

export type PlaybackCallback = (frame: RecordedFrame, frameIndex: number, totalFrames: number) => void;

export class MotionRecorder {
  private frames: RecordedFrame[] = [];
  private isRecording = false;
  private isPlaying = false;
  private startTime = 0;
  private playbackIndex = 0;
  private playbackTimer: number | null = null;

  public get recording(): boolean {
    return this.isRecording;
  }

  public get playing(): boolean {
    return this.isPlaying;
  }

  public get frameCount(): number {
    return this.frames.length;
  }

  public get durationSec(): number {
    if (this.frames.length < 2) return 0;
    return (this.frames[this.frames.length - 1].timestamp - this.frames[0].timestamp) / 1000;
  }

  public get recordedFrames(): RecordedFrame[] {
    return this.frames;
  }

  public startRecording(): void {
    this.stopPlayback();
    this.frames = [];
    this.startTime = performance.now();
    this.isRecording = true;
  }

  public stopRecording(): number {
    this.isRecording = false;
    return this.frames.length;
  }

  /**
   * Capture a single frame from the current character bone state.
   */
  public recordFrame(bones: HumanoidBones, landmarks?: Point3D[]): void {
    if (!this.isRecording) return;

    const timestamp = performance.now() - this.startTime;
    const rootPos = bones.hips ? bones.hips.position : new THREE.Vector3();

    const boneRotations: Record<string, { x: number; y: number; z: number; w: number }> = {};
    for (const [key, bone] of Object.entries(bones)) {
      if (bone) {
        boneRotations[key] = {
          x: bone.quaternion.x,
          y: bone.quaternion.y,
          z: bone.quaternion.z,
          w: bone.quaternion.w,
        };
      }
    }

    this.frames.push({
      timestamp,
      rootPosition: { x: rootPos.x, y: rootPos.y, z: rootPos.z },
      boneRotations,
      landmarks: landmarks ? landmarks.map((l) => ({ ...l })) : undefined,
    });
  }

  /**
   * Playback recorded motion on character bones.
   */
  public startPlayback(
    bones: HumanoidBones,
    onProgress?: PlaybackCallback,
    onFinish?: () => void
  ): void {
    if (this.frames.length === 0) return;
    this.stopRecording();
    this.isPlaying = true;
    this.playbackIndex = 0;

    const playNext = () => {
      if (!this.isPlaying || this.playbackIndex >= this.frames.length) {
        this.isPlaying = false;
        if (onFinish) onFinish();
        return;
      }

      const frame = this.frames[this.playbackIndex];
      this.applyFrameToBones(frame, bones);

      if (onProgress) {
        onProgress(frame, this.playbackIndex, this.frames.length);
      }

      this.playbackIndex++;

      // Compute frame delay based on recording timing
      let delay = 33; // ~30 fps default
      if (this.playbackIndex < this.frames.length) {
        const nextFrame = this.frames[this.playbackIndex];
        delay = Math.max(10, Math.min(100, nextFrame.timestamp - frame.timestamp));
      }

      this.playbackTimer = window.setTimeout(playNext, delay);
    };

    playNext();
  }

  public stopPlayback(): void {
    this.isPlaying = false;
    if (this.playbackTimer !== null) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
  }

  public applyFrameToBones(frame: RecordedFrame, bones: HumanoidBones): void {
    if (bones.hips && frame.rootPosition) {
      bones.hips.position.set(frame.rootPosition.x, frame.rootPosition.y, frame.rootPosition.z);
    }

    for (const [key, rot] of Object.entries(frame.boneRotations)) {
      const bone = bones[key];
      if (bone && rot) {
        bone.quaternion.set(rot.x, rot.y, rot.z, rot.w);
      }
    }
  }

  public clear(): void {
    this.stopPlayback();
    this.stopRecording();
    this.frames = [];
  }
}
