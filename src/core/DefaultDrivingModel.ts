import type {DrivingModel} from './types';

// The default driving cycle: 20s idle → 8s acceleration → cruise at
// ~90 km/h → deceleration, repeating every 96s. Coolant/oil warm up along
// exponential curves, fuel burns down slowly. Deliberately simple and fully
// deterministic given the same jitter stream.

const IDLE_END_S = 20;
const ACCEL_END_S = 28;
const CRUISE_END_S = 88;
const CYCLE_LENGTH_S = 96;

const CRUISE_SPEED_KMH = 90;
const IDLE_RPM = 800;
const COOLANT_START_C = 22;
const COOLANT_TARGET_C = 90;
const COOLANT_WARMUP_TAU_S = 150;
const FUEL_START_PCT = 62;
const FUEL_BURN_PCT_PER_HOUR = 6;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

interface DrivingState {
    speedKmh: number;
    rpm: number;
    throttlePct: number;
    engineLoadPct: number;
}

// Rough gear-dependent rpm-per-km/h so RPM drops on upshifts instead of
// climbing linearly to redline.
function gearFactor(speedKmh: number): number {
    if (speedKmh < 20) return 90;
    if (speedKmh < 40) return 55;
    if (speedKmh < 65) return 38;
    if (speedKmh < 90) return 28;
    return 24;
}

export interface DefaultDrivingModelOptions {
    // Reported by PID 0x51 (1 = gasoline, 4 = diesel...).
    fuelType?: number;
}

export class DefaultDrivingModel implements DrivingModel {
    private readonly fuelType: number;

    constructor(options: DefaultDrivingModelOptions = {}) {
        this.fuelType = options.fuelType ?? 1;
    }

    value(pid: number, elapsedSeconds: number, jitter: (amplitude: number) => number): number | null {
        const state = this.drivingState(elapsedSeconds, jitter);
        switch (pid) {
            case 0x04:
                return state.engineLoadPct;
            case 0x05: {
                const warmup = 1 - Math.exp(-elapsedSeconds / COOLANT_WARMUP_TAU_S);
                return COOLANT_START_C + (COOLANT_TARGET_C - COOLANT_START_C) * warmup + jitter(0.5);
            }
            case 0x06:
                return jitter(4);
            case 0x0b:
                // Vacuum at idle (~30 kPa), toward atmospheric under load.
                return clamp(28 + state.engineLoadPct * 0.7 + jitter(2), 15, 105);
            case 0x0c:
                return state.rpm;
            case 0x0d:
                return state.speedKmh;
            case 0x0e:
                return clamp(8 + state.rpm / 400 + jitter(1), -10, 40);
            case 0x0f:
                return 25 + jitter(1.5);
            case 0x10:
                // Airflow scales with rpm × load; ~2 g/s idle, ~40+ under load.
                return clamp(2 + (state.rpm / 1000) * (state.engineLoadPct / 8) + jitter(0.5), 0, 300);
            case 0x11:
                return state.throttlePct;
            case 0x14:
                // Narrow-band O2 oscillating around stoich.
                return clamp(0.45 + jitter(0.25), 0.05, 0.9);
            case 0x2f:
                return clamp(FUEL_START_PCT - (elapsedSeconds / 3600) * FUEL_BURN_PCT_PER_HOUR, 0, 100);
            case 0x33:
                return 101 + jitter(0.3);
            case 0x42:
                return state.rpm > 400 ? 14.1 + jitter(0.1) : 12.4 + jitter(0.1);
            case 0x46:
                return 22 + jitter(1);
            case 0x51:
                return this.fuelType;
            case 0x5c: {
                // Oil warms slower than coolant and settles a bit hotter.
                const warmup = 1 - Math.exp(-elapsedSeconds / (COOLANT_WARMUP_TAU_S * 1.6));
                return COOLANT_START_C + (COOLANT_TARGET_C + 8 - COOLANT_START_C) * warmup + jitter(0.5);
            }
            case 0x62:
                // Torque roughly tracks load; idles slightly positive.
                return clamp(state.engineLoadPct * 0.9 + jitter(2), -125, 130);
            default:
                return null;
        }
    }

    private drivingState(elapsedSeconds: number, jitter: (amplitude: number) => number): DrivingState {
        const cycleS = Math.max(0, elapsedSeconds) % CYCLE_LENGTH_S;

        let speed: number;
        let throttle: number;
        if (cycleS < IDLE_END_S) {
            speed = 0;
            throttle = 12;
        } else if (cycleS < ACCEL_END_S) {
            const progress = (cycleS - IDLE_END_S) / (ACCEL_END_S - IDLE_END_S);
            speed = CRUISE_SPEED_KMH * progress;
            throttle = 65;
        } else if (cycleS < CRUISE_END_S) {
            speed = CRUISE_SPEED_KMH + jitter(3);
            throttle = 25;
        } else {
            const progress = (cycleS - CRUISE_END_S) / (CYCLE_LENGTH_S - CRUISE_END_S);
            speed = CRUISE_SPEED_KMH * (1 - progress);
            throttle = 5;
        }

        const rpm = speed < 1 ? IDLE_RPM + jitter(40) : IDLE_RPM + speed * gearFactor(speed);
        return {
            speedKmh: clamp(speed, 0, 240),
            rpm: clamp(rpm, 0, 8000),
            throttlePct: clamp(throttle + jitter(2), 0, 100),
            engineLoadPct: clamp(throttle * 0.85 + jitter(4), 0, 100),
        };
    }
}
