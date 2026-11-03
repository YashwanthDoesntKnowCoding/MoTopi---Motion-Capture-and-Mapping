# MoTopi 🕺✨
> Real-Time Browser-Based Markerless Motion Capture (MoCap)

MoTopi tracks human body movement using a standard webcam and translates it into 3D skeletal animation applied to a rigged humanoid character in real time. Everything runs 100% client-side with no backend, no markers, and no specialized tracking suits.

---

## 🚀 Features

- **Full-Body Tracking**: MediaPipe Pose Landmarker full model tracks 33 body landmarks and retargets the torso, arms, and legs.
- **Root & Foot Stabilization**: The avatar follows estimated lateral/depth movement, applies smoothed floor-height correction, and uses a conservative stance lock to reduce foot sliding. Single-camera depth and contact estimates are approximate.
- **Jump Tracking**: Upward hip movement lifts the avatar during a detected jump, with smoothing and floor correction resuming after landing.
- **Motion Strength Control**: Adjust the avatar's retargeted joint motion from 50% to 150% without changing the camera preview.
- **Built-in Avatar Selection**: Switch between the cyber mannequin, Nova femme android, and crash-test dummy; all share the same tracking rig.
- **Subtle Finger Motion**: Fingers make small, varied idle movements while the hands follow the tracked pose.
- **Body Calibration**: Learn robust personal arm and leg segment lengths from a short steady full-body pose.
- **Constrained Pose Estimation**: Calibrated limb lengths reconstruct briefly hidden elbows and knees, and gently correct visible joints when their measured proportions drift.
- **Interactive 3D Viewport**: Built with Three.js, featuring studio lighting, ground grid, and OrbitControls.
- **Anatomical Side Mapping**: MediaPipe's left and right limbs map directly to the matching avatar sides; mirroring only flips the camera preview.
- **Leg Retargeting**: Tracks the knees, ankles, and feet while stabilizing feet when camera landmarks indicate a planted stance.
- **Adaptive Jitter Filtering**: Configurable One Euro (1€) filtering responds to movement speed and applies extra smoothing to lower-confidence joints; invalid landmark coordinates are ignored.
- **Visual Skeleton Overlay**: Mirrored live camera feed with 2D bone joints and connections drawn on HTML5 canvas.
- **Recording & Playback**: Capture motion sessions in real time, scrub or replay directly on the character.
- **Animation Export**: Export captured mocap data to standard **BVH (BioVision Hierarchy)** and **JSON** formats for Blender, Unity, Unreal, and WebGL.
- **Tracking Quality Guard**: Low-confidence landmarks hold their last valid positions, with guidance for lighting and upper-body visibility.

---

## 📦 Getting Started

### Prerequisites
- Node.js (v18+ recommended)
- A webcam, or an iPhone exposed to Windows as a webcam using **Camo** or **Iriun Webcam**

### Installation

```bash
# Clone or navigate to the repository
cd MoTopi

# Install dependencies
npm install

# Start the Vite local development server
npm run dev
```

Open the displayed localhost URL (e.g. `http://localhost:5173`) in Google Chrome or any Chromium-based browser for optimal WebAssembly and WebGL performance.

### Calibrate your body for single-camera tracking

1. Select one camera and click **Start Camera**.
2. Stand upright facing the camera, with your whole body in frame and arms slightly away from your sides.
3. Click **Calibrate body** and hold still until the progress reaches 100%. The app measures your arm and leg segment lengths from the live pose.

Calibration is optional and lasts for the current page session. It learns personal limb proportions to estimate briefly hidden elbows and knees and gently constrain noisy visible joints. The animated progress panel collapses to a compact calibrated indicator when finished. Keep moving naturally after calibration; no checkerboard or second camera is needed. Estimates are deliberately conservative and cannot determine a limb's true pose when it stays fully occluded.

### Use an iPhone as the Windows camera
MoTopi runs in the PC browser, so the iPhone must first be exposed to Windows as a webcam:

1. Install **Camo Studio** on Windows and **Camo Camera** from the App Store on the iPhone. Iriun Webcam is an alternative; install its app on both devices.
2. Open the apps and allow camera access on the iPhone. Connect over USB or follow the app's Wi-Fi pairing instructions.
3. Keep the iPhone camera app open. In MoTopi, choose **Camo** or **Iriun Webcam** in the camera dropdown, then click **Start Camera**.

If the phone is not listed, reconnect it, make sure its camera app is open, and reload MoTopi. Allow camera access in the browser when prompted. USB is usually the most reliable connection; actual resolution and frame rate depend on the phone and webcam app.

---

## 🧍 Built-in Avatars

Choose **Cyber Mannequin**, **Nova**, or **Crash Dummy** from the header. Each is generated locally and uses the same humanoid skeleton, so switching styles does not change tracking or require an imported model. The fingers also make gentle, independent idle flexes in addition to following hand movement.

---

## 🛠️ Architecture & File Structure

```
motopi/
├── index.html              # Main application shell with split UI & floating dock
├── package.json            # Vite, Three.js, MediaPipe vision dependencies
├── tsconfig.json           # TypeScript bundler configuration
├── README.md               # Documentation & setup guide
└── src/
    ├── main.ts             # Application bootstrapper and coordination loop
    ├── camera.ts           # WebRTC webcam lifecycle & permission management
    ├── pose.ts             # MediaPipe full-body pose detector & canvas overlay
    ├── pose-estimation.ts  # Body calibration and constrained hidden-joint estimates
    ├── smoothing.ts        # One Euro adaptive signal filter
    ├── retarget.ts         # Direction vector to quaternion bone retargeting
    ├── scene.ts            # Three.js scene, lighting, controls & built-in avatars
    ├── recorder.ts         # Frame recording and playback buffer
    ├── exporter.ts         # BVH and JSON animation exporter
    └── ui.ts               # Control panel, HUD, FPS counter & alerts
```

---

## 💡 Best Practices for Tracking Quality

- **Camera Positioning**: Frame the complete body, including feet, and keep the camera fixed during a tracking session.
- **Lighting**: Ensure even, bright front lighting. Avoid strong backlighting or shadows.
- **Clothing**: MediaPipe estimates body landmarks from the camera image; it does not explicitly track or identify clothing. Loose or occluding clothing can make landmarks less reliable, while fitted clothing with contrast against the background often improves detection.

---

## 📄 License
MIT License.
