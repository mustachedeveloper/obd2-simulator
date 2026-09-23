import {type DriveCycle, type DriveCyclePlayer, type DrivingState, createDriveCyclePlayer} from './drive-cycle';
import {type SignalFit, type SignalFits, evaluateSignal, resolveSignals} from './signals';
import {AMBIENT_REFERENCE_STATE, type VehicleTraits, resolveTraits} from './traits';
import type {DrivingModel} from './types';

// The default driving cycle: 20s idle → 8s acceleration → cruise at
// ~90 km/h → deceleration, repeating every 96s. Coolant/oil warm up along
// exponential curves, fuel burns down slowly. Deliberately simple and fully
// deterministic given the same jitter stream. Three options make it a
// specific vehicle: `traits` (measured constants), `cycle` (a recorded drive
// that replaces the synthetic one) and `signals` (per-PID fits that replace
// the generic formulas); every other signal is derived from the same
// driving state either way, so the PIDs always agree with each other.

const IDLE_END_S = 20;
const ACCEL_END_S = 28;
const CRUISE_END_S = 88;
const CYCLE_LENGTH_S = 96;

const CRUISE_SPEED_KMH = 90;
const OIL_WARMUP_LAG = 1.6;
const FUEL_BURN_PCT_PER_HOUR = 6;
// PID 0x9D reports fuel in g/s: L/h × density (kg/L) / 3.6. Diesel is denser.
const FUEL_DENSITY_KG_PER_L: Readonly<Record<number, number>> = {4: 0.832};
const GASOLINE_DENSITY_KG_PER_L = 0.745;
// PID 0x9E reports exhaust in kg/h: the air (g/s × 3.6) plus the fuel at stoichiometry.
const EXHAUST_KG_PER_H_PER_AIR_GPS = 3.6 * (1 + 1 / 14.7);
const noJitter = (): number => 0;
// The map-controlled thermostat of the recorded car: once warm, the coolant
// sits ≈ 4 °C under the target while standing and up to 7 °C above it on the
// move, following the speed of the last five minutes (correlation 0.72 with
// the 300 s mean, 0.53 with the instant). Oil does not swing.
const COOLANT_SWING_WINDOW_S = 300;
const COOLANT_SWING_STEP_S = 15;
const COOLANT_SWING_C: readonly (readonly [number, number])[] = [
    [0, -4],
    [20, 2.5],
    [60, 3.5],
    [90, 7],
];
// Exhaust-side sensors lag the drive by tens of seconds: catalyst, EGT and
// DPF temperatures follow the state averaged over the last 45 s.
const THERMAL_PIDS: ReadonlySet<number> = new Set([0x3c, 0x3e, 0x78, 0x79, 0x7c]);
const THERMAL_WINDOW_S = 45;
const THERMAL_STEP_S = 5;

function interpolate(points: readonly (readonly [number, number])[], x: number): number {
    const [first, last] = [points[0], points[points.length - 1]];
    if (!first || !last) return 0;
    if (x <= first[0]) return first[1];
    if (x >= last[0]) return last[1];
    for (let i = 1; i < points.length; i++) {
        const [x0, y0] = points[i - 1] ?? first;
        const [x1, y1] = points[i] ?? last;
        if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
    return last[1];
}

// Wide-band sensors and the commanded ratio read full lean while the
// injectors are shut (fuel cut on overrun): the top of the 0..2 scale.
const LAMBDA_PIDS: ReadonlySet<number> = new Set([0x24, 0x34, 0x44]);
const FUEL_CUT_LAMBDA = 1.99997;
// One-second means, interpolated: "zero" load is anything below half a percent.
const FUEL_CUT_MAX_LOAD_PCT = 0.5;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

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
    /**
     * Reported by PID 0x51 (1 = gasoline, 4 = diesel...).
     */
    fuelType?: number;
    /**
     * Odometer reading at power-on (PID 0xA6 accumulates on top). Overrides
     * `traits.odometerKm`.
     */
    odometerKm?: number;
    /**
     * Hybrid behaviour: the combustion engine stops while the car stands
     * still (rpm, load, airflow, fuel rate 0; manifold at atmospheric;
     * battery voltage instead of alternator voltage).
     */
    engineOffAtStandstill?: boolean;
    /**
     * Measured constants of a specific vehicle; unset ones keep the default.
     */
    traits?: Partial<VehicleTraits>;
    /**
     * A recorded drive replayed in a loop instead of the synthetic cycle.
     * Its samples are used as they are — no jitter is added on top.
     */
    cycle?: DriveCycle;
    /**
     * Per-PID fits from recordings; a fitted PID no longer uses the generic
     * formula. What the cycle replays or the model accumulates (rpm, speed,
     * load, throttle, fuel rate, run time, distances, fuel level, odometer)
     * cannot be fitted and is ignored here.
     */
    signals?: SignalFits;
}

// What the engine-derived sensors read with the combustion engine stopped.
const ENGINE_OFF_VALUES: Readonly<Record<number, number>> = {
    0x0b: 101, // manifold pressure: atmospheric, no vacuum
    0x0e: 0, // timing advance
    0x10: 0, // MAF
    0x42: 12.4, // module voltage: battery, no alternator
    0x5e: 0, // fuel rate
    0x66: 0, // MAF sensors
    0x9d: 0, // engine fuel rate
    0x9e: 0, // exhaust flow
};

// Distance driven since power-on: piecewise integral of the speed profile.
// One full 96s cycle covers 0.1 (accel) + 1.5 (cruise) + 0.1 (decel) km.
const CYCLE_DISTANCE_KM = 1.7;

function syntheticDistanceKm(elapsedSeconds: number): number {
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
    private readonly engineOffAtStandstill: boolean;
    private readonly traits: VehicleTraits;
    private readonly player: DriveCyclePlayer | null;
    private readonly signals: ReadonlyMap<number, SignalFit>;
    // How far the chosen day (traits.ambientC, when given) is from the one the ambient sensor was fitted on;
    // the ambient and intake temperatures move by it.
    private readonly ambientShiftC: number;

    /**
     * @throws if a trait is out of range, the drive cycle or a signal fit is malformed.
     */
    constructor(options: DefaultDrivingModelOptions = {}) {
        this.fuelType = options.fuelType ?? 1;
        this.traits = resolveTraits(options.traits);
        this.odometerKm = options.odometerKm ?? this.traits.odometerKm;
        this.engineOffAtStandstill = options.engineOffAtStandstill ?? false;
        this.player = options.cycle ? createDriveCyclePlayer(options.cycle) : null;
        this.signals = resolveSignals(options.signals);
        const ambient = this.signals.get(0x46);
        this.ambientShiftC =
            ambient && options.traits?.ambientC !== undefined
                ? this.traits.ambientC - evaluateSignal(ambient, AMBIENT_REFERENCE_STATE, noJitter)
                : 0;
    }

    value(pid: number, elapsedSeconds: number, jitter: (amplitude: number) => number): number | null {
        const state = THERMAL_PIDS.has(pid)
            ? this.laggedState(elapsedSeconds, THERMAL_WINDOW_S, THERMAL_STEP_S)
            : this.drivingState(elapsedSeconds, jitter);
        const {coolantStartC, coolantTargetC, coolantWarmupTauS, oilOverCoolantC} = this.traits;
        const warmup = 1 - Math.exp(-elapsedSeconds / coolantWarmupTauS);
        const coolantC = coolantStartC + (coolantTargetC - coolantStartC) * warmup + this.coolantSwingC(elapsedSeconds) * warmup;
        const engineOff = state.rpm === 0 ? ENGINE_OFF_VALUES[pid] : undefined;
        if (engineOff !== undefined) return engineOff;
        if (LAMBDA_PIDS.has(pid) && this.fuelCut(state)) return FUEL_CUT_LAMBDA;
        const fit = this.signals.get(pid);
        if (fit) {
            const fitted = evaluateSignal(fit, state, jitter);
            return pid === 0x46 ? fitted + this.ambientShiftC : fitted;
        }
        switch (pid) {
            case 0x03:
                // Open loop while warming up, closed loop after.
                return warmup > 0.3 ? 2 : 1;
            case 0x07:
                return this.traits.longTermFuelTrimPct + jitter(1); // LTFT B1
            case 0x08:
                return jitter(4); // STFT B2
            case 0x09:
                return 1.5 + jitter(1); // LTFT B2
            case 0x0a:
                return 300 + jitter(6); // fuel pressure
            case 0x12:
                return 4; // secondary air: off / atmosphere
            case 0x13:
                return 0x03; // O2 sensors: bank 1 sensors 1 + 2
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
            case 0x6d:
                return 5000 + state.engineLoadPct * 80 + jitter(100); // rail direct/abs, fuel pressure control
            case 0x24:
                return clamp(1 + jitter(0.05), 0, 2); // O2 S1 lambda
            case 0x25:
                return clamp(1 + jitter(0.03), 0, 2); // O2 S2 lambda
            case 0x34:
                return clamp(1 + jitter(0.05), 0, 2); // O2 S1 lambda (with pump current)
            case 0x2c:
                return state.engineLoadPct > 50 ? 0 : 8 + jitter(2); // commanded EGR
            case 0x2d:
                return jitter(3); // EGR error
            case 0x2e:
                return clamp(5 + state.engineLoadPct * 0.2 + jitter(2), 0, 100); // purge
            case 0x30:
                return this.traits.warmupsSinceClear;
            case 0x31:
                return this.traits.distanceSinceClearKm + this.distanceKm(elapsedSeconds);
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
                return this.fuelRateLph(state, elapsedSeconds);
            case 0x61:
                return clamp(state.engineLoadPct + 5, -125, 130); // demanded torque
            case 0x63:
                return 250; // reference torque (Nm)
            case 0x64:
                return 18; // torque at idle (%)
            case 0x65:
                return state.speedKmh > 0 ? 1 : 0; // aux I/O: automatic transmission in drive
            case 0x66:
                return this.airflowGps(state, jitter); // MAF sensors
            case 0x67:
                return coolantC + jitter(0.5);
            case 0x68:
                return this.traits.intakeTempC + this.ambientShiftC + jitter(1.5); // IAT sensors
            case 0x69:
                return clamp(30 - state.engineLoadPct * 0.2, 0, 100); // EGR packet (commanded)
            case 0x6f:
                return 101 + jitter(0.5); // turbo inlet pressure
            case 0x70:
                // Boost: follows the manifold — vacuum off load, above atmospheric under it.
                return clamp(95 + state.engineLoadPct * 0.6 + jitter(2), 90, 250);
            case 0x71:
                return clamp(state.engineLoadPct * 0.4 + jitter(1), 0, 100); // wastegate / VGT position
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
            case 0x8b:
                return 0; // aftertreatment: no regeneration pending
            case 0x8e:
                return -12 + jitter(1); // friction torque
            case 0x9b:
                return clamp(78 - (elapsedSeconds / 3600) * 0.05, 0, 100); // DEF level
            case 0x9d:
                return (
                    (this.fuelRateLph(state, elapsedSeconds) *
                        (FUEL_DENSITY_KG_PER_L[this.fuelType] ?? GASOLINE_DENSITY_KG_PER_L)) /
                    3.6
                ); // engine fuel rate (g/s)
            case 0x9e:
                return this.airflowGps(state, jitter) * EXHAUST_KG_PER_H_PER_AIR_GPS; // exhaust flow (kg/h)
            case 0xa4: {
                /**
                 * Gear ratio from the same rpm-per-speed table; no data at
                 * standstill (matches vehicles that gate it on motion).
                 */
                if (state.speedKmh < 1) return null;
                return (this.player ? state.rpm / state.speedKmh : gearFactor(state.speedKmh)) / 24;
            }
            case 0xa6:
                return this.odometerKm + this.distanceKm(elapsedSeconds); // odometer
            case 0x04:
                return state.engineLoadPct;
            case 0x05:
                return coolantC + jitter(0.5);
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
                return this.traits.intakeTempC + this.ambientShiftC + jitter(1.5);
            case 0x10:
                return this.airflowGps(state, jitter);
            case 0x11:
                return state.throttlePct;
            case 0x14:
                // Narrow-band O2 oscillating around stoich.
                return clamp(0.45 + jitter(0.25), 0.05, 0.9);
            case 0x2f:
                return clamp(this.traits.fuelLevelPct - (elapsedSeconds / 3600) * FUEL_BURN_PCT_PER_HOUR, 0, 100);
            case 0x33:
                return 101 + jitter(0.3);
            case 0x42:
                return state.rpm > 400 ? this.traits.chargingVoltage + jitter(0.1) : 12.4 + jitter(0.1);
            case 0x46:
                return this.traits.ambientC + jitter(1);
            case 0x51:
                return this.fuelType;
            case 0x5c: {
                // Oil warms slower than coolant and settles a bit hotter.
                const oilWarmup = 1 - Math.exp(-elapsedSeconds / (coolantWarmupTauS * OIL_WARMUP_LAG));
                return coolantStartC + (coolantTargetC + oilOverCoolantC - coolantStartC) * oilWarmup + jitter(0.5);
            }
            case 0x62:
                // Torque roughly tracks load; idles slightly positive.
                return clamp(state.engineLoadPct * 0.9 + jitter(2), -125, 130);
            default:
                return null;
        }
    }

    // Overrun: the engine turns and the car rolls, but the recorded load is
    // zero. Load, not fuel rate: in recordings zero load marks 90 % of the
    // full-lean readings, while the fuel-rate PID lags behind the injectors
    // and marks only 60 %. Only a recorded cycle can show it.
    private fuelCut(state: DrivingState): boolean {
        return this.player !== null && state.engineLoadPct < FUEL_CUT_MAX_LOAD_PCT && state.rpm > 0 && state.speedKmh > 0;
    }

    // Airflow scales with rpm × load; ~2 g/s idle, ~40+ under load.
    private airflowGps(state: DrivingState, jitter: (amplitude: number) => number): number {
        return clamp(2 + (state.rpm / 1000) * (state.engineLoadPct / 8) + jitter(0.5), 0, 300);
    }

    // The driving state averaged over the last `windowS` seconds, sampled every
    // `stepS` (jitter-free): what a slow sensor sees.
    private laggedState(elapsedSeconds: number, windowS: number, stepS: number): DrivingState {
        const moments = [];
        for (let back = 0; back <= windowS; back += stepS) moments.push(Math.max(0, elapsedSeconds - back));
        const states = moments.map((moment) => this.drivingState(moment, noJitter));
        const mean = (pick: (state: DrivingState) => number) => states.reduce((sum, s) => sum + pick(s), 0) / states.length;
        return {
            speedKmh: mean((s) => s.speedKmh),
            rpm: mean((s) => s.rpm),
            throttlePct: mean((s) => s.throttlePct),
            engineLoadPct: mean((s) => s.engineLoadPct),
        };
    }

    private coolantSwingC(elapsedSeconds: number): number {
        return interpolate(
            COOLANT_SWING_C,
            this.laggedState(elapsedSeconds, COOLANT_SWING_WINDOW_S, COOLANT_SWING_STEP_S).speedKmh,
        );
    }

    private fuelRateLph(state: DrivingState, elapsedSeconds: number): number {
        return this.player?.fuelRateAt(elapsedSeconds) ?? clamp(0.5 + state.engineLoadPct * 0.12 + state.speedKmh * 0.04, 0, 60);
    }

    private distanceKm(elapsedSeconds: number): number {
        return this.player ? this.player.distanceKmAt(elapsedSeconds) : syntheticDistanceKm(elapsedSeconds);
    }

    private drivingState(elapsedSeconds: number, jitter: (amplitude: number) => number): DrivingState {
        if (this.player) {
            const recorded = this.player.stateAt(elapsedSeconds);
            const engineOff = recorded.speedKmh < 1 && this.engineOffAtStandstill;
            return engineOff ? {speedKmh: 0, rpm: 0, throttlePct: 0, engineLoadPct: 0} : recorded;
        }
        const idleRpm = this.traits.idleRpm;
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

        if (speed < 1 && this.engineOffAtStandstill) return {speedKmh: 0, rpm: 0, throttlePct: 0, engineLoadPct: 0};
        const rpm = speed < 1 ? idleRpm + jitter(40) : idleRpm + speed * gearFactor(speed);
        return {
            speedKmh: clamp(speed, 0, 240),
            rpm: clamp(rpm, 0, 8000),
            throttlePct: clamp(throttle + jitter(2), 0, 100),
            engineLoadPct: clamp(throttle * 0.85 + jitter(4), 0, 100),
        };
    }
}
