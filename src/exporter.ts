/**
 * Motion Capture Exporter:
 * Converts recorded mocap frames into standard BVH (BioVision Hierarchy)
 * and JSON animation files for Blender, Unity, Unreal, and WebGL.
 */
import * as THREE from 'three';
import type { RecordedFrame } from './recorder';

export class MotionExporter {
  /**
   * Generates a standard BVH text file from recorded frames.
   */
  public static exportToBVH(frames: RecordedFrame[]): string {
    if (frames.length === 0) {
      throw new Error('No recorded motion capture frames to export.');
    }

    const frameTime = frames.length > 1
      ? Math.max(0.016, (frames[frames.length - 1].timestamp - frames[0].timestamp) / ((frames.length - 1) * 1000))
      : 0.0333333;

    // Define standard BVH skeleton hierarchy
    const bvhHierarchy = `HIERARCHY
ROOT Hips
{
  OFFSET 0.00 0.00 0.00
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT Spine
  {
    OFFSET 0.00 25.00 0.00
    CHANNELS 3 Zrotation Xrotation Yrotation
    JOINT Chest
    {
      OFFSET 0.00 25.00 0.00
      CHANNELS 3 Zrotation Xrotation Yrotation
      JOINT Neck
      {
        OFFSET 0.00 20.00 0.00
        CHANNELS 3 Zrotation Xrotation Yrotation
        JOINT Head
        {
          OFFSET 0.00 15.00 0.00
          CHANNELS 3 Zrotation Xrotation Yrotation
          End Site
          {
            OFFSET 0.00 10.00 0.00
          }
        }
      }
      JOINT LeftShoulder
      {
        OFFSET 12.00 15.00 0.00
        CHANNELS 3 Zrotation Xrotation Yrotation
        JOINT LeftArm
        {
          OFFSET 14.00 0.00 0.00
          CHANNELS 3 Zrotation Xrotation Yrotation
          JOINT LeftForeArm
          {
            OFFSET 25.00 0.00 0.00
            CHANNELS 3 Zrotation Xrotation Yrotation
            JOINT LeftHand
            {
              OFFSET 20.00 0.00 0.00
              CHANNELS 3 Zrotation Xrotation Yrotation
              End Site
              {
                OFFSET 10.00 0.00 0.00
              }
            }
          }
        }
      }
      JOINT RightShoulder
      {
        OFFSET -12.00 15.00 0.00
        CHANNELS 3 Zrotation Xrotation Yrotation
        JOINT RightArm
        {
          OFFSET -14.00 0.00 0.00
          CHANNELS 3 Zrotation Xrotation Yrotation
          JOINT RightForeArm
          {
            OFFSET -25.00 0.00 0.00
            CHANNELS 3 Zrotation Xrotation Yrotation
            JOINT RightHand
            {
              OFFSET -20.00 0.00 0.00
              CHANNELS 3 Zrotation Xrotation Yrotation
              End Site
              {
                OFFSET -10.00 0.00 0.00
              }
            }
          }
        }
      }
    }
  }
  JOINT LeftUpLeg
  {
    OFFSET 10.00 -5.00 0.00
    CHANNELS 3 Zrotation Xrotation Yrotation
    JOINT LeftLeg
    {
      OFFSET 0.00 -42.00 0.00
      CHANNELS 3 Zrotation Xrotation Yrotation
      JOINT LeftFoot
      {
        OFFSET 0.00 -42.00 12.00
        CHANNELS 3 Zrotation Xrotation Yrotation
        End Site
        {
          OFFSET 0.00 0.00 10.00
        }
      }
    }
  }
  JOINT RightUpLeg
  {
    OFFSET -10.00 -5.00 0.00
    CHANNELS 3 Zrotation Xrotation Yrotation
    JOINT RightLeg
    {
      OFFSET 0.00 -42.00 0.00
      CHANNELS 3 Zrotation Xrotation Yrotation
      JOINT RightFoot
      {
        OFFSET 0.00 -42.00 12.00
        CHANNELS 3 Zrotation Xrotation Yrotation
        End Site
        {
          OFFSET 0.00 0.00 10.00
        }
      }
    }
  }
}
`;

    // Ordered sequence of bones matching the hierarchy traversal above
    const boneSequence = [
      'spine',
      'chest',
      'neck',
      'head',
      'leftShoulder',
      'leftUpperArm',
      'leftLowerArm',
      'leftHand',
      'rightShoulder',
      'rightUpperArm',
      'rightLowerArm',
      'rightHand',
      'leftUpperLeg',
      'leftLowerLeg',
      'leftFoot',
      'rightUpperLeg',
      'rightLowerLeg',
      'rightFoot',
    ];

    const radToDeg = 180 / Math.PI;
    const tempQ = new THREE.Quaternion();
    const tempEuler = new THREE.Euler(0, 0, 0, 'ZXY');

    const motionLines: string[] = [];
    motionLines.push('MOTION');
    motionLines.push(`Frames: ${frames.length}`);
    motionLines.push(`Frame Time: ${frameTime.toFixed(7)}`);

    for (const frame of frames) {
      const values: number[] = [];

      // Root position (Hips) in cm
      const posX = (frame.rootPosition?.x ?? 0) * 100;
      const posY = (frame.rootPosition?.y ?? 0) * 100;
      const posZ = (frame.rootPosition?.z ?? 0) * 100;
      values.push(posX, posY, posZ);

      // Root rotation
      const rootRot = frame.boneRotations['hips'];
      if (rootRot) {
        tempQ.set(rootRot.x, rootRot.y, rootRot.z, rootRot.w);
        tempEuler.setFromQuaternion(tempQ, 'ZXY');
        values.push(tempEuler.z * radToDeg, tempEuler.x * radToDeg, tempEuler.y * radToDeg);
      } else {
        values.push(0, 0, 0);
      }

      // Remaining bones
      for (const boneKey of boneSequence) {
        const rot = frame.boneRotations[boneKey];
        if (rot) {
          tempQ.set(rot.x, rot.y, rot.z, rot.w);
          tempEuler.setFromQuaternion(tempQ, 'ZXY');
          values.push(tempEuler.z * radToDeg, tempEuler.x * radToDeg, tempEuler.y * radToDeg);
        } else {
          values.push(0, 0, 0);
        }
      }

      motionLines.push(values.map((v) => Number(v.toFixed(4))).join(' '));
    }

    return bvhHierarchy + motionLines.join('\n');
  }

  /**
   * Generates formatted JSON file containing all frames, bones, and metric landmarks.
   */
  public static exportToJSON(frames: RecordedFrame[]): string {
    const payload = {
      app: 'MoTopi',
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      frameCount: frames.length,
      frames,
    };
    return JSON.stringify(payload, null, 2);
  }

  /**
   * Triggers client-side browser download for a generated file.
   */
  public static downloadFile(content: string, filename: string, mimeType: string): void {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}
