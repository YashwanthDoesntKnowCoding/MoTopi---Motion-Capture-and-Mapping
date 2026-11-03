/**
 * Full-body biomechanical retargeting engine:
 * - Natural upright head & neck posture (no forward slouch)
 * - True 1:1 arm tracking with natural elbow hinge (no hands glued to hips)
 * - Estimated root motion and conservative planted-foot stabilization
 */
import * as THREE from 'three';
import type { Point3D } from './smoothing';
import { OneEuroPoint3D, OneEuroScalar } from './smoothing';
import type { HumanoidBones } from './scene';

export interface RetargetConfig {
  bodyYawFactor: number;
}

const LOWER_BODY_BONE_KEYS = ['hips'] as const;

interface FootPlantState {
  anchorAnkle: THREE.Vector3 | null;
  anchorToe: THREE.Vector3 | null;
  lowestImageY: number;
  previousImageY: number | null;
  previousTimestamp: number | null;
  lastSeenTimestamp: number;
}

export class PoseRetargeter {
  private config: RetargetConfig;
  private trackingRoot: THREE.Object3D | null = null;
  private rootStartPosition = new THREE.Vector3();
  private initialHipX: number | null = null;
  private initialTorsoLength: number | null = null;
  private baselineHipY: number | null = null;
  private previousHipY: number | null = null;
  private previousHipTimestamp: number | null = null;
  private jumpStartedAt: number | null = null;
  private isJumping = false;
  private jumpHeightFilter = new OneEuroScalar({ minCutoff: 3, beta: 0.05, dCutoff: 1 });
  private groundReferenceY: number | null = null;
  private groundCorrection = new OneEuroScalar({ minCutoff: 3, beta: 0.04, dCutoff: 1 });
  private motionStrength = 1;
  private rootXFilter = new OneEuroScalar({ minCutoff: 1.5, beta: 0.02, dCutoff: 1.0 });
  private rootZFilter = new OneEuroScalar({ minCutoff: 1.5, beta: 0.02, dCutoff: 1.0 });
  private leftFootPlant: FootPlantState = this.createFootPlantState();
  private rightFootPlant: FootPlantState = this.createFootPlantState();

  // Reusable math scratchpads
  private tempVecA = new THREE.Vector3();
  private tempVecB = new THREE.Vector3();
  private targetDir = new THREE.Vector3();
  private deltaRot = new THREE.Quaternion();
  private parentWorldQ = new THREE.Quaternion();
  private parentWorldInv = new THREE.Quaternion();
  private worldRestQ = new THREE.Quaternion();
  private worldNewQ = new THREE.Quaternion();
  private inverseYawQuat = new THREE.Quaternion();
  private yawQuat = new THREE.Quaternion();
  private tempVecC = new THREE.Vector3();
  private headDirectionFilter = new OneEuroPoint3D({ minCutoff: 1.8, beta: 0.02, dCutoff: 1.0 });

  private yawSmoother: OneEuroScalar;
  private smoothedYaw = 0;
  private previousBodyYaw: number | null = null;
  private accumulatedBodyYaw = 0;
  private shoulderForwardSign: number | null = null;

  // Canonical reference vectors
  private readonly REST_UP = new THREE.Vector3(0, 1, 0);
  private readonly REST_DOWN = new THREE.Vector3(0, -1, 0);
  private readonly REST_RIGHT = new THREE.Vector3(1, 0, 0);
  private readonly REST_LEFT = new THREE.Vector3(-1, 0, 0);
  private readonly REST_FORWARD = new THREE.Vector3(0, 0, 1);

  constructor(config: Partial<RetargetConfig> = {}) {
    this.config = {
      bodyYawFactor: 1.0,
      ...config,
    };

    this.yawSmoother = new OneEuroScalar({
      minCutoff: 1.0,
      beta: 0.008,
      dCutoff: 1.0,
    });
  }

  public setMotionStrength(strength: number): void {
    this.motionStrength = THREE.MathUtils.clamp(strength, 0.25, 1.75);
  }

  public resetCalibration(): void {
    this.yawSmoother.reset();
    this.headDirectionFilter.reset();
    this.smoothedYaw = 0;
    this.previousBodyYaw = null;
    this.accumulatedBodyYaw = 0;
    this.shoulderForwardSign = null;
    if (this.trackingRoot) this.trackingRoot.position.copy(this.rootStartPosition);
    this.trackingRoot = null;
    this.initialHipX = null;
    this.initialTorsoLength = null;
    this.baselineHipY = null;
    this.previousHipY = null;
    this.previousHipTimestamp = null;
    this.jumpStartedAt = null;
    this.isJumping = false;
    this.jumpHeightFilter.reset();
    this.groundReferenceY = null;
    this.groundCorrection.reset();
    this.rootXFilter.reset();
    this.rootZFilter.reset();
    this.leftFootPlant = this.createFootPlantState();
    this.rightFootPlant = this.createFootPlantState();
  }

  /**
   * Main Retargeting Loop:
   * Maps 3D landmarks onto the character's upper and lower body.
   */
  public retarget(
    worldLandmarks: Point3D[],
    bones: HumanoidBones,
    restDirections: Map<string, THREE.Vector3>,
    initialRotations: Map<string, THREE.Quaternion>,
    initialPositions: Map<string, THREE.Vector3>,
    timestampMs: number,
    initialWorldRotations?: Map<string, THREE.Quaternion>,
    character?: THREE.Object3D | null,
    landmarks2D?: Point3D[]
  ): void {
    if (!worldLandmarks || worldLandmarks.length < 33) return;
    if (character && landmarks2D) this.updateRootPosition(character, landmarks2D, timestampMs);

    for (const key of LOWER_BODY_BONE_KEYS) {
      const bone = bones[key];
      if (!bone) continue;

      const initialPosition = initialPositions.get(key);
      if (initialPosition) bone.position.copy(initialPosition);

      const initialRotation = initialRotations.get(key);
      if (initialRotation) bone.quaternion.copy(initialRotation);
    }
    bones.hips?.updateWorldMatrix(true, true);
    if (character && this.groundReferenceY === null) {
      character.updateMatrixWorld(true);
      const footHeights = [bones.leftFoot, bones.rightFoot]
        .filter((foot): foot is THREE.Bone => !!foot)
        .map((foot) => foot.getWorldPosition(this.tempVecC).y);
      if (footHeights.length > 0) this.groundReferenceY = Math.min(...footHeights);
    }
    const plantedLandmarks = bones.hips && landmarks2D
      ? this.updateFootPlants(worldLandmarks, landmarks2D, bones.hips, timestampMs)
      : [];

    // MediaPipe Landmarks:
    // 0: Nose, 7: L Ear, 8: R Ear
    // 11: L Shoulder, 12: R Shoulder
    // 13: L Elbow,    14: R Elbow
    // 15: L Wrist,    16: R Wrist
    // 17: L Pinky,    18: R Pinky
    // 19: L Index,    20: R Index
    // 23: L Hip,      24: R Hip
    // 25: L Knee,     26: R Knee
    // 27: L Ankle,    28: R Ankle
    // 31: L Toe,      32: R Toe

    const p11 = worldLandmarks[11];
    const p12 = worldLandmarks[12];
    const p23 = worldLandmarks[23];
    const p24 = worldLandmarks[24];

    // Shoulder line & Ear line
    const shMidX = (p11.x + p12.x) * 0.5;
    const shMidY = (p11.y + p12.y) * 0.5;
    const shMidZ = (p11.z + p12.z) * 0.5;

    const hipMidX = (p23.x + p24.x) * 0.5;
    const hipMidY = (p23.y + p24.y) * 0.5;
    const hipMidZ = (p23.z + p24.z) * 0.5;

    // Torso direction vectors
    const torsoDx = shMidX - hipMidX;
    const torsoDy = shMidY - hipMidY;
    const torsoDz = shMidZ - hipMidZ;

    // -------------------------------------------------------------
    // 1. UPPER-BODY YAW (turning left/right)
    // -------------------------------------------------------------
    if (this.hasTrackingConfidence(p11, p12)) {
      const shoulderRightX = p12.x - p11.x;
      const shoulderRightY = -(p12.y - p11.y);
      const shoulderRightZ = -(p12.z - p11.z);
      this.targetDir.set(shoulderRightX, shoulderRightY, shoulderRightZ);
      if (this.targetDir.lengthSq() > 0.0025) {
        this.targetDir.normalize();
        this.tempVecA.crossVectors(this.REST_UP, this.targetDir).normalize();

        const nose = worldLandmarks[0];
        const leftEar = worldLandmarks[7];
        const rightEar = worldLandmarks[8];
        if (this.shoulderForwardSign === null && this.hasTrackingConfidence(nose, leftEar, rightEar)) {
          this.tempVecB.set(
            nose.x - (leftEar.x + rightEar.x) * 0.5,
            -(nose.y - (leftEar.y + rightEar.y) * 0.5),
            -(nose.z - (leftEar.z + rightEar.z) * 0.5)
          );
          this.shoulderForwardSign = this.tempVecA.dot(this.tempVecB) < 0 ? -1 : 1;
        }
        if (this.shoulderForwardSign === null) this.shoulderForwardSign = this.tempVecA.z < 0 ? -1 : 1;
        this.tempVecA.multiplyScalar(this.shoulderForwardSign);

        const bodyYaw = Math.atan2(this.tempVecA.x, this.tempVecA.z);
        if (this.previousBodyYaw === null) {
          this.previousBodyYaw = bodyYaw;
        } else {
          const delta = Math.atan2(
            Math.sin(bodyYaw - this.previousBodyYaw),
            Math.cos(bodyYaw - this.previousBodyYaw)
          );
          if (Math.abs(delta) <= 0.65) {
            this.accumulatedBodyYaw += delta;
            this.previousBodyYaw = bodyYaw;
          }
        }
        this.smoothedYaw = this.yawSmoother.filter(this.accumulatedBodyYaw, timestampMs);
      }
    }

    this.yawQuat.setFromAxisAngle(this.REST_UP, this.smoothedYaw * this.config.bodyYawFactor);
    this.inverseYawQuat.copy(this.yawQuat).invert();

    // -------------------------------------------------------------
    // 2. TORSO & SPINE (Natural upright posture with curvature)
    // -------------------------------------------------------------
    // In Three.js: +X right, +Y up, +Z towards camera
    if (this.hasTrackingConfidence(p11, p12, p23, p24)) {
      this.targetDir.set(torsoDx, -torsoDy, -torsoDz).normalize();

      if (this.targetDir.lengthSq() > 0.001) {
        const restSpine = restDirections.get('spine') ?? this.REST_UP;
        this.rotateBone('spine', bones.spine, restSpine, this.targetDir, initialRotations, initialWorldRotations);
        const restChest = restDirections.get('chest') ?? this.REST_UP;
        this.rotateBone('chest', bones.chest, restChest, this.targetDir, initialRotations, initialWorldRotations);
      }
    }
    // -------------------------------------------------------------
    // 3. NECK & HEAD
    // -------------------------------------------------------------
    const p7 = worldLandmarks[7];
    const p8 = worldLandmarks[8];
    const earMidX = (p7.x + p8.x) * 0.5;
    const earMidY = (p7.y + p8.y) * 0.5;
    const earMidZ = (p7.z + p8.z) * 0.5;

    if (this.hasTrackingConfidence(p7, p8, p11, p12)) {
      const neckDx = earMidX - shMidX;
      const neckDy = earMidY - shMidY;
      const neckDz = earMidZ - shMidZ;
      this.targetDir.set(neckDx, -neckDy, -neckDz).normalize();

      if (this.targetDir.lengthSq() > 0.001) {
        const restNeck = restDirections.get('neck') ?? this.REST_UP;
        this.rotateBone('neck', bones.neck, restNeck, this.targetDir, initialRotations, initialWorldRotations);
      }
    }

    // Head orientation: face direction from ear line to nose
    const nose = worldLandmarks[0];
    if (this.hasTrackingConfidence(nose, p7, p8)) {
      const faceDx = nose.x - earMidX;
      const faceDy = nose.y - earMidY;
      const faceDz = nose.z - earMidZ;
      this.targetDir.set(faceDx, -faceDy, -faceDz).normalize();
      if (this.targetDir.lengthSq() > 0.001 && bones.head) {
        const restHead = restDirections.get('head') ?? this.REST_FORWARD;
        const filtered = this.headDirectionFilter.filter(
          { x: this.targetDir.x, y: this.targetDir.y, z: this.targetDir.z },
          timestampMs
        );
        const yaw = THREE.MathUtils.clamp(Math.atan2(filtered.x, filtered.z), -Math.PI / 3, Math.PI / 3);
        const pitch = THREE.MathUtils.clamp(
          Math.atan2(filtered.y, Math.hypot(filtered.x, filtered.z)),
          -Math.PI / 6,
          Math.PI / 6
        );
        this.targetDir.set(
          Math.cos(pitch) * Math.sin(yaw),
          Math.sin(pitch),
          Math.cos(pitch) * Math.cos(yaw)
        );
        this.rotateBone('head', bones.head, restHead, this.targetDir, initialRotations, initialWorldRotations);
      }
    }

    // -------------------------------------------------------------
    // 4. ARMS & WRISTS RETARGETING (Shoulder Shrug, Wrists)
    // -------------------------------------------------------------
    const sLeftSh = worldLandmarks[11];
    const sLeftEl = worldLandmarks[13];
    const sLeftWr = worldLandmarks[15];
    const sLeftIdx = worldLandmarks[19];
    const sRightSh = worldLandmarks[12];
    const sRightEl = worldLandmarks[14];
    const sRightWr = worldLandmarks[16];
    const sRightIdx = worldLandmarks[20];

    // Clavicle / Shoulder Shrug (Clavicles lift naturally when hands go up)
    if (bones.leftShoulder && this.hasTrackingConfidence(sLeftSh, sLeftEl)) {
      const armLift = Math.max(0, sLeftSh.y - sLeftEl.y);
      const shrugAngle = Math.min(0.26, armLift * 0.7);
      const initShQ = initialRotations.get('leftShoulder') ?? new THREE.Quaternion();
      const shrugQ = new THREE.Quaternion().setFromAxisAngle(this.REST_FORWARD, shrugAngle);
      bones.leftShoulder.quaternion.copy(initShQ).multiply(shrugQ);
      bones.leftShoulder.updateWorldMatrix(true, false);
    }
    if (bones.rightShoulder && this.hasTrackingConfidence(sRightSh, sRightEl)) {
      const armLift = Math.max(0, sRightSh.y - sRightEl.y);
      const shrugAngle = Math.min(0.26, armLift * 0.7);
      const initShQ = initialRotations.get('rightShoulder') ?? new THREE.Quaternion();
      const shrugQ = new THREE.Quaternion().setFromAxisAngle(this.REST_FORWARD, -shrugAngle);
      bones.rightShoulder.quaternion.copy(initShQ).multiply(shrugQ);
      bones.rightShoulder.updateWorldMatrix(true, false);
    }

    // Upper Arms: Shoulder -> Elbow
    if (this.hasTrackingConfidence(sLeftSh, sLeftEl)) {
      this.computeArmVector(sLeftSh, sLeftEl, false, this.targetDir);
      if (this.targetDir.lengthSq() > 0.001) {
        const restArm = restDirections.get('leftUpperArm') ?? this.REST_RIGHT;
        this.rotateBone('leftUpperArm', bones.leftUpperArm, restArm, this.targetDir, initialRotations, initialWorldRotations);
      }
    }

    if (this.hasTrackingConfidence(sRightSh, sRightEl)) {
      this.computeArmVector(sRightSh, sRightEl, true, this.targetDir);
      if (this.targetDir.lengthSq() > 0.001) {
        const restArm = restDirections.get('rightUpperArm') ?? this.REST_LEFT;
        this.rotateBone('rightUpperArm', bones.rightUpperArm, restArm, this.targetDir, initialRotations, initialWorldRotations);
      }
    }

    // Forearms: Elbow -> Wrist
    if (this.hasTrackingConfidence(sLeftEl, sLeftWr)) {
      this.computeArmVector(sLeftEl, sLeftWr, false, this.targetDir);
      if (this.targetDir.lengthSq() > 0.001) {
        const restForearm = restDirections.get('leftLowerArm') ?? this.REST_RIGHT;
        this.rotateBone('leftLowerArm', bones.leftLowerArm, restForearm, this.targetDir, initialRotations, initialWorldRotations);
      }
    }

    if (this.hasTrackingConfidence(sRightEl, sRightWr)) {
      this.computeArmVector(sRightEl, sRightWr, true, this.targetDir);
      if (this.targetDir.lengthSq() > 0.001) {
        const restForearm = restDirections.get('rightLowerArm') ?? this.REST_LEFT;
        this.rotateBone('rightLowerArm', bones.rightLowerArm, restForearm, this.targetDir, initialRotations, initialWorldRotations);
      }
    }

    // Hands & Wrists: Wrist -> Index Knuckle
    if (this.hasTrackingConfidence(sLeftWr, sLeftIdx)) {
      this.computeHandVector(sLeftWr, sLeftIdx, false, this.targetDir);
      if (this.targetDir.lengthSq() > 0.001) {
        const restHand = restDirections.get('leftHand') ?? this.REST_RIGHT;
        this.rotateBone('leftHand', bones.leftHand, restHand, this.targetDir, initialRotations, initialWorldRotations);
      }
    }

    if (this.hasTrackingConfidence(sRightWr, sRightIdx)) {
      this.computeHandVector(sRightWr, sRightIdx, true, this.targetDir);
      if (this.targetDir.lengthSq() > 0.001) {
        const restHand = restDirections.get('rightHand') ?? this.REST_LEFT;
        this.rotateBone('rightHand', bones.rightHand, restHand, this.targetDir, initialRotations, initialWorldRotations);
      }
    }

    // 5. LEGS & FEET
    const sLeftHip = worldLandmarks[23];
    const sLeftKnee = worldLandmarks[25];
    let sLeftAnkle = plantedLandmarks[27] ?? worldLandmarks[27];
    let sLeftToe = plantedLandmarks[31] ?? worldLandmarks[31];
    const sRightHip = worldLandmarks[24];
    const sRightKnee = worldLandmarks[26];
    let sRightAnkle = plantedLandmarks[28] ?? worldLandmarks[28];
    let sRightToe = plantedLandmarks[32] ?? worldLandmarks[32];

    if (this.hasTrackingConfidence(sLeftHip, sLeftKnee)) {
      this.computeLegVector(sLeftHip, sLeftKnee, this.targetDir);
      if (this.targetDir.lengthSq() > 0.001) {
        this.rotateBone(
          'leftUpperLeg', bones.leftUpperLeg,
          restDirections.get('leftUpperLeg') ?? this.REST_DOWN,
          this.targetDir, initialRotations, initialWorldRotations
        );
      }
    }

    if (this.hasTrackingConfidence(sRightHip, sRightKnee)) {
      this.computeLegVector(sRightHip, sRightKnee, this.targetDir);
      if (this.targetDir.lengthSq() > 0.001) {
        this.rotateBone(
          'rightUpperLeg', bones.rightUpperLeg,
          restDirections.get('rightUpperLeg') ?? this.REST_DOWN,
          this.targetDir, initialRotations, initialWorldRotations
        );
      }
    }

    if (this.hasTrackingConfidence(sLeftKnee, sLeftAnkle)) {
      this.computeLegVector(sLeftKnee, sLeftAnkle, this.targetDir);
      if (this.targetDir.lengthSq() > 0.001) {
        this.rotateBone(
          'leftLowerLeg', bones.leftLowerLeg,
          restDirections.get('leftLowerLeg') ?? this.REST_DOWN,
          this.targetDir, initialRotations, initialWorldRotations
        );
      }
    }

    if (this.hasTrackingConfidence(sRightKnee, sRightAnkle)) {
      this.computeLegVector(sRightKnee, sRightAnkle, this.targetDir);
      if (this.targetDir.lengthSq() > 0.001) {
        this.rotateBone(
          'rightLowerLeg', bones.rightLowerLeg,
          restDirections.get('rightLowerLeg') ?? this.REST_DOWN,
          this.targetDir, initialRotations, initialWorldRotations
        );
      }
    }

    if (this.hasTrackingConfidence(sLeftAnkle, sLeftToe)) {
      this.computeFootVector(sLeftAnkle, sLeftToe, this.targetDir);
      if (this.targetDir.lengthSq() > 0.001) {
        this.rotateBone(
          'leftFoot', bones.leftFoot,
          restDirections.get('leftFoot') ?? this.REST_FORWARD,
          this.targetDir, initialRotations, initialWorldRotations
        );
      }
    }

    if (this.hasTrackingConfidence(sRightAnkle, sRightToe)) {
      this.computeFootVector(sRightAnkle, sRightToe, this.targetDir);
      if (this.targetDir.lengthSq() > 0.001) {
        this.rotateBone(
          'rightFoot', bones.rightFoot,
          restDirections.get('rightFoot') ?? this.REST_FORWARD,
          this.targetDir, initialRotations, initialWorldRotations
        );
      }
    }

    this.applyWorldYaw(bones.hips);
    if (character && this.groundReferenceY !== null && !this.isJumping) {
      character.updateMatrixWorld(true);
      const footHeights = [bones.leftFoot, bones.rightFoot]
        .filter((foot): foot is THREE.Bone => !!foot)
        .map((foot) => foot.getWorldPosition(this.tempVecC).y);
      if (footHeights.length > 0) {
        const correction = THREE.MathUtils.clamp(
          this.groundReferenceY - Math.min(...footHeights),
          -0.2,
          0.2
        );
        character.position.y = this.rootStartPosition.y +
          this.groundCorrection.filter(correction, timestampMs);
      }
    }
  }

  private updateRootPosition(root: THREE.Object3D, landmarks: Point3D[], timestampMs: number): void {
    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];
    const leftHip = landmarks[23];
    const rightHip = landmarks[24];
    if (
      landmarks.length < 33 ||
      !this.hasTrackingConfidence(leftShoulder, rightShoulder, leftHip, rightHip) ||
      ![leftShoulder, rightShoulder, leftHip, rightHip].every(
        (point) => Number.isFinite(point.x) && Number.isFinite(point.y)
      )
    ) {
      return;
    }

    const hipX = (leftHip.x + rightHip.x) * 0.5;
    const shoulderX = (leftShoulder.x + rightShoulder.x) * 0.5;
    const shoulderY = (leftShoulder.y + rightShoulder.y) * 0.5;
    const hipY = (leftHip.y + rightHip.y) * 0.5;
    const torsoLength = Math.hypot(shoulderX - hipX, shoulderY - hipY);
    if (torsoLength < 0.05) return;

    if (this.trackingRoot !== root) {
      this.trackingRoot = root;
      this.rootStartPosition.copy(root.position);
      this.initialHipX = hipX;
      this.initialTorsoLength = torsoLength;
      this.baselineHipY = hipY;
      this.previousHipY = hipY;
      this.previousHipTimestamp = timestampMs;
      this.jumpStartedAt = null;
      this.isJumping = false;
      this.jumpHeightFilter.reset();
      this.rootXFilter.reset();
      this.rootZFilter.reset();
      this.groundReferenceY = null;
      this.groundCorrection.reset();
      this.leftFootPlant = this.createFootPlantState();
      this.rightFootPlant = this.createFootPlantState();
    }
    if (this.initialHipX === null || this.initialTorsoLength === null) return;

    const elapsed = this.previousHipTimestamp === null
      ? 0
      : (timestampMs - this.previousHipTimestamp) / 1000;
    const upwardSpeed = elapsed > 0 && this.previousHipY !== null
      ? (this.previousHipY - hipY) / elapsed
      : 0;

    if (this.baselineHipY === null) this.baselineHipY = hipY;
    if (!this.isJumping && elapsed > 0 && Math.abs(upwardSpeed) < 0.12) {
      this.baselineHipY += (hipY - this.baselineHipY) * 0.015;
    }

    if (
      !this.isJumping &&
      this.baselineHipY !== null &&
      this.baselineHipY - hipY > 0.018 &&
      upwardSpeed > 0.22
    ) {
      this.isJumping = true;
      this.jumpStartedAt = timestampMs;
    }

    let jumpHeight = 0;
    if (this.isJumping && this.baselineHipY !== null) {
      jumpHeight = THREE.MathUtils.clamp(
        (this.baselineHipY - hipY) * (0.5 / this.initialTorsoLength) * 1.5,
        0,
        0.75
      );
      const jumpDuration = timestampMs - (this.jumpStartedAt ?? timestampMs);
      if (jumpDuration > 180 && hipY >= this.baselineHipY - 0.018 && upwardSpeed < 0.12) {
        this.isJumping = false;
        this.jumpStartedAt = null;
        jumpHeight = 0;
      }
    }
    root.position.y = this.rootStartPosition.y + this.jumpHeightFilter.filter(jumpHeight, timestampMs);
    this.previousHipY = hipY;
    this.previousHipTimestamp = timestampMs;

    const metersPerImageHeight = THREE.MathUtils.clamp(0.5 / this.initialTorsoLength, 1, 3.5);
    const horizontalOffset = THREE.MathUtils.clamp(
      (hipX - this.initialHipX) * metersPerImageHeight,
      -0.75,
      0.75
    );
    const depthOffset = THREE.MathUtils.clamp(
      (torsoLength / this.initialTorsoLength - 1) * 1.5,
      -0.6,
      0.6
    );

    root.position.x = this.rootStartPosition.x + this.rootXFilter.filter(horizontalOffset, timestampMs);
    root.position.z = this.rootStartPosition.z + this.rootZFilter.filter(depthOffset, timestampMs);
  }

  private updateFootPlants(
    landmarks: Point3D[],
    landmarks2D: Point3D[],
    hips: THREE.Bone,
    timestampMs: number
  ): (Point3D | undefined)[] {
    const plantedLandmarks: (Point3D | undefined)[] = [];
    this.updateFootPlant(
      this.leftFootPlant, landmarks, landmarks2D, 27, 31, hips, timestampMs, plantedLandmarks
    );
    this.updateFootPlant(
      this.rightFootPlant, landmarks, landmarks2D, 28, 32, hips, timestampMs, plantedLandmarks
    );
    return plantedLandmarks;
  }

  private updateFootPlant(
    state: FootPlantState,
    landmarks: Point3D[],
    landmarks2D: Point3D[],
    ankleIndex: number,
    toeIndex: number,
    hips: THREE.Bone,
    timestampMs: number,
    plantedLandmarks: (Point3D | undefined)[]
  ): void {
    const ankle = landmarks[ankleIndex];
    const toe = landmarks[toeIndex];
    const imageAnkle = landmarks2D[ankleIndex];
    const visible = this.hasTrackingConfidence(ankle, imageAnkle) &&
      Number.isFinite(imageAnkle.x) && Number.isFinite(imageAnkle.y);

    if (visible) {
      const elapsed = state.previousTimestamp === null
        ? 0
        : (timestampMs - state.previousTimestamp) / 1000;
      const imageSpeed = elapsed > 0 && state.previousImageY !== null
        ? Math.abs(imageAnkle.y - state.previousImageY) / elapsed
        : Number.POSITIVE_INFINITY;
      state.lowestImageY = Math.max(state.lowestImageY, imageAnkle.y);
      state.lastSeenTimestamp = timestampMs;

      const atFloor = imageAnkle.y >= state.lowestImageY - 0.015;
      if (state.anchorAnkle && (!atFloor || imageSpeed > 0.6)) {
        state.anchorAnkle = null;
        state.anchorToe = null;
      } else if (!state.anchorAnkle && atFloor && imageSpeed < 0.2) {
        hips.getWorldPosition(this.tempVecA);
        state.anchorAnkle = this.sourcePointToWorld(ankle, this.tempVecA);
        if (this.hasTrackingConfidence(toe)) {
          state.anchorToe = this.sourcePointToWorld(toe, this.tempVecA);
        }
      }

      state.previousImageY = imageAnkle.y;
      state.previousTimestamp = timestampMs;
    } else if (timestampMs - state.lastSeenTimestamp > 150) {
      state.anchorAnkle = null;
      state.anchorToe = null;
    }

    if (!state.anchorAnkle) return;

    hips.getWorldPosition(this.tempVecA);
    plantedLandmarks[ankleIndex] = this.worldPointToSource(state.anchorAnkle, this.tempVecA, ankle.visibility);
    if (state.anchorToe && this.hasTrackingConfidence(toe)) {
      plantedLandmarks[toeIndex] = this.worldPointToSource(state.anchorToe, this.tempVecA, toe.visibility);
    }
  }

  private sourcePointToWorld(point: Point3D, origin: THREE.Vector3): THREE.Vector3 {
    return new THREE.Vector3(point.x, -point.y, -point.z).add(origin);
  }

  private worldPointToSource(point: THREE.Vector3, origin: THREE.Vector3, visibility?: number): Point3D {
    const relative = point.clone().sub(origin);
    return { x: relative.x, y: -relative.y, z: -relative.z, visibility };
  }

  private createFootPlantState(): FootPlantState {
    return {
      anchorAnkle: null,
      anchorToe: null,
      lowestImageY: Number.NEGATIVE_INFINITY,
      previousImageY: null,
      previousTimestamp: null,
      lastSeenTimestamp: Number.NEGATIVE_INFINITY,
    };
  }

  /**
   * Computes arm vector matching screen-space directions cleanly.
   */
  private computeArmVector(pA: Point3D, pB: Point3D, isScreenRight: boolean, out: THREE.Vector3): void {
    const rawDx = pB.x - pA.x;
    const rawDy = pB.y - pA.y;
    const rawDz = pB.z - pA.z;
    const sx = rawDx;
    const sy = -rawDy;
    const sz = -rawDz;
    out.set(sx, sy, sz).normalize();
  }

  /**
   * Computes hand direction vector from wrist to index knuckle.
   */
  private computeHandVector(pA: Point3D, pB: Point3D, isScreenRight: boolean, out: THREE.Vector3): void {
    const rawDx = pB.x - pA.x;
    const rawDy = pB.y - pA.y;
    const rawDz = pB.z - pA.z;
    const sx = rawDx;
    const sy = -rawDy;
    const sz = -rawDz;
    out.set(sx, sy, sz).normalize();
  }

  private computeLegVector(pA: Point3D, pB: Point3D, out: THREE.Vector3): void {
    out.set(pB.x - pA.x, pA.y - pB.y, pA.z - pB.z).normalize();
  }

  private computeFootVector(pAnkle: Point3D, pToe: Point3D, out: THREE.Vector3): void {
    out.set(
      pToe.x - pAnkle.x,
      pAnkle.y - pToe.y,
      Math.max(0.04, pAnkle.z - pToe.z)
    ).normalize();
  }

  private hasTrackingConfidence(...points: Point3D[]): boolean {
    return points.every((point) => (point.visibility ?? 1) >= 0.5);
  }

  private applyWorldYaw(bone?: THREE.Bone): void {
    if (!bone) return;

    if (bone.parent) {
      bone.parent.getWorldQuaternion(this.parentWorldQ);
    } else {
      this.parentWorldQ.identity();
    }

    this.parentWorldInv.copy(this.parentWorldQ).invert();
    this.worldNewQ.copy(this.parentWorldQ).multiply(bone.quaternion).premultiply(this.yawQuat);
    bone.quaternion.copy(this.parentWorldInv).multiply(this.worldNewQ);
    bone.updateWorldMatrix(true, false);
  }

  /**
   * Applies exact rotation delta to a bone relative to parent's world matrix.
   * If initialWorldRotations is available, computes the exact true world-space transform.
   */
  private rotateBone(
    boneKey: string,
    bone: THREE.Bone | undefined,
    restDir: THREE.Vector3,
    targetDir: THREE.Vector3,
    initialRotations: Map<string, THREE.Quaternion>,
    initialWorldRotations?: Map<string, THREE.Quaternion>
  ): void {
    if (!bone) return;

    this.tempVecB.copy(targetDir).applyQuaternion(this.inverseYawQuat).normalize();
    this.deltaRot.setFromUnitVectors(restDir, this.tempVecB);
    if (this.motionStrength !== 1) {
      const angle = 2 * Math.acos(THREE.MathUtils.clamp(this.deltaRot.w, -1, 1));
      this.tempVecC.set(this.deltaRot.x, this.deltaRot.y, this.deltaRot.z);
      if (this.tempVecC.lengthSq() > 1e-8) {
        this.deltaRot.setFromAxisAngle(this.tempVecC.normalize(), angle * this.motionStrength);
      }
    }

    const initialWorldQ = initialWorldRotations?.get(boneKey);

    if (initialWorldQ && bone.parent && (bone.parent as THREE.Bone).isBone) {
      // True world orientation = deltaRot * initialWorldQ
      this.worldNewQ.copy(this.deltaRot).multiply(initialWorldQ);
      bone.parent.getWorldQuaternion(this.parentWorldQ);
      this.parentWorldInv.copy(this.parentWorldQ).invert();
      // Local orientation = parentWorldInv * worldNewQ
      bone.quaternion.copy(this.parentWorldInv).multiply(this.worldNewQ);
    } else {
      const initialQ = initialRotations.get(boneKey);
      if (!initialQ) return;
      if (bone.parent && (bone.parent as THREE.Bone).isBone) {
        bone.parent.getWorldQuaternion(this.parentWorldQ);
        this.parentWorldInv.copy(this.parentWorldQ).invert();
        this.worldRestQ.copy(this.parentWorldQ).multiply(initialQ);
        this.worldNewQ.copy(this.deltaRot).multiply(this.worldRestQ);
        bone.quaternion.copy(this.parentWorldInv).multiply(this.worldNewQ);
      } else {
        bone.quaternion.copy(this.deltaRot).multiply(initialQ);
      }
    }

    // Immediately update world matrix so child bones receive the true updated world transform
    bone.updateWorldMatrix(true, false);
  }
}
