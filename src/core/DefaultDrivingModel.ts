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
    // Odometer reading at power-on (PID 0xA6 accumulates on top).
    odometerKm?: number;
}

// Distance driven since power-on: piecewise integral of the speed profile.
// One full 96s cycle covers 0.1 (accel) + 1.5 (cruise) + 0.1 (decel) km.
const CYCLE_DISTANCE_KM = 1.7;

function distanceKm(elapsedSeconds: number): number {
    const s = Math.max(0, elapsedSeconds);
    const fullCycles = Math.floor(s / CYCLE_LENGTH_S);
    const t = s % CYCLE_LENGTH_S;
    let inCycle = 0;
    if (t > IDLE_END_S) {
        const accelT = Math.min(t, ACCEL_END_S) - IDLE_END_S;
        // v ramps 0→90 over 8s: d = ½·v(t)·t.
        inCycle += ((CRUISE_SPEED_KMH * accelT) / (ACCEL_END_S - IDLE_END_S) / 2) * (accelT / 3600);
    }
    if (t > ACCEL_END_S) {
        inCycle += (CRUISE_SPEED_KMH * (Math.min(t, CRUISE_END_S) - ACCEL_END_S)) / 3600;
    }
    if (t > CRUISE_END_S) {
        const decelT = t - CRUISE_END_S;
        const speedNow = CRUISE_SPEED_KMH * (1 - decelT / (CYCLE_LENGTH_S - CRUISE_END_S));
        inCycle += (((CRUISE_SPEED_KMH + speedNow) / 2) * decelT) / 3600;
    }
    return fullCycles * CYCLE_DISTANCE_KM + inCycle;
}

export class DefaultDrivingModel implements DrivingModel {
    private readonly fuelType: number;
    private readonly odometerKm: number;

    constructor(options: DefaultDrivingModelOptions = {}) {
        this.fuelType = options.fuelType ?? 1;
        this.odometerKm = options.odometerKm ?? 84_213;
    }

    value(pid: number, elapsedSeconds: number, jitter: (amplitude: number) => number): number | null {
        const state = this.drivingState(elapsedSeconds, jitter);
        const warmup = 1 - Math.exp(-elapsedSeconds / COOLANT_WARMUP_TAU_S);
        switch (pid) {
            case 0x03:
                // Open loop while warming up, closed loop after.
                return warmup > 0.3 ? 2 : 1;
            case 0x07:
                return 2 + jitter(1); // LTFT B1
            case 0x08:
                return jitter(4); // STFT B2
            case 0x09:
                return 1.5 + jitter(1); // LTFT B2
            case 0x0a:
                return 300 + jitter(6); // fuel pressure
            case 0x12:
                return 4; // secondary air: off / atmosphere
            case 0x15:
                return clamp(0.4 + jitter(0.2), 0.05, 0.9); // O2 S2 voltage
            case 0x1c:
                return 6; // EOBD
            case 0x1e:
                return 0; // PTO off
            case 0x1f:
                return elapsedSeconds; // run time
            case 0x21:
                return 0; // distance with MIL (no MIL by default)
            case 0x22:
                return 400 + state.engineLoadPct * 2 + jitter(15); // rail gauge
            case 0x23:
            case 0x59:
                return 5000 + state.engineLoadPct * 80 + jitter(100); // rail direct/abs
            case 0x24:
                return clamp(1 + jitter(0.05), 0, 2); // O2 S1 lambda
            case 0x25:
                return clamp(1 + jitter(0.03), 0, 2); // O2 S2 lambda
            case 0x2c:
                return state.engineLoadPct > 50 ? 0 : 8 + jitter(2); // commanded EGR
            case 0x2d:
                return jitter(3); // EGR error
            case 0x2e:
                return clamp(5 + state.engineLoadPct * 0.2 + jitter(2), 0, 100); // purge
            case 0x30:
                return 42; // warm-ups since clear
            case 0x31:
                return 1200 + distanceKm(elapsedSeconds); // distance since clear
            case 0x32:
                return -100 + jitter(50); // evap vapor pressure (Pa)
            case 0x3c:
                return 200 + 460 * warmup + state.engineLoadPct + jitter(5); // catalyst B1S1
            case 0x3e:
                return 180 + 430 * warmup + state.engineLoadPct + jitter(5); // catalyst B1S2
            case 0x43:
                return state.engineLoadPct * 1.05; // absolute load
            case 0x44:
                return clamp(1 + jitter(0.02), 0, 2); // commanded lambda
            case 0x45:
                return state.throttlePct * 0.9; // relative throttle
            case 0x47:
                return clamp(state.throttlePct + 1, 0, 100);
            case 0x48:
                return state.throttlePct * 0.98;
            case 0x49:
                return clamp(state.throttlePct * 0.8 + 5, 0, 100); // pedal position
            case 0x4a:
                return clamp(state.throttlePct * 0.8 + 4, 0, 100); // pedal D
            case 0x4b:
                return clamp(state.throttlePct * 0.4 + 2, 0, 100); // pedal E
            case 0x4c:
                return state.throttlePct; // throttle actuator
            case 0x4d:
                return 0; // time with MIL
            case 0x4e:
                return 2000 + elapsedSeconds / 60; // time since clear (min)
            case 0x52:
                return 5 + jitter(0.5); // ethanol %
            case 0x53:
                return 20 + jitter(1); // abs evap pressure (kPa)
            case 0x54:
                return -80 + jitter(30); // evap wide (Pa)
            case 0x55:
                return jitter(3); // secondary STFT B1
            case 0x56:
                return 1.5 + jitter(1); // secondary LTFT B1
            case 0x5a:
                return clamp(state.throttlePct * 0.8 + 4, 0, 100); // relative pedal
            case 0x5d:
                return 2 + state.engineLoadPct * 0.1 + jitter(0.5); // injection timing
            case 0x5e:
                return clamp(0.5 + state.engineLoadPct * 0.12 + state.speedKmh * 0.04, 0, 60); // fuel rate
            case 0x61:
                return clamp(state.engineLoadPct + 5, -125, 130); // demanded torque
            case 0x63:
                return 250; // reference torque (Nm)
            case 0x64:
                return 18; // torque at idle (%)
            case 0x66:
                return clamp(2 + (state.rpm / 1000) * (state.engineLoadPct / 8) + jitter(0.5), 0, 300); // MAF sensors
            case 0x67:
                return COOLANT_START_C + (COOLANT_TARGET_C - COOLANT_START_C) * warmup + jitter(0.5);
            case 0x68:
                return 25 + jitter(1.5); // IAT sensors
            case 0x69:
                return clamp(30 - state.engineLoadPct * 0.2, 0, 100); // EGR packet (commanded)
            case 0x6f:
                return 101 + jitter(0.5); // turbo inlet pressure
            case 0x73:
                return 105 + state.engineLoadPct * 0.3 + jitter(1); // exhaust pressure
            case 0x74:
                return clamp(state.rpm * 7, 0, 65535); // turbo rpm
            case 0x78:
                return 250 + state.engineLoadPct * 4 + jitter(10); // EGT bank 1
            case 0x79:
                return 230 + state.engineLoadPct * 4 + jitter(10); // EGT bank 2
            case 0x7a:
                return clamp(1.5 + state.engineLoadPct * 0.02 + jitter(0.1), 0, 20); // DPF delta P
            case 0x7c:
                return 300 + state.engineLoadPct * 2 + jitter(10); // DPF temp
            case 0x83:
                return clamp(120 + state.engineLoadPct * 3 + jitter(10), 0, 3000); // NOx ppm
            case 0x8e:
                return -12 + jitter(1); // friction torque
            case 0x9b:
                return clamp(78 - (elapsedSeconds / 3600) * 0.05, 0, 100); // DEF level
            case 0xa4: {
                // Gear ratio from the same rpm-per-speed table; no data at
                // standstill (matches vehicles that gate it on motion).
                if (state.speedKmh < 1) return null;
                return gearFactor(state.speedKmh) / 24;
            }
            case 0xa6:
                return this.odometerKm + distanceKm(elapsedSeconds); // odometer
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
