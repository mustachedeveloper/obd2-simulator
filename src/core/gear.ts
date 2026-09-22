// PID A4 on vehicles that report the engaged gear instead of a ratio
// (support byte 01): the gear is estimated from engine speed per road speed,
// the way it shows on any car with a fixed set of ratios.

// Typical rpm per km/h of a seven-speed passenger-car gearbox, first gear
// first. The recorded car sat at ≈ 156 in first and ≈ 27 in fifth.
const RPM_PER_KMH: readonly number[] = [120, 70, 45, 33, 27, 22, 18];
const MOVING_KMH = 1;
const MAX_GEAR = 0x0f;

/**
 * Engaged gear (1-based), 0 when the car stands still or the engine is
 * stopped. Nearest ratio on a logarithmic scale, so the gaps between the
 * low gears do not swallow the high ones.
 */
export function gearFor(rpm: number, speedKmh: number): number {
    if (!Number.isFinite(rpm) || !Number.isFinite(speedKmh) || rpm <= 0 || speedKmh < MOVING_KMH) return 0;
    const ratio = Math.log(rpm / speedKmh);
    const distances = RPM_PER_KMH.map((candidate) => Math.abs(Math.log(candidate) - ratio));
    return distances.indexOf(Math.min(...distances)) + 1;
}

/**
 * Data bytes A–D: gear supported, gear in the upper nibble of B, no ratio.
 */
export function encodeGearReport(gear: number): number[] {
    const clamped = Math.min(MAX_GEAR, Math.max(0, Math.round(gear)));
    return [0x01, clamped << 4, 0x00, 0x00];
}
