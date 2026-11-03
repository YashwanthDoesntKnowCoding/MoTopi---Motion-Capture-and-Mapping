import type { PoseFrameData } from './pose';
import type { Point3D } from './smoothing';

const REQUIRED_CALIBRATION_FRAMES = 45;
const MIN_CALIBRATION_CONFIDENCE = 0.65;
const MIN_TRACKING_CONFIDENCE = 0.5;
const SHORT_PREDICTION_MS = 120;
const CALIBRATION_LANDMARKS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const BODY_SEGMENTS: readonly (readonly [number, number])[] = [
  [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [24, 26], [26, 28],
];
const JOINT_CHAINS: readonly (readonly [number, number, number])[] = [
  [11, 13, 15], [12, 14, 16], [23, 25, 27], [24, 26, 28],
];

function isVisible(point: Point3D | undefined, threshold: number): point is Point3D {
  return !!point &&
    (point.visibility ?? 1) >= threshold &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    Number.isFinite(point.z);
}

function distance(a: Point3D, b: Point3D): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export class BodyPoseEstimator {
  private calibrationSamples = new Map<string, number[]>();
  private calibratedLengths = new Map<string, number>();
  private calibrationFrames = 0;
  private previousVisible: (Point3D | null)[] = Array(33).fill(null);
  private previousVisibleAt: number[] = Array(33).fill(0);
  private olderVisible: (Point3D | null)[] = Array(33).fill(null);
  private olderVisibleAt: number[] = Array(33).fill(0);

  public get isCalibrating(): boolean {
    return this.calibrationFrames >= 0 && this.calibrationSamples.size > 0;
  }

  public get isCalibrated(): boolean {
    return this.calibratedLengths.size === BODY_SEGMENTS.length;
  }

  public get calibrationProgress(): number {
    return Math.max(0, Math.min(100, Math.round((this.calibrationFrames / REQUIRED_CALIBRATION_FRAMES) * 100)));
  }

  public startCalibration(): void {
    this.calibrationFrames = 0;
    this.calibrationSamples = new Map(
      BODY_SEGMENTS.map(([start, end]) => [`${start}-${end}`, []])
    );
  }

  public resetTracking(): void {
    this.previousVisible = Array(33).fill(null);
    this.previousVisibleAt = Array(33).fill(0);
    this.olderVisible = Array(33).fill(null);
    this.olderVisibleAt = Array(33).fill(0);
  }

  public cancelCalibration(): void {
    if (!this.isCalibrating) return;
    this.calibrationFrames = -1;
    this.calibrationSamples.clear();
  }

  public process(frame: PoseFrameData): PoseFrameData {
    if (this.isCalibrating) this.collectCalibrationFrame(frame.worldLandmarks3D);

    const landmarks = frame.worldLandmarks3D.map((point) => ({ ...point }));
    for (const [start, middle, end] of JOINT_CHAINS) {
      const startPoint = landmarks[start];
      const middlePoint = landmarks[middle];
      const endPoint = landmarks[end];
      const firstLength = this.calibratedLengths.get(`${start}-${middle}`);
      const secondLength = this.calibratedLengths.get(`${middle}-${end}`);
      if (!isVisible(startPoint, MIN_TRACKING_CONFIDENCE) ||
        !isVisible(endPoint, MIN_TRACKING_CONFIDENCE) ||
        firstLength === undefined ||
        secondLength === undefined
      ) continue;

      if (!isVisible(middlePoint, MIN_TRACKING_CONFIDENCE)) {
        const inferred = this.inferJoint(start, middle, end, startPoint, endPoint, firstLength, secondLength);
        if (inferred) landmarks[middle] = inferred;
        continue;
      }

      const firstObservedLength = distance(startPoint, middlePoint);
      const secondObservedLength = distance(middlePoint, endPoint);
      const lengthError = Math.max(
        Math.abs(firstObservedLength - firstLength) / firstLength,
        Math.abs(secondObservedLength - secondLength) / secondLength
      );
      if (lengthError < 0.18) continue;

      const constrained = this.inferJoint(
        start, middle, end, startPoint, endPoint, firstLength, secondLength, middlePoint
      );
      if (!constrained) continue;
      const correction = Math.min(0.75, (lengthError - 0.12) * 1.5);
      landmarks[middle] = {
        x: middlePoint.x + (constrained.x - middlePoint.x) * correction,
        y: middlePoint.y + (constrained.y - middlePoint.y) * correction,
        z: middlePoint.z + (constrained.z - middlePoint.z) * correction,
        visibility: middlePoint.visibility,
      };
    }

    for (let index = 0; index < landmarks.length; index++) {
      const point = landmarks[index];
      if (isVisible(point, MIN_TRACKING_CONFIDENCE)) {
        this.olderVisible[index] = this.previousVisible[index];
        this.olderVisibleAt[index] = this.previousVisibleAt[index];
        this.previousVisible[index] = { ...point };
        this.previousVisibleAt[index] = frame.timestamp;
        continue;
      }

      const previous = this.previousVisible[index];
      const elapsed = frame.timestamp - this.previousVisibleAt[index];
      if (!previous || elapsed <= 0 || elapsed > SHORT_PREDICTION_MS) continue;

      const estimate = { ...previous };
      const older = this.olderVisible[index];
      const historyDuration = this.previousVisibleAt[index] - this.olderVisibleAt[index];
      if (older && historyDuration > 0) {
        const horizon = elapsed / historyDuration;
        const vx = (previous.x - older.x) * horizon;
        const vy = (previous.y - older.y) * horizon;
        const vz = (previous.z - older.z) * horizon;
        const predictedDistance = Math.hypot(vx, vy, vz);
        const movementLimit = 1.5 * elapsed / 1000;
        if (predictedDistance > movementLimit && predictedDistance > 0) {
          const scale = movementLimit / predictedDistance;
          estimate.x += vx * scale;
          estimate.y += vy * scale;
          estimate.z += vz * scale;
        } else {
          estimate.x += vx;
          estimate.y += vy;
          estimate.z += vz;
        }
      }
      estimate.visibility = MIN_TRACKING_CONFIDENCE;
      landmarks[index] = estimate;
    }

    return { ...frame, worldLandmarks3D: landmarks };
  }

  private collectCalibrationFrame(landmarks: Point3D[]): void {
    if (!CALIBRATION_LANDMARKS.every((index) => isVisible(landmarks[index], MIN_CALIBRATION_CONFIDENCE))) {
      return;
    }

    for (const [start, end] of BODY_SEGMENTS) {
      const length = distance(landmarks[start], landmarks[end]);
      if (!Number.isFinite(length) || length < 0.08 || length > 0.9) return;
    }

    for (const [start, end] of BODY_SEGMENTS) {
      const key = `${start}-${end}`;
      this.calibrationSamples.get(key)?.push(distance(landmarks[start], landmarks[end]));
    }
    this.calibrationFrames++;

    if (this.calibrationFrames < REQUIRED_CALIBRATION_FRAMES) return;

    const lengths = new Map<string, number>();
    for (const [start, end] of BODY_SEGMENTS) {
      const key = `${start}-${end}`;
      const samples = this.calibrationSamples.get(key) ?? [];
      if (samples.length < REQUIRED_CALIBRATION_FRAMES) return;
      lengths.set(key, median(samples));
    }

    this.calibratedLengths = lengths;
    this.calibrationFrames = -1;
    this.calibrationSamples.clear();
  }

  private inferJoint(
    startIndex: number,
    middleIndex: number,
    endIndex: number,
    start: Point3D,
    end: Point3D,
    firstLength: number,
    secondLength: number,
    bendHint?: Point3D
  ): Point3D | null {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = end.z - start.z;
    const span = Math.hypot(dx, dy, dz);
    const minimumSpan = Math.abs(firstLength - secondLength) + 1e-4;
    const maximumSpan = firstLength + secondLength - 1e-4;
    if (span < minimumSpan || span > maximumSpan || span < 1e-4) return null;

    const axis = { x: dx / span, y: dy / span, z: dz / span };
    const along = (firstLength ** 2 - secondLength ** 2 + span ** 2) / (2 * span);
    const height = Math.sqrt(Math.max(0, firstLength ** 2 - along ** 2));
    const previous = bendHint ?? this.previousVisible[middleIndex];
    let bend = previous
      ? { x: previous.x - start.x, y: previous.y - start.y, z: previous.z - start.z }
      : { x: 0, y: 0, z: 1 };
    const projection = bend.x * axis.x + bend.y * axis.y + bend.z * axis.z;
    bend = {
      x: bend.x - projection * axis.x,
      y: bend.y - projection * axis.y,
      z: bend.z - projection * axis.z,
    };
    let bendLength = Math.hypot(bend.x, bend.y, bend.z);
    if (bendLength < 1e-4) {
      bend = Math.abs(axis.y) < 0.9
        ? { x: 0, y: 1, z: 0 }
        : { x: 0, y: 0, z: 1 };
      const fallbackProjection = bend.x * axis.x + bend.y * axis.y + bend.z * axis.z;
      bend = {
        x: bend.x - fallbackProjection * axis.x,
        y: bend.y - fallbackProjection * axis.y,
        z: bend.z - fallbackProjection * axis.z,
      };
      bendLength = Math.hypot(bend.x, bend.y, bend.z);
    }
    if (bendLength < 1e-4) return null;

    return {
      x: start.x + axis.x * along + (bend.x / bendLength) * height,
      y: start.y + axis.y * along + (bend.y / bendLength) * height,
      z: start.z + axis.z * along + (bend.z / bendLength) * height,
      visibility: 0.55,
    };
  }
}
