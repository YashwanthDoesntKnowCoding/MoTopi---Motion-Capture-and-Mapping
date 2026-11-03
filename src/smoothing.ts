/**
 * One Euro Filter implementation for low-latency, jitter-free motion smoothing.
 * Casiez, G., Roussel, N. and Vogel, F. (2012).
 * 1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input in Human-Computer Interaction.
 */

export interface OneEuroFilterConfig {
  minCutoff: number; // Minimum cutoff frequency (Hz) - higher reduces lag, lower reduces jitter
  beta: number;      // Speed coefficient - adjusts cutoff based on velocity
  dCutoff: number;   // Cutoff frequency for derivative (Hz)
}

export const DEFAULT_FILTER_CONFIG: OneEuroFilterConfig = {
  minCutoff: 1.0,
  beta: 0.007,
  dCutoff: 1.0,
};

class LowPassFilter {
  private hatXPrev: number | null = null;

  public filter(x: number, alpha: number): number {
    if (this.hatXPrev === null) {
      this.hatXPrev = x;
    } else {
      this.hatXPrev = alpha * x + (1.0 - alpha) * this.hatXPrev;
    }
    return this.hatXPrev;
  }

  public hasLast(): boolean {
    return this.hatXPrev !== null;
  }

  public last(): number {
    return this.hatXPrev ?? 0;
  }

  public reset(): void {
    this.hatXPrev = null;
  }
}

function alpha(rate: number, cutoff: number): number {
  const tau = 1.0 / (2.0 * Math.PI * cutoff);
  const te = 1.0 / rate;
  return 1.0 / (1.0 + tau / te);
}

export class OneEuroScalar {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;

  private xFilt = new LowPassFilter();
  private dxFilt = new LowPassFilter();
  private lastTime: number | null = null;

  constructor(config: Partial<OneEuroFilterConfig> = {}) {
    this.minCutoff = config.minCutoff ?? DEFAULT_FILTER_CONFIG.minCutoff;
    this.beta = config.beta ?? DEFAULT_FILTER_CONFIG.beta;
    this.dCutoff = config.dCutoff ?? DEFAULT_FILTER_CONFIG.dCutoff;
  }

  public updateConfig(config: Partial<OneEuroFilterConfig>): void {
    if (config.minCutoff !== undefined) this.minCutoff = config.minCutoff;
    if (config.beta !== undefined) this.beta = config.beta;
    if (config.dCutoff !== undefined) this.dCutoff = config.dCutoff;
  }

  public filter(x: number, timestampMs: number): number {
    if (this.lastTime === null) {
      this.lastTime = timestampMs;
      return this.xFilt.filter(x, 1.0);
    }

    const dt = (timestampMs - this.lastTime) / 1000.0;
    this.lastTime = timestampMs;

    // Guard against identical timestamps or backward clock
    if (dt <= 1e-5) {
      return this.xFilt.last();
    }

    const rate = 1.0 / dt;

    // Estimate derivative (velocity)
    const prevX = this.xFilt.hasLast() ? this.xFilt.last() : x;
    const dx = (x - prevX) * rate;
    const aD = alpha(rate, this.dCutoff);
    const edx = this.dxFilt.filter(dx, aD);

    // Compute dynamic cutoff frequency
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    const a = alpha(rate, cutoff);

    return this.xFilt.filter(x, a);
  }

  public reset(): void {
    this.xFilt.reset();
    this.dxFilt.reset();
    this.lastTime = null;
  }
}

export interface Point3D {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export class OneEuroPoint3D {
  private xFilter: OneEuroScalar;
  private yFilter: OneEuroScalar;
  private zFilter: OneEuroScalar;

  constructor(config: Partial<OneEuroFilterConfig> = {}) {
    this.xFilter = new OneEuroScalar(config);
    this.yFilter = new OneEuroScalar(config);
    this.zFilter = new OneEuroScalar(config);
  }

  public updateConfig(config: Partial<OneEuroFilterConfig>): void {
    this.xFilter.updateConfig(config);
    this.yFilter.updateConfig(config);
    this.zFilter.updateConfig(config);
  }

  public filter(pt: Point3D, timestampMs: number): Point3D {
    return {
      x: this.xFilter.filter(pt.x, timestampMs),
      y: this.yFilter.filter(pt.y, timestampMs),
      z: this.zFilter.filter(pt.z, timestampMs),
      visibility: pt.visibility,
    };
  }

  public reset(): void {
    this.xFilter.reset();
    this.yFilter.reset();
    this.zFilter.reset();
  }
}

/**
 * Filter manager for all 33 MediaPipe Pose landmarks.
 */
export class LandmarkSmoother {
  private filters: OneEuroPoint3D[] = [];
  private lastValidPoints: (Point3D | null)[] = [];
  private minConfidence = 0.5;
  private config: OneEuroFilterConfig;

  constructor(landmarkCount = 33, config: Partial<OneEuroFilterConfig> = {}) {
    this.config = { ...DEFAULT_FILTER_CONFIG, ...config };
    for (let i = 0; i < landmarkCount; i++) {
      this.filters.push(new OneEuroPoint3D(this.config));
      this.lastValidPoints.push(null);
    }
  }

  public setConfidenceThreshold(threshold: number): void {
    this.minConfidence = threshold;
  }

  public updateConfig(config: Partial<OneEuroFilterConfig>): void {
    this.config = { ...this.config, ...config };
    for (const filter of this.filters) {
      filter.updateConfig(this.config);
    }
  }

  public filterLandmarks(rawLandmarks: Point3D[], timestampMs: number): Point3D[] {
    const smoothed: Point3D[] = [];

    for (let i = 0; i < rawLandmarks.length; i++) {
      const raw = rawLandmarks[i];
      const vis = raw.visibility === undefined
        ? 1
        : Number.isFinite(raw.visibility)
          ? Math.max(0, Math.min(1, raw.visibility))
          : 0;
      const hasFinitePosition =
        Number.isFinite(raw.x) &&
        Number.isFinite(raw.y) &&
        Number.isFinite(raw.z);

      // Confidence gating: hold last valid pose if confidence is low
      if ((!hasFinitePosition || vis < this.minConfidence) && this.lastValidPoints[i] !== null) {
        smoothed.push({ ...this.lastValidPoints[i]!, visibility: vis });
        continue;
      }

      if (!this.filters[i]) {
        this.filters[i] = new OneEuroPoint3D(this.config);
        this.lastValidPoints[i] = null;
      }

      if (!hasFinitePosition) {
        smoothed.push({ x: 0, y: 0, z: 0, visibility: 0 });
        continue;
      }

      const confidenceRange = Math.max(0.01, 0.8 - this.minConfidence);
      const confidence = Math.max(0, Math.min(1, (vis - this.minConfidence) / confidenceRange));
      this.filters[i].updateConfig({
        ...this.config,
        minCutoff: this.config.minCutoff * (0.55 + 0.45 * confidence),
        beta: this.config.beta * (0.35 + 0.65 * confidence),
      });
      const filtered = this.filters[i].filter(raw, timestampMs);
      filtered.visibility = vis;
      this.lastValidPoints[i] = { ...filtered };
      smoothed.push(filtered);
    }

    return smoothed;
  }

  public reset(): void {
    for (const filter of this.filters) {
      filter.reset();
    }
    this.lastValidPoints = this.lastValidPoints.map(() => null);
  }
}
