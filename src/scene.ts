/**
 * Three.js 3D Viewport:
 * - High-Fidelity Cyber Humanoid Avatar (Athletic anatomy, sculpted armor plates,
 *   illuminated chest reactor, aerodynamic visor, articulated hands/fingers, and mechanical joints).
 * - Three selectable built-in procedural humanoid styles.
 * - Automatic 1.75m height normalization, floor alignment, and dynamic rest-pose direction mapping.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type AvatarStyle = 'cyber' | 'feminine' | 'crash-test';

export interface HumanoidBones {
  hips?: THREE.Bone;
  spine?: THREE.Bone;
  chest?: THREE.Bone;
  neck?: THREE.Bone;
  head?: THREE.Bone;
  leftShoulder?: THREE.Bone;
  leftUpperArm?: THREE.Bone;
  leftLowerArm?: THREE.Bone;
  leftHand?: THREE.Bone;
  rightShoulder?: THREE.Bone;
  rightUpperArm?: THREE.Bone;
  rightLowerArm?: THREE.Bone;
  rightHand?: THREE.Bone;
  leftUpperLeg?: THREE.Bone;
  leftLowerLeg?: THREE.Bone;
  leftFoot?: THREE.Bone;
  rightUpperLeg?: THREE.Bone;
  rightLowerLeg?: THREE.Bone;
  rightFoot?: THREE.Bone;
  [key: string]: THREE.Bone | undefined;
}

export class SceneManager {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public renderer: THREE.WebGLRenderer;
  public controls: OrbitControls;

  public character: THREE.Group | THREE.Object3D | null = null;
  public bones: HumanoidBones = {};
  public initialBoneRotations: Map<string, THREE.Quaternion> = new Map();
  public initialBonePositions: Map<string, THREE.Vector3> = new Map();
  public initialWorldRotations: Map<string, THREE.Quaternion> = new Map();
  public boneRestDirections: Map<string, THREE.Vector3> = new Map();
  public skeletonHelper: THREE.SkeletonHelper | null = null;

  public currentModelType: 'procedural' = 'procedural';
  public currentAvatarStyle: AvatarStyle = 'cyber';
  public loadedModelName = 'Cyber Mannequin';

  private container: HTMLElement;
  private animFrameId: number | null = null;
  private readonly fingerClock = new THREE.Clock();
  private gridHelper: THREE.GridHelper | null = null;
  private animatedFingers: {
    joint: THREE.Group;
    phase: number;
    speed: number;
    amount: number;
    restRotationZ: number;
  }[] = [];

  constructor(container: HTMLElement) {
    this.container = container;

    // 1. Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x080b11);
    this.scene.fog = new THREE.FogExp2(0x080b11, 0.04);

    // 2. Camera
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    this.camera.position.set(0, 1.35, 3.4);

    // 3. Renderer with tone mapping & soft shadows
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.container.appendChild(this.renderer.domElement);

    // 4. OrbitControls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.target.set(0, 1.05, 0);
    this.controls.maxPolarAngle = Math.PI / 2 + 0.05;
    this.controls.minDistance = 1.0;
    this.controls.maxDistance = 15.0;

    // 5. Studio Lighting
    this.setupLighting();

    // 6. Environment & Ground Grid
    this.setupEnvironment();

    // 7. Event listeners
    window.addEventListener('resize', this.onResize);

    // 8. Build the default humanoid
    this.createProceduralMannequin();

    // 9. Start render loop
    this.render();
  }

  private setupLighting(): void {
    // Ambient / Hemisphere light
    const hemiLight = new THREE.HemisphereLight(0xcfd8dc, 0x0f172a, 0.8);
    hemiLight.position.set(0, 20, 0);
    this.scene.add(hemiLight);

    // Key Light with soft shadows
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
    keyLight.position.set(2.5, 4.5, 3.0);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.bias = -0.0004;
    this.scene.add(keyLight);

    // Rim Spotlight from behind (Cyan/Purple cyber glow)
    const rimLight = new THREE.DirectionalLight(0x00f0ff, 1.5);
    rimLight.position.set(-2.5, 3.5, -3.0);
    this.scene.add(rimLight);

    const rimLight2 = new THREE.DirectionalLight(0xa855f7, 1.2);
    rimLight2.position.set(2.5, 2.5, -3.0);
    this.scene.add(rimLight2);

    // Soft front fill
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
    fillLight.position.set(0, 1.2, 4.0);
    this.scene.add(fillLight);
  }

  private setupEnvironment(): void {
    this.gridHelper = new THREE.GridHelper(20, 40, 0x00f0ff, 0x1e293b);
    this.gridHelper.position.y = -0.001;
    this.scene.add(this.gridHelper);

    // Shadow catcher floor
    const shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.ShadowMaterial({ opacity: 0.4 })
    );
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.receiveShadow = true;
    this.scene.add(shadowPlane);
  }

  private onResize = (): void => {
    if (!this.container) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private findAndMapBones(root: THREE.Object3D): number {
    this.bones = {};
    this.initialBoneRotations.clear();
    this.initialBonePositions.clear();
    this.initialWorldRotations.clear();
    this.boneRestDirections.clear();

    const boneList: THREE.Bone[] = [];
    root.traverse((child) => {
      if ((child as THREE.Bone).isBone) {
        boneList.push(child as THREE.Bone);
      }
    });

    const findBone = (keywords: string[]): THREE.Bone | undefined => {
      return boneList.find((b) => {
        const lower = b.name.toLowerCase().replace(/[-_:]/g, '');
        return keywords.some((kw) => lower.includes(kw.toLowerCase().replace(/[-_:]/g, '')));
      });
    };

    this.bones.hips = findBone(['hips', 'pelvis', 'root', 'defhip', 'bip01pelvis']);
    this.bones.spine = findBone(['spine1', 'spine01', 'spine', 'defspine']);
    this.bones.chest = findBone(['spine2', 'spine02', 'chest', 'upperchest', 'defchest']);
    this.bones.neck = findBone(['neck', 'defneck']);
    this.bones.head = findBone(['head', 'defhead']);

    this.bones.leftShoulder = findBone(['leftshoulder', 'shoulderl', 'lshoulder', 'defshoulderl']);
    this.bones.leftUpperArm = findBone(['leftarm', 'upperarml', 'lupperarm', 'arm.l', 'leftupperarm', 'defupperarml']);
    this.bones.leftLowerArm = findBone(['leftforearm', 'lowerarml', 'llowerarm', 'forearml', 'leftlowerarm', 'defforearml']);
    this.bones.leftHand = findBone(['lefthand', 'handl', 'lhand', 'defhandl']);

    this.bones.rightShoulder = findBone(['rightshoulder', 'shoulderr', 'rshoulder', 'defshoulderr']);
    this.bones.rightUpperArm = findBone(['rightarm', 'upperarmr', 'rupperarm', 'arm.r', 'rightupperarm', 'defupperarmr']);
    this.bones.rightLowerArm = findBone(['rightforearm', 'lowerarmr', 'rlowerarm', 'forearmr', 'rightlowerarm', 'defforearmr']);
    this.bones.rightHand = findBone(['righthand', 'handr', 'rhand', 'defhandr']);

    this.bones.leftUpperLeg = findBone(['leftupleg', 'thighl', 'lthigh', 'leftthigh', 'leftupperleg', 'defthighl']);
    this.bones.leftLowerLeg = findBone(['leftleg', 'calfl', 'lcalf', 'leftcalf', 'leftlowerleg', 'defcalfl', 'shinl']);
    this.bones.leftFoot = findBone(['leftfoot', 'footl', 'lfoot', 'deffootl']);

    this.bones.rightUpperLeg = findBone(['rightupleg', 'thighr', 'rthigh', 'rightthigh', 'rightupperleg', 'defthighr']);
    this.bones.rightLowerLeg = findBone(['rightleg', 'calfr', 'rcalf', 'rightcalf', 'rightlowerleg', 'defcalfr', 'shinr']);
    this.bones.rightFoot = findBone(['rightfoot', 'footr', 'rfoot', 'deffootr']);

    root.updateMatrixWorld(true);

    for (const [key, bone] of Object.entries(this.bones)) {
      if (bone) {
        this.initialBoneRotations.set(key, bone.quaternion.clone());
        this.initialBonePositions.set(key, bone.position.clone());
        const wQ = new THREE.Quaternion();
        bone.getWorldQuaternion(wQ);
        this.initialWorldRotations.set(key, wQ);
      }
    }

    const getRestDir = (parentBone?: THREE.Bone, childBone?: THREE.Bone, fallback = new THREE.Vector3(0, 1, 0)): THREE.Vector3 => {
      if (parentBone && childBone) {
        const p1 = parentBone.getWorldPosition(new THREE.Vector3());
        const p2 = childBone.getWorldPosition(new THREE.Vector3());
        const dir = p2.sub(p1).normalize();
        if (dir.lengthSq() > 0.001) return dir;
      }
      return fallback.clone();
    };

    this.boneRestDirections.set('spine', getRestDir(this.bones.spine, this.bones.chest, new THREE.Vector3(0, 1, 0)));
    this.boneRestDirections.set('chest', getRestDir(this.bones.chest, this.bones.neck, new THREE.Vector3(0, 1, 0)));
    this.boneRestDirections.set('neck', getRestDir(this.bones.neck, this.bones.head, new THREE.Vector3(0, 1, 0)));
    this.boneRestDirections.set('head', new THREE.Vector3(0, 0, 1));

    this.boneRestDirections.set('leftShoulder', getRestDir(this.bones.leftShoulder, this.bones.leftUpperArm, new THREE.Vector3(1, 0, 0)));
    this.boneRestDirections.set('leftUpperArm', getRestDir(this.bones.leftUpperArm, this.bones.leftLowerArm, new THREE.Vector3(1, 0, 0)));
    this.boneRestDirections.set('leftLowerArm', getRestDir(this.bones.leftLowerArm, this.bones.leftHand, new THREE.Vector3(1, 0, 0)));
    this.boneRestDirections.set('leftHand', new THREE.Vector3(1, 0, 0));

    this.boneRestDirections.set('rightShoulder', getRestDir(this.bones.rightShoulder, this.bones.rightUpperArm, new THREE.Vector3(-1, 0, 0)));
    this.boneRestDirections.set('rightUpperArm', getRestDir(this.bones.rightUpperArm, this.bones.rightLowerArm, new THREE.Vector3(-1, 0, 0)));
    this.boneRestDirections.set('rightLowerArm', getRestDir(this.bones.rightLowerArm, this.bones.rightHand, new THREE.Vector3(-1, 0, 0)));
    this.boneRestDirections.set('rightHand', new THREE.Vector3(-1, 0, 0));

    this.boneRestDirections.set('leftUpperLeg', getRestDir(this.bones.leftUpperLeg, this.bones.leftLowerLeg, new THREE.Vector3(0, -1, 0)));
    this.boneRestDirections.set('leftLowerLeg', getRestDir(this.bones.leftLowerLeg, this.bones.leftFoot, new THREE.Vector3(0, -1, 0)));
    this.boneRestDirections.set('leftFoot', new THREE.Vector3(0, 0, 1));

    this.boneRestDirections.set('rightUpperLeg', getRestDir(this.bones.rightUpperLeg, this.bones.rightLowerLeg, new THREE.Vector3(0, -1, 0)));
    this.boneRestDirections.set('rightLowerLeg', getRestDir(this.bones.rightLowerLeg, this.bones.rightFoot, new THREE.Vector3(0, -1, 0)));
    this.boneRestDirections.set('rightFoot', new THREE.Vector3(0, 0, 1));

    let mappedCount = 0;
    for (const val of Object.values(this.bones)) {
      if (val) mappedCount++;
    }
    return mappedCount;
  }

  /**
   * Builds a procedural avatar style on the shared tracking rig.
   */
  public createProceduralMannequin(style: AvatarStyle = 'cyber'): void {
    this.animatedFingers = [];
    if (this.character) {
      this.disposeObject(this.character);
      this.scene.remove(this.character);
      this.character = null;
    }

    if (this.skeletonHelper) {
      this.scene.remove(this.skeletonHelper);
      this.skeletonHelper.dispose();
      this.skeletonHelper = null;
    }

    const group = new THREE.Group();
    const isFeminine = style === 'feminine';
    const isCrashTest = style === 'crash-test';
    const modelName = style === 'cyber'
      ? 'Cyber Mannequin'
      : isFeminine
        ? 'Nova — Femme Android'
        : 'Crash Test Dummy';
    group.name = modelName.replace(/[^a-z0-9]/gi, '');

    // -------------------------------------------------------------
    // 1. ANATOMICAL SKELETON HIERARCHY (Standard 1.80m Humanoid Rig)
    // -------------------------------------------------------------
    const hips = new THREE.Bone();
    hips.name = 'Hips';
    hips.position.set(0, isFeminine ? 0.93 : 0.94, 0);

    const spine = new THREE.Bone();
    spine.name = 'Spine';
    spine.position.set(0, 0.18, 0);
    hips.add(spine);

    const chest = new THREE.Bone();
    chest.name = 'Chest';
    chest.position.set(0, 0.22, 0);
    spine.add(chest);

    const neck = new THREE.Bone();
    neck.name = 'Neck';
    neck.position.set(0, 0.16, 0);
    chest.add(neck);

    const head = new THREE.Bone();
    head.name = 'Head';
    head.position.set(0, 0.14, 0);
    neck.add(head);

    // Left Arm (Clavicle, Upper Arm, Forearm, Hand)
    const leftShoulder = new THREE.Bone();
    leftShoulder.name = 'LeftShoulder';
    leftShoulder.position.set(isFeminine ? 0.105 : 0.12, 0.14, 0);
    chest.add(leftShoulder);

    const leftUpperArm = new THREE.Bone();
    leftUpperArm.name = 'LeftArm';
    leftUpperArm.position.set(isFeminine ? 0.13 : 0.14, 0, 0);
    leftShoulder.add(leftUpperArm);

    const leftLowerArm = new THREE.Bone();
    leftLowerArm.name = 'LeftForeArm';
    leftLowerArm.position.set(0.28, 0, 0);
    leftUpperArm.add(leftLowerArm);

    const leftHand = new THREE.Bone();
    leftHand.name = 'LeftHand';
    leftHand.position.set(0.26, 0, 0);
    leftLowerArm.add(leftHand);

    // Right Arm (Clavicle, Upper Arm, Forearm, Hand)
    const rightShoulder = new THREE.Bone();
    rightShoulder.name = 'RightShoulder';
    rightShoulder.position.set(isFeminine ? -0.105 : -0.12, 0.14, 0);
    chest.add(rightShoulder);

    const rightUpperArm = new THREE.Bone();
    rightUpperArm.name = 'RightArm';
    rightUpperArm.position.set(isFeminine ? -0.13 : -0.14, 0, 0);
    rightShoulder.add(rightUpperArm);

    const rightLowerArm = new THREE.Bone();
    rightLowerArm.name = 'RightForeArm';
    rightLowerArm.position.set(-0.28, 0, 0);
    rightUpperArm.add(rightLowerArm);

    const rightHand = new THREE.Bone();
    rightHand.name = 'RightHand';
    rightHand.position.set(-0.26, 0, 0);
    rightLowerArm.add(rightHand);

    // Left Leg (Thigh, Calf, Foot)
    const leftUpperLeg = new THREE.Bone();
    leftUpperLeg.name = 'LeftUpLeg';
    leftUpperLeg.position.set(0.11, -0.04, 0);
    hips.add(leftUpperLeg);

    const leftLowerLeg = new THREE.Bone();
    leftLowerLeg.name = 'LeftLeg';
    leftLowerLeg.position.set(0, -0.44, 0);
    leftUpperLeg.add(leftLowerLeg);

    const leftFoot = new THREE.Bone();
    leftFoot.name = 'LeftFoot';
    leftFoot.position.set(0, -0.42, 0.04);
    leftLowerLeg.add(leftFoot);

    // Right Leg (Thigh, Calf, Foot)
    const rightUpperLeg = new THREE.Bone();
    rightUpperLeg.name = 'RightUpLeg';
    rightUpperLeg.position.set(-0.11, -0.04, 0);
    hips.add(rightUpperLeg);

    const rightLowerLeg = new THREE.Bone();
    rightLowerLeg.name = 'RightLeg';
    rightLowerLeg.position.set(0, -0.44, 0);
    rightUpperLeg.add(rightLowerLeg);

    const rightFoot = new THREE.Bone();
    rightFoot.name = 'RightFoot';
    rightFoot.position.set(0, -0.42, 0.04);
    rightLowerLeg.add(rightFoot);

    group.add(hips);

    // -------------------------------------------------------------
    // 2. STYLE-SPECIFIC PBR MATERIALS
    // -------------------------------------------------------------
    // Pearlescent Satin Titanium Armor Plates
    const matHumanoidArmor = new THREE.MeshStandardMaterial({
      color: isCrashTest ? 0xffc928 : isFeminine ? 0xe9c8d9 : 0xdde6ed,
      metalness: isCrashTest ? 0.12 : isFeminine ? 0.22 : 0.35,
      roughness: isCrashTest ? 0.48 : isFeminine ? 0.32 : 0.28,
    });

    // Dark Obsidian Musculoskeletal Chassis & Undersuit
    const matUndersuit = new THREE.MeshStandardMaterial({
      color: isCrashTest ? 0x17191e : isFeminine ? 0x332338 : 0x111625,
      metalness: isCrashTest ? 0.12 : 0.65,
      roughness: isCrashTest ? 0.72 : 0.52,
    });

    // Liquid Mirror Chrome Ball Bearings & Condyle Pins
    const matChrome = new THREE.MeshStandardMaterial({
      color: isCrashTest ? 0xf4f3ea : isFeminine ? 0xffe6bc : 0xf8fafc,
      metalness: isCrashTest ? 0.05 : 0.98,
      roughness: isCrashTest ? 0.38 : 0.06,
    });

    // Radiant Cyan Luminescent Optic Visor & Core
    const matCyanGlow = new THREE.MeshStandardMaterial({
      color: isCrashTest ? 0xf43f5e : isFeminine ? 0xd946ef : 0x00f0ff,
      emissive: isCrashTest ? 0xf43f5e : isFeminine ? 0xd946ef : 0x00f0ff,
      emissiveIntensity: isCrashTest ? 0.7 : 1.8,
      roughness: 0.08,
    });

    // Warm Amber Telemetry Accent
    const matAmberGlow = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      emissive: 0xf59e0b,
      emissiveIntensity: 1.2,
      roughness: 0.1,
    });

    const makeMesh = (geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      return m;
    };

    // -------------------------------------------------------------
    // 3. PELVIS, HIPS & CHROME ACETABULAR SOCKETS
    // -------------------------------------------------------------
    // Contoured Pelvic Bowl
    const pelvicBowl = makeMesh(new THREE.CylinderGeometry(0.14, 0.11, 0.16, 24), matHumanoidArmor);
    pelvicBowl.scale.set(isFeminine ? 1.48 : 1.24, 1.0, 0.9);
    pelvicBowl.position.set(0, -0.02, 0);
    hips.add(pelvicBowl);

    // Inguinal crest plate
    const pubicPlate = makeMesh(new THREE.BoxGeometry(0.12, 0.08, 0.05), matHumanoidArmor);
    pubicPlate.position.set(0, -0.05, 0.08);
    hips.add(pubicPlate);

    // Gluteal contours on posterior
    const gluteL = makeMesh(new THREE.SphereGeometry(0.075, 16, 16), matHumanoidArmor);
    gluteL.scale.set(1.0, 1.15, 0.85);
    gluteL.position.set(0.065, -0.03, -0.06);
    hips.add(gluteL);

    const gluteR = makeMesh(new THREE.SphereGeometry(0.075, 16, 16), matHumanoidArmor);
    gluteR.scale.set(1.0, 1.15, 0.85);
    gluteR.position.set(-0.065, -0.03, -0.06);
    hips.add(gluteR);

    // Acetabular Chrome Hip Sockets (house the femur heads)
    const hipSocketL = makeMesh(new THREE.SphereGeometry(0.065, 20, 20), matChrome);
    hipSocketL.position.set(0.11, -0.04, 0);
    hips.add(hipSocketL);

    const hipSocketR = makeMesh(new THREE.SphereGeometry(0.065, 20, 20), matChrome);
    hipSocketR.position.set(-0.11, -0.04, 0);
    hips.add(hipSocketR);

    // Belt Telemetry Sensor
    const beltSensor = makeMesh(new THREE.BoxGeometry(0.06, 0.025, 0.02), matCyanGlow);
    beltSensor.position.set(0, 0.03, 0.10);
    hips.add(beltSensor);

    // -------------------------------------------------------------
    // 4. SPINE & LUMBAR CORE (Athletic 6-Pack & Segmented Vertebrae)
    // -------------------------------------------------------------
    const lumbarUndersuit = makeMesh(new THREE.CylinderGeometry(0.082, 0.095, 0.18, 20), matUndersuit);
    lumbarUndersuit.position.set(0, 0.09, 0);
    spine.add(lumbarUndersuit);

    // Segmented 6-Pack Rectus Abdominis Muscle Plates
    for (let i = 0; i < 3; i++) {
      const abY = 0.035 + i * 0.052;
      const abScale = 1.0 - i * 0.06;

      const abL = makeMesh(new THREE.BoxGeometry(0.072 * abScale, 0.040, 0.04), matHumanoidArmor);
      abL.position.set(0.042, abY, 0.078);
      abL.rotation.y = 0.06;
      spine.add(abL);

      const abR = makeMesh(new THREE.BoxGeometry(0.072 * abScale, 0.040, 0.04), matHumanoidArmor);
      abR.position.set(-0.042, abY, 0.078);
      abR.rotation.y = -0.06;
      spine.add(abR);
    }

    // External Oblique Muscle Flanges
    const oblL = makeMesh(new THREE.BoxGeometry(0.035, 0.14, 0.09), matHumanoidArmor);
    oblL.position.set(0.095, 0.09, 0.01);
    oblL.rotation.z = -0.12;
    spine.add(oblL);

    const oblR = makeMesh(new THREE.BoxGeometry(0.035, 0.14, 0.09), matHumanoidArmor);
    oblR.position.set(-0.095, 0.09, 0.01);
    oblR.rotation.z = 0.12;
    spine.add(oblR);

    // Posterior Articulated Vertebrae with Cyan Shock-Absorbers
    for (let i = 0; i < 4; i++) {
      const vertY = 0.025 + i * 0.045;
      const vertDisc = makeMesh(new THREE.BoxGeometry(0.042, 0.024, 0.032), matChrome);
      vertDisc.position.set(0, vertY, -0.082);
      spine.add(vertDisc);

      const vertGlow = makeMesh(new THREE.BoxGeometry(0.028, 0.008, 0.012), matCyanGlow);
      vertGlow.position.set(0, vertY, -0.096);
      spine.add(vertGlow);
    }

    // -------------------------------------------------------------
    // 5. CHEST, PECTORALS, LATISSIMUS & ARC-REACTOR CORE
    // -------------------------------------------------------------
    // Thoracic Ribcage Core
    const ribcageCore = makeMesh(new THREE.CapsuleGeometry(0.12, 0.18, 8, 20), matUndersuit);
    ribcageCore.scale.set(isFeminine ? 1.08 : 1.24, 1.0, 0.82);
    ribcageCore.position.set(0, 0.11, 0);
    chest.add(ribcageCore);

    // Sculpted Left & Right Pectoralis Major Plates
    const pectL = makeMesh(new THREE.BoxGeometry(0.135, 0.13, 0.045), matHumanoidArmor);
    pectL.position.set(0.08, 0.13, 0.105);
    pectL.rotation.set(0.06, 0.10, -0.04);
    chest.add(pectL);

    const pectR = makeMesh(new THREE.BoxGeometry(0.135, 0.13, 0.045), matHumanoidArmor);
    pectR.position.set(-0.08, 0.13, 0.105);
    pectR.rotation.set(0.06, -0.10, 0.04);
    chest.add(pectR);

    if (isFeminine) {
      pectL.scale.set(0.9, 0.92, 1.1);
      pectR.scale.set(0.9, 0.92, 1.1);
    }

    // Latissimus Dorsi athletic V-taper wing plates
    const latL = makeMesh(new THREE.BoxGeometry(0.04, 0.18, 0.12), matHumanoidArmor);
    latL.position.set(0.145, 0.10, -0.01);
    latL.rotation.z = -0.18;
    chest.add(latL);

    const latR = makeMesh(new THREE.BoxGeometry(0.04, 0.18, 0.12), matHumanoidArmor);
    latR.position.set(-0.145, 0.10, -0.01);
    latR.rotation.z = 0.18;
    chest.add(latR);

    // Sternal Arc-Reactor Core (Recessed chrome bezel & radiant cyan reactor)
    const reactorBezel = makeMesh(new THREE.CylinderGeometry(0.052, 0.052, 0.02, 24), matChrome);
    reactorBezel.rotation.x = Math.PI / 2;
    reactorBezel.position.set(0, 0.13, 0.12);
    chest.add(reactorBezel);

    const reactorCore = makeMesh(new THREE.CylinderGeometry(0.038, 0.038, 0.025, 24), matCyanGlow);
    reactorCore.rotation.x = Math.PI / 2;
    reactorCore.position.set(0, 0.13, 0.125);
    chest.add(reactorCore);

    // Clavicle Collarbone Struts
    const clavicleBar = makeMesh(new THREE.BoxGeometry(0.32, 0.028, 0.035), matHumanoidArmor);
    clavicleBar.position.set(0, 0.22, 0.06);
    chest.add(clavicleBar);

    // -------------------------------------------------------------
    // 6. NECK & CERVICAL COLUMN
    // -------------------------------------------------------------
    const neckCore = makeMesh(new THREE.CylinderGeometry(0.044, 0.052, 0.14, 20), matUndersuit);
    neckCore.position.set(0, 0.07, 0);
    neck.add(neckCore);

    // Bilateral Sternocleidomastoid Muscle Columns
    const scmL = makeMesh(new THREE.CapsuleGeometry(0.012, 0.11, 6, 12), matHumanoidArmor);
    scmL.position.set(0.035, 0.07, 0.025);
    scmL.rotation.z = 0.16;
    neck.add(scmL);

    const scmR = makeMesh(new THREE.CapsuleGeometry(0.012, 0.11, 6, 12), matHumanoidArmor);
    scmR.position.set(-0.035, 0.07, 0.025);
    scmR.rotation.z = -0.16;
    neck.add(scmR);

    // Posterior Cervical Spine Nodes
    for (let i = 0; i < 3; i++) {
      const cVert = makeMesh(new THREE.BoxGeometry(0.032, 0.018, 0.022), matChrome);
      cVert.position.set(0, 0.03 + i * 0.04, -0.045);
      neck.add(cVert);
    }

    // -------------------------------------------------------------
    // 7. SCULPTED HUMANOID CRANIUM, JAW, CHEEKBONES & VISOR
    // -------------------------------------------------------------
    // Cranium with realistic human skull ratio
    const cranium = makeMesh(new THREE.SphereGeometry(0.105, 32, 24), matHumanoidArmor);
    cranium.scale.set(0.94, 1.14, 1.06);
    cranium.position.set(0, 0.07, 0);
    head.add(cranium);

    if (isFeminine) {
      const hairMaterial = new THREE.MeshStandardMaterial({
        color: 0x392238,
        metalness: 0.24,
        roughness: 0.42,
      });
      const hairCap = makeMesh(new THREE.SphereGeometry(0.108, 24, 18), hairMaterial);
      hairCap.scale.set(1.02, 1.12, 1.06);
      hairCap.position.set(0, 0.105, -0.018);
      head.add(hairCap);

      const hairTail = makeMesh(new THREE.CapsuleGeometry(0.038, 0.19, 6, 12), hairMaterial);
      hairTail.position.set(0, -0.085, -0.09);
      hairTail.rotation.x = -0.18;
      head.add(hairTail);
    }

    if (isCrashTest) {
      const targetOuter = makeMesh(new THREE.TorusGeometry(0.052, 0.009, 10, 32), matUndersuit);
      targetOuter.position.set(0, 0.075, 0.108);
      head.add(targetOuter);
      const targetInner = makeMesh(new THREE.TorusGeometry(0.027, 0.007, 10, 24), matAmberGlow);
      targetInner.position.set(0, 0.075, 0.113);
      head.add(targetInner);
      const targetCenter = makeMesh(new THREE.SphereGeometry(0.012, 16, 12), matUndersuit);
      targetCenter.position.set(0, 0.075, 0.116);
      head.add(targetCenter);
    }

    // Chiseled Mandible / Athletic Jaw & Chin
    const jaw = makeMesh(new THREE.CylinderGeometry(0.05, 0.09, 0.08, 16), matHumanoidArmor);
    jaw.position.set(0, 0.015, 0.045);
    jaw.rotation.x = 0.35;
    head.add(jaw);

    const chin = makeMesh(new THREE.BoxGeometry(0.065, 0.045, 0.05), matHumanoidArmor);
    chin.position.set(0, -0.015, 0.085);
    head.add(chin);

    // Zygomatic Cheekbone Plates
    const cheekL = makeMesh(new THREE.BoxGeometry(0.045, 0.035, 0.05), matHumanoidArmor);
    cheekL.position.set(0.075, 0.045, 0.07);
    cheekL.rotation.y = 0.25;
    head.add(cheekL);

    const cheekR = makeMesh(new THREE.BoxGeometry(0.045, 0.035, 0.05), matHumanoidArmor);
    cheekR.position.set(-0.075, 0.045, 0.07);
    cheekR.rotation.y = -0.25;
    head.add(cheekR);

    // Aerodynamic Curved Glowing Cyan Optic Visor
    const visor = makeMesh(new THREE.TorusGeometry(0.095, 0.022, 16, 32, Math.PI * 0.65), matCyanGlow);
    visor.rotation.set(-Math.PI / 2, 0, -Math.PI * 0.325);
    visor.position.set(0, 0.08, 0.035);
    head.add(visor);

    // Dual Optic Receptor Lenses
    const eyeLensL = makeMesh(new THREE.CylinderGeometry(0.014, 0.014, 0.015, 16), matChrome);
    eyeLensL.rotation.x = Math.PI / 2;
    eyeLensL.position.set(0.038, 0.08, 0.108);
    head.add(eyeLensL);

    const eyeLensR = makeMesh(new THREE.CylinderGeometry(0.014, 0.014, 0.015, 16), matChrome);
    eyeLensR.rotation.x = Math.PI / 2;
    eyeLensR.position.set(-0.038, 0.08, 0.108);
    head.add(eyeLensR);

    // Acoustic Temporal Sensor Pods (Ears)
    const earL = makeMesh(new THREE.CylinderGeometry(0.026, 0.026, 0.024, 16), matChrome);
    earL.rotation.z = Math.PI / 2;
    earL.position.set(0.11, 0.07, 0);
    head.add(earL);

    const earR = makeMesh(new THREE.CylinderGeometry(0.026, 0.026, 0.024, 16), matChrome);
    earR.rotation.z = Math.PI / 2;
    earR.position.set(-0.11, 0.07, 0);
    head.add(earR);

    // -------------------------------------------------------------
    // 8. ARMS, DELTOID CAPS, HUMERAL BALLS & BICONDYLAR ELBOWS
    // -------------------------------------------------------------
    // Deltoid Shoulder Armor Caps (Attached to clavicle bones)
    const buildDeltoid = (bone: THREE.Bone, isRight: boolean) => {
      const deltoidGroup = new THREE.Group();
      const cap = makeMesh(new THREE.SphereGeometry(0.078, 24, 24), matHumanoidArmor);
      cap.scale.set(1.15, 1.25, 1.10);
      cap.position.set(isRight ? -0.06 : 0.06, 0, 0);
      deltoidGroup.add(cap);

      const accent = makeMesh(new THREE.BoxGeometry(0.02, 0.06, 0.03), matCyanGlow);
      accent.position.set(isRight ? -0.12 : 0.12, 0.02, 0.02);
      deltoidGroup.add(accent);
      bone.add(deltoidGroup);
    };

    buildDeltoid(leftShoulder, false);
    buildDeltoid(rightShoulder, true);

    // Upper Arm: Humeral Ball + Muscular Bicep/Tricep Capsule
    const buildUpperArm = (bone: THREE.Bone, isRight: boolean) => {
      // Chrome Humeral Head Ball (Nestled seamlessly inside the deltoid socket!)
      const humeralHead = makeMesh(new THREE.SphereGeometry(0.054, 24, 24), matChrome);
      bone.add(humeralHead);

      // Biceps & Triceps Muscular Capsule
      const muscleCapsule = makeMesh(new THREE.CapsuleGeometry(0.046, 0.18, 8, 20), matHumanoidArmor);
      muscleCapsule.rotation.z = isRight ? Math.PI / 2 : -Math.PI / 2;
      muscleCapsule.position.x = isRight ? -0.13 : 0.13;
      bone.add(muscleCapsule);

      // Tricep Posterior Horseshoe Ridge
      const tricepPlate = makeMesh(new THREE.BoxGeometry(0.16, 0.035, 0.04), matUndersuit);
      tricepPlate.position.set(isRight ? -0.13 : 0.13, 0.01, -0.035);
      bone.add(tricepPlate);
    };

    buildUpperArm(leftUpperArm, false);
    buildUpperArm(rightUpperArm, true);

    // Forearm: Bicondylar Elbow Hinge + Brachioradialis Muscle + Carpal Ring
    const buildForearm = (bone: THREE.Bone, isRight: boolean) => {
      // Polished Chrome Bicondylar Elbow Hinge Pin
      const elbowHinge = makeMesh(new THREE.CylinderGeometry(0.038, 0.038, 0.075, 20), matChrome);
      elbowHinge.rotation.x = Math.PI / 2;
      bone.add(elbowHinge);

      // Olecranon Elbow Armor Shield (wraps around elbow tip)
      const olecranon = makeMesh(new THREE.BoxGeometry(0.05, 0.045, 0.06), matHumanoidArmor);
      olecranon.position.set(0, 0, -0.035);
      bone.add(olecranon);

      // Muscular Contoured Forearm (tapers from elbow to wrist)
      const forearmMuscle = makeMesh(new THREE.CylinderGeometry(0.034, 0.046, 0.22, 20), matHumanoidArmor);
      forearmMuscle.rotation.z = isRight ? Math.PI / 2 : -Math.PI / 2;
      forearmMuscle.position.x = isRight ? -0.12 : 0.12;
      bone.add(forearmMuscle);

      // Chrome Carpal Ball at Wrist
      const wristBall = makeMesh(new THREE.SphereGeometry(0.035, 16, 16), matChrome);
      wristBall.position.x = isRight ? -0.23 : 0.23;
      bone.add(wristBall);

      // Radiant Cyan Wrist Pulse Ring
      const wristRing = makeMesh(new THREE.TorusGeometry(0.038, 0.007, 12, 24), matCyanGlow);
      wristRing.rotation.y = Math.PI / 2;
      wristRing.position.x = isRight ? -0.23 : 0.23;
      bone.add(wristRing);
    };

    buildForearm(leftLowerArm, false);
    buildForearm(rightLowerArm, true);

    // -------------------------------------------------------------
    // 9. HIGH-FIDELITY ARTICULATED 5-FINGER HUMANOID HANDS
    // -------------------------------------------------------------
    const buildArticulatedHand = (bone: THREE.Bone, isRight: boolean) => {
      const handGroup = new THREE.Group();

      // Contoured Palm with Palmar Arch
      const palm = makeMesh(new THREE.BoxGeometry(0.075, 0.026, 0.082), matHumanoidArmor);
      palm.position.set(isRight ? -0.042 : 0.042, 0, 0);
      handGroup.add(palm);

      // Thenar Eminence (fleshy muscular thumb pad)
      const thenar = makeMesh(new THREE.SphereGeometry(0.026, 16, 16), matHumanoidArmor);
      thenar.scale.set(1.2, 0.9, 1.3);
      thenar.position.set(isRight ? -0.025 : 0.025, -0.008, 0.035);
      handGroup.add(thenar);

      // Chrome Knuckle Hinge Bar
      const knuckleBar = makeMesh(new THREE.CylinderGeometry(0.012, 0.012, 0.078, 16), matChrome);
      knuckleBar.rotation.x = Math.PI / 2;
      knuckleBar.position.set(isRight ? -0.08 : 0.08, 0, 0);
      handGroup.add(knuckleBar);

      // 4 Distinct Humanoid Fingers (Index, Middle, Ring, Pinky)
      const fingerLengths = [0.042, 0.048, 0.044, 0.034];
      const fingerOffsets = [-0.03, -0.01, 0.01, 0.03];

      for (let i = 0; i < 4; i++) {
        const fLen = fingerLengths[i];
        const fZ = fingerOffsets[i];
        const fingerJoint = new THREE.Group();
        const direction = isRight ? -1 : 1;
        fingerJoint.position.set(direction * 0.082, 0, fZ);
        handGroup.add(fingerJoint);
        this.animatedFingers.push({
          joint: fingerJoint,
          phase: i * 1.73 + (isRight ? 2.4 : 0.2),
          speed: 0.72 + i * 0.11,
          amount: 0.7 + i * 0.08,
          restRotationZ: 0,
        });

        // Proximal Phalanx
        const p1 = makeMesh(new THREE.CapsuleGeometry(0.007, fLen * 0.55, 6, 12), matHumanoidArmor);
        p1.rotation.z = isRight ? Math.PI / 2 : -Math.PI / 2;
        p1.position.set(direction * fLen * 0.28, -0.004, 0);
        fingerJoint.add(p1);

        // Chrome Knuckle Joint
        const fJoint = makeMesh(new THREE.SphereGeometry(0.0075, 12, 12), matChrome);
        fJoint.position.set(direction * fLen * 0.55, -0.007, 0);
        fingerJoint.add(fJoint);

        // Distal Phalanx (curved naturally inward in humanoid rest posture)
        const p2 = makeMesh(new THREE.CapsuleGeometry(0.0065, fLen * 0.45, 6, 12), matHumanoidArmor);
        p2.rotation.z = isRight ? Math.PI / 2 + 0.22 : -Math.PI / 2 - 0.22;
        p2.position.set(direction * fLen * 0.78, -0.014, 0);
        fingerJoint.add(p2);
      }

      // Opposable Humanoid Thumb (Angled forward at 35 degrees)
      const thumbGroup = new THREE.Group();
      thumbGroup.position.set(isRight ? -0.035 : 0.035, -0.006, 0.042);
      thumbGroup.rotation.y = isRight ? 0.65 : -0.65;
      thumbGroup.rotation.z = isRight ? -0.35 : 0.35;
      this.animatedFingers.push({
        joint: thumbGroup,
        phase: isRight ? 4.7 : 1.1,
        speed: 0.48,
        amount: 0.35,
        restRotationZ: thumbGroup.rotation.z,
      });

      const t1 = makeMesh(new THREE.CapsuleGeometry(0.008, 0.026, 6, 12), matHumanoidArmor);
      t1.rotation.z = isRight ? Math.PI / 2 : -Math.PI / 2;
      t1.position.x = isRight ? -0.015 : 0.015;
      thumbGroup.add(t1);

      const tJoint = makeMesh(new THREE.SphereGeometry(0.008, 12, 12), matChrome);
      tJoint.position.x = isRight ? -0.03 : 0.03;
      thumbGroup.add(tJoint);

      const t2 = makeMesh(new THREE.CapsuleGeometry(0.0075, 0.022, 6, 12), matHumanoidArmor);
      t2.rotation.z = isRight ? Math.PI / 2 + 0.25 : -Math.PI / 2 - 0.25;
      t2.position.set(isRight ? -0.042 : 0.042, -0.006, 0.004);
      thumbGroup.add(t2);

      handGroup.add(thumbGroup);
      bone.add(handGroup);
    };

    buildArticulatedHand(leftHand, false);
    buildArticulatedHand(rightHand, true);

    // -------------------------------------------------------------
    // 10. THIGHS, QUADRICEPS, FLOATING PATELLAS & KNEES
    // -------------------------------------------------------------
    const buildThigh = (bone: THREE.Bone) => {
      // Chrome Femoral Head Ball (Nestles seamlessly inside the pelvic acetabulum!)
      const femoralHead = makeMesh(new THREE.SphereGeometry(0.065, 24, 24), matChrome);
      bone.add(femoralHead);

      // Quadriceps Muscle Belly Capsule
      const quadCapsule = makeMesh(new THREE.CapsuleGeometry(0.062, 0.28, 8, 20), matHumanoidArmor);
      quadCapsule.position.set(0, -0.20, 0.01);
      bone.add(quadCapsule);

      // Vastus Lateralis Outer Thigh Plate
      const lateralPlate = makeMesh(new THREE.BoxGeometry(0.045, 0.30, 0.095), matHumanoidArmor);
      lateralPlate.position.set(0, -0.20, 0);
      bone.add(lateralPlate);

      // Vastus Medialis Teardrop (above the knee)
      const teardrop = makeMesh(new THREE.SphereGeometry(0.045, 16, 16), matHumanoidArmor);
      teardrop.scale.set(0.9, 1.4, 0.9);
      teardrop.position.set(0, -0.34, 0.035);
      bone.add(teardrop);

      // Posterior Hamstring Contour
      const hamstring = makeMesh(new THREE.BoxGeometry(0.08, 0.26, 0.05), matUndersuit);
      hamstring.position.set(0, -0.20, -0.05);
      bone.add(hamstring);
    };

    buildThigh(leftUpperLeg);
    buildThigh(rightUpperLeg);

    // Articulated Bicondylar Knee Hinge & Contoured Calf
    const buildCalf = (bone: THREE.Bone) => {
      // Polished Chrome Bicondylar Knee Hinge Pin
      const kneeHinge = makeMesh(new THREE.CylinderGeometry(0.042, 0.042, 0.085, 20), matChrome);
      kneeHinge.rotation.z = Math.PI / 2;
      bone.add(kneeHinge);

      // Floating Diamond Patella (Kneecap Armor Shield)
      const patella = makeMesh(new THREE.BoxGeometry(0.068, 0.076, 0.038), matHumanoidArmor);
      patella.position.set(0, 0.015, 0.052);
      bone.add(patella);

      // Patellar tendon anchor
      const patellarTendon = makeMesh(new THREE.BoxGeometry(0.035, 0.06, 0.02), matUndersuit);
      patellarTendon.position.set(0, -0.04, 0.048);
      bone.add(patellarTendon);

      // Gastrocnemius (Sculpted Muscular Calf Belly)
      const calfMuscle = makeMesh(new THREE.CapsuleGeometry(0.054, 0.18, 8, 20), matHumanoidArmor);
      calfMuscle.position.set(0, -0.16, -0.02);
      bone.add(calfMuscle);

      // Anterior Shin Guard (Tibial crest ridge)
      const shinGuard = makeMesh(new THREE.BoxGeometry(0.058, 0.32, 0.035), matHumanoidArmor);
      shinGuard.position.set(0, -0.20, 0.045);
      bone.add(shinGuard);

      // Slender Achilles Tendon
      const achilles = makeMesh(new THREE.CylinderGeometry(0.032, 0.042, 0.16, 16), matUndersuit);
      achilles.position.set(0, -0.32, -0.015);
      bone.add(achilles);

      // Medial & Lateral Ankle Malleoli (Chrome Ankle Bone Spheres)
      const malleolusL = makeMesh(new THREE.SphereGeometry(0.024, 16, 16), matChrome);
      malleolusL.position.set(0.048, -0.40, 0);
      bone.add(malleolusL);

      const malleolusR = makeMesh(new THREE.SphereGeometry(0.024, 16, 16), matChrome);
      malleolusR.position.set(-0.048, -0.40, 0);
      bone.add(malleolusR);

      // Radiant Cyan Ankle Accent Ring
      const ankleRing = makeMesh(new THREE.TorusGeometry(0.042, 0.007, 12, 24), matCyanGlow);
      ankleRing.rotation.x = Math.PI / 2;
      ankleRing.position.set(0, -0.39, 0);
      bone.add(ankleRing);
    };

    buildCalf(leftLowerLeg);
    buildCalf(rightLowerLeg);

    // -------------------------------------------------------------
    // 11. HIGH-TECH ATHLETIC CYBER-BOOTS (Flat on ground at y = 0)
    // -------------------------------------------------------------
    const buildAthleticBoot = (bone: THREE.Bone) => {
      const bootGroup = new THREE.Group();

      // Ground Sole Tread
      const sole = makeMesh(new THREE.BoxGeometry(0.10, 0.026, 0.24), matUndersuit);
      sole.position.set(0, -0.025, 0.06);
      bootGroup.add(sole);

      // Calcaneus (Heel Cup)
      const heelCup = makeMesh(new THREE.BoxGeometry(0.088, 0.065, 0.08), matHumanoidArmor);
      heelCup.position.set(0, 0.015, -0.02);
      bootGroup.add(heelCup);

      // Midfoot Arch & Instep
      const instep = makeMesh(new THREE.BoxGeometry(0.09, 0.055, 0.12), matHumanoidArmor);
      instep.position.set(0, 0.015, 0.05);
      bootGroup.add(instep);

      // Articulated Metatarsal Toe Box
      const toeBox = makeMesh(new THREE.BoxGeometry(0.094, 0.038, 0.08), matHumanoidArmor);
      toeBox.position.set(0, 0.006, 0.14);
      bootGroup.add(toeBox);

      // Radiant Cyan Heel Accent
      const heelGlow = makeMesh(new THREE.BoxGeometry(0.065, 0.015, 0.02), matCyanGlow);
      heelGlow.position.set(0, 0.01, -0.062);
      bootGroup.add(heelGlow);

      bone.add(bootGroup);
    };

    buildAthleticBoot(leftFoot);
    buildAthleticBoot(rightFoot);

    if (isCrashTest) {
      const addTarget = (parent: THREE.Object3D, position: THREE.Vector3, radius: number): void => {
        const outer = makeMesh(new THREE.TorusGeometry(radius, 0.008, 8, 24), matUndersuit);
        outer.position.copy(position);
        parent.add(outer);
        const inner = makeMesh(new THREE.TorusGeometry(radius * 0.52, 0.006, 8, 20), matAmberGlow);
        inner.position.copy(position).z += 0.004;
        parent.add(inner);
        const center = makeMesh(new THREE.SphereGeometry(radius * 0.22, 12, 10), matUndersuit);
        center.position.copy(position).z += 0.007;
        parent.add(center);
      };

      addTarget(chest, new THREE.Vector3(0, 0.06, 0.13), 0.045);
      addTarget(leftUpperArm, new THREE.Vector3(0.13, 0, 0.02), 0.035);
      addTarget(rightUpperArm, new THREE.Vector3(-0.13, 0, 0.02), 0.035);
      addTarget(leftLowerLeg, new THREE.Vector3(0, 0.02, 0.075), 0.032);
      addTarget(rightLowerLeg, new THREE.Vector3(0, 0.02, 0.075), 0.032);
    }

    // -------------------------------------------------------------
    // 12. ATTACH TO SCENE & MAP BONES
    // -------------------------------------------------------------
    this.character = group;
    this.scene.add(this.character);
    this.findAndMapBones(this.character);
    this.currentAvatarStyle = style;

    // Glowing cyan skeleton helper
    this.skeletonHelper = new THREE.SkeletonHelper(this.character);
    const helperMat = this.skeletonHelper.material as THREE.LineBasicMaterial;
    if (helperMat) {
      helperMat.color.set(0x00f0ff);
      helperMat.transparent = true;
      helperMat.opacity = 0.45;
    }
    this.scene.add(this.skeletonHelper);

    this.currentModelType = 'procedural';
    this.loadedModelName = modelName;
  }

  public resetToRestPose(): void {
    for (const [key, bone] of Object.entries(this.bones)) {
      if (!bone) continue;
      const initialRot = this.initialBoneRotations.get(key);
      const initialPos = this.initialBonePositions.get(key);
      if (initialRot) bone.quaternion.copy(initialRot);
      if (initialPos) bone.position.copy(initialPos);
    }
    if (this.character) {
      this.character.updateMatrixWorld(true);
    }
  }

  public toggleSkeletonHelper(visible?: boolean): boolean {
    if (this.skeletonHelper) {
      this.skeletonHelper.visible = visible !== undefined ? visible : !this.skeletonHelper.visible;
      return this.skeletonHelper.visible;
    }
    return false;
  }

  public render = (): void => {
    this.animFrameId = requestAnimationFrame(this.render);
    this.controls.update();
    const time = this.fingerClock.getElapsedTime();
    for (const finger of this.animatedFingers) {
      const slowFlex = Math.sin(time * finger.speed + finger.phase) * 0.045;
      const smallVariation = Math.sin(time * 1.37 + finger.phase * 2) * 0.02;
      const occasionalCurl = Math.pow(Math.max(0, Math.sin(time * 0.32 + finger.phase)), 10) * 0.11;
      finger.joint.rotation.z = finger.restRotationZ
        + finger.amount * (slowFlex + smallVariation + occasionalCurl);
    }
    this.renderer.render(this.scene, this.camera);
  };

  public disposeObject(obj: THREE.Object3D): void {
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) {
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((m) => m.dispose());
          } else {
            mesh.material.dispose();
          }
        }
      }
    });
  }

  public dispose(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    window.removeEventListener('resize', this.onResize);
    this.controls.dispose();

    if (this.skeletonHelper) {
      this.skeletonHelper.dispose();
      this.skeletonHelper = null;
    }
    if (this.character) {
      this.disposeObject(this.character);
    }
    if (this.gridHelper) {
      this.gridHelper.geometry.dispose();
    }
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
  }
}
