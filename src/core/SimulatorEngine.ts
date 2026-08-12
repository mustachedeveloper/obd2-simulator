import type {DrivingModel, DtcStatus, SimulatorLogger, VehicleProfile} from './types';
import {DefaultDrivingModel} from './DefaultDrivingModel';
import {mulberry32} from './prng';
import {PID_ENCODERS, asciiBytes, encodeDtc, isoTpResponse, maskBytesFor, toHex} from './j1979';
import {GASOLINE_PROFILE} from '../profiles/gasoline';

// Wire-level fake vehicle + ELM327 adapter in one object: feed it the exact
// ASCII commands a real adapter receives, get back the exact text a real
// adapter prints (echo behavior, ISO-TP long-response framing, support
// masks). Transports (in-process link, TCP server) only move these strings.
//
// Simulated surface: AT handshake, mode 01 (profile PID set + status PIDs
// 0x01/0x41), mode 02 freeze frame, modes 03/07/0A + 04 DTC lifecycle,
// mode 06 monitor tests, mode 09 vehicle info.

export interface SimulatorEngineOptions {
    profile?: VehicleProfile;
    model?: DrivingModel;
    // Injectable clock for deterministic tests; defaults to Date.now.
    now?: () => number;
    seed?: number;
    logger?: SimulatorLogger;
}

export class SimulatorEngine {
    readonly profile: VehicleProfile;
    private readonly model: DrivingModel;
    private readonly now: () => number;
    private readonly random: () => number;
    private readonly startedAt: number;
    private readonly logger: SimulatorLogger;
    private readonly supportedPids: Set<number>;
    private readonly monitorMids: Set<number>;
    private echoEnabled = true;
    private stored: string[];
    private pending: string[];
    private permanent: string[];
    // Sensor snapshot captured when the first stored DTC appears; served via
    // mode 02 until a mode 04 clear. pid → encoded data bytes.
    private freezeFrame: Map<number, number[]> | null = null;

    constructor(options: SimulatorEngineOptions = {}) {
        this.profile = options.profile ?? GASOLINE_PROFILE;
        this.model = options.model ?? new DefaultDrivingModel();
        this.now = options.now ?? Date.now;
        this.random = mulberry32(options.seed ?? 42);
        this.startedAt = this.now();
        this.logger = options.logger ?? {};
        // Status/readiness PIDs are always served in addition to the
        // profile's signal set.
        this.supportedPids = new Set([0x01, 0x41, ...this.profile.pids]);
        this.monitorMids = new Set(this.profile.monitorTests.map((t) => t.mid));
        this.stored = [...(this.profile.storedDtcs ?? [])];
        this.pending = [...(this.profile.pendingDtcs ?? [])];
        this.permanent = [...(this.profile.permanentDtcs ?? [])];
        if (this.stored.length > 0) this.captureFreezeFrame();
    }

    // Plants a fault code at runtime; stored codes also snapshot the freeze
    // frame the first time one appears.
    injectDtc(code: string, status: DtcStatus = 'stored'): void {
        const list = status === 'pending' ? this.pending : status === 'permanent' ? this.permanent : this.stored;
        if (list.includes(code)) return;
        if (status === 'pending') this.pending = [...this.pending, code];
        else if (status === 'permanent') this.permanent = [...this.permanent, code];
        else {
            this.stored = [...this.stored, code];
            this.captureFreezeFrame();
        }
        this.logger.info?.(`injected ${code} (${status})`);
    }

    get storedDtcs(): readonly string[] {
        return this.stored;
    }

    // Handles one full command and returns the payload the adapter would
    // print (without the trailing '>' prompt — the transport appends that).
    // When echo is on (before ATE0) the command itself is prefixed, exactly
    // like real hardware.
    handleCommand(rawCommand: string): string {
        // Real ELM327s ignore whitespace inside commands ('010C 1' ≡ '010C1').
        const command = rawCommand.replace(/\s+/g, '').toUpperCase();
        const echoWasEnabled = this.echoEnabled;
        const payload = this.respond(command);
        this.logger.debug?.(`${command} -> ${payload}`);
        return echoWasEnabled ? `${command}\r${payload}` : payload;
    }

    private respond(command: string): string {
        if (command.startsWith('AT')) return this.respondAt(command);
        if (command === '03') return this.respondDtcRead(0x43, this.stored);
        if (command === '07') return this.respondDtcRead(0x47, this.pending);
        if (command === '0A') return this.respondDtcRead(0x4a, this.permanent);
        if (command === '04') return this.respondDtcClear();
        if (command.startsWith('01')) return this.respondMode01(command);
        if (command.startsWith('02')) return this.respondMode02(command);
        if (command.startsWith('06')) return this.respondMode06(command);
        if (command.startsWith('09')) return this.respondMode09(command);
        return '?';
    }

    private respondAt(command: string): string {
        switch (command) {
            case 'ATZ':
                this.echoEnabled = true;
                return 'ELM327 v1.5';
            case 'ATE0':
                this.echoEnabled = false;
                return 'OK';
            case 'ATE1':
                this.echoEnabled = true;
                return 'OK';
            case 'ATRV': {
                const rpm = this.modelValue(0x0c) ?? 0;
                const base = rpm > 400 ? 14.1 : 12.4;
                return `${(base + this.jitter(0.15)).toFixed(1)}V`;
            }
            case 'ATDPN':
                // Auto-detected ISO 15765-4 CAN 11/500 — the common case.
                return 'A6';
            default:
                // ATL0/ATS0/ATSP0/ATSH.../ATCRA... — acknowledged, no effect.
                return 'OK';
        }
    }

    // Handles single and multi-PID (batch) requests, plus the 0x00/0x20/...
    // supported-PID mask queries. A trailing odd hex digit is the
    // expected-response-count hint — parsed and ignored, like real hardware.
    private respondMode01(command: string): string {
        let pidsHex = command.slice(2);
        if (pidsHex.length % 2 === 1) pidsHex = pidsHex.slice(0, -1);
        if (pidsHex.length === 0) return 'NO DATA';

        let payload = '';
        for (let i = 0; i < pidsHex.length; i += 2) {
            const pid = Number.parseInt(pidsHex.slice(i, i + 2), 16);
            if (Number.isNaN(pid)) continue;

            if (pid % 0x20 === 0 && pid <= 0xa0) {
                payload += `${toHex(pid)}${maskBytesFor(this.supportedPids, pid)}`;
                continue;
            }
            if (pid === 0x01) {
                const count = Math.min(this.stored.length, 0x7f);
                const a = count > 0 ? 0x80 | count : 0;
                const [b, c, d] = this.profile.readinessSinceClear;
                payload += `01${toHex(a)}${toHex(b)}${toHex(c)}${toHex(d)}`;
                continue;
            }
            if (pid === 0x41) {
                const [b, c, d] = this.profile.readinessThisDriveCycle;
                payload += `4100${toHex(b)}${toHex(c)}${toHex(d)}`;
                continue;
            }

            const data = this.encodeCurrentValue(pid);
            if (!data) continue;
            payload += `${toHex(pid)}${data.map(toHex).join('')}`;
        }
        return payload.length > 0 ? `41${payload}` : 'NO DATA';
    }

    // Requests are '02 <pid> 00'; only frame 0 exists. PID 00 serves the
    // support mask of the snapshot, PID 02 the DTC that froze the frame.
    private respondMode02(command: string): string {
        const snapshot = this.freezeFrame;
        if (!snapshot || this.stored.length === 0) return 'NO DATA';
        if (command.slice(4, 6) !== '00') return 'NO DATA';
        const pid = Number.parseInt(command.slice(2, 4), 16);
        if (Number.isNaN(pid)) return 'NO DATA';

        if (pid % 0x20 === 0 && pid <= 0xa0) {
            const ids = new Set([...snapshot.keys(), 0x02]);
            return `42${toHex(pid)}00${maskBytesFor(ids, pid)}`;
        }
        if (pid === 0x02) {
            const pair = encodeDtc(this.stored[0]);
            if (!pair) return 'NO DATA';
            return `420200${toHex(pair[0])}${toHex(pair[1])}`;
        }
        const data = snapshot.get(pid);
        if (!data) return 'NO DATA';
        return `42${toHex(pid)}00${data.map(toHex).join('')}`;
    }

    // Mode 06 — serves the profile's monitor test records: mask queries from
    // their MID set, one 9-byte record per (mid, tid) on request.
    private respondMode06(command: string): string {
        const mid = Number.parseInt(command.slice(2, 4), 16);
        if (Number.isNaN(mid)) return 'NO DATA';
        if (mid % 0x20 === 0 && mid <= 0xa0) {
            return `46${toHex(mid)}${maskBytesFor(this.monitorMids, mid)}`;
        }
        const records = this.profile.monitorTests.filter((t) => t.mid === mid);
        if (records.length === 0) return 'NO DATA';
        const body = records
            .map(
                (t) =>
                    `${toHex(t.mid)}${toHex(t.tid)}${toHex(t.uasId)}` +
                    `${toHex(Math.floor(t.value / 256))}${toHex(t.value % 256)}` +
                    `${toHex(Math.floor(t.min / 256))}${toHex(t.min % 256)}` +
                    `${toHex(Math.floor(t.max / 256))}${toHex(t.max % 256)}`,
            )
            .join('');
        return `46${body}`;
    }

    // Mode 09 — vehicle information, printed in the ELM327 ISO-TP multi-frame
    // format when the payload exceeds a single CAN frame.
    private respondMode09(command: string): string {
        let infoHex = command.slice(2);
        if (infoHex.length % 2 === 1) infoHex = infoHex.slice(0, -1);
        switch (infoHex) {
            case '02':
                return isoTpResponse([0x49, 0x02, 0x01, ...asciiBytes(this.profile.vin)]);
            case '04':
                return isoTpResponse([0x49, 0x04, 0x01, ...asciiBytes(this.profile.calibrationId.padEnd(16, '\0'))]);
            case '06': {
                const cvn = this.profile.cvn.match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? [];
                return isoTpResponse([0x49, 0x06, 0x01, ...cvn]);
            }
            case '08':
            case '0B': {
                const wanted = this.profile.ignition === 'spark' ? '08' : '0B';
                if (infoHex !== wanted) return 'NO DATA';
                const counters = this.profile.performanceCounters;
                const bytes = counters.flatMap((value) => [Math.floor(value / 256) & 0xff, value & 0xff]);
                return isoTpResponse([0x49, Number.parseInt(wanted, 16), counters.length, ...bytes]);
            }
            case '0A': {
                const name = this.profile.ecuName.padEnd(20, '\0');
                return isoTpResponse([0x49, 0x0a, 0x01, ...asciiBytes(name)]);
            }
            default:
                return 'NO DATA';
        }
    }

    private respondDtcRead(responseHeader: number, codes: readonly string[]): string {
        const pairs = codes.map(encodeDtc).filter((pair): pair is [number, number] => pair !== null);
        const body = pairs.map(([a, b]) => `${toHex(a)}${toHex(b)}`).join('');
        // CAN framing: count byte then the code pairs.
        return `${toHex(responseHeader)}${toHex(pairs.length)}${body}`;
    }

    // Mode 04 clears stored + pending codes and the freeze frame; permanent
    // codes survive (only the vehicle erases them after a verified repair).
    private respondDtcClear(): string {
        this.stored = [];
        this.pending = [];
        this.freezeFrame = null;
        return '44';
    }

    private captureFreezeFrame(): void {
        if (this.freezeFrame) return;
        const snapshot = new Map<number, number[]>();
        for (const pid of this.profile.pids) {
            const data = this.encodeCurrentValue(pid);
            if (data) snapshot.set(pid, data);
        }
        this.freezeFrame = snapshot;
    }

    private encodeCurrentValue(pid: number): number[] | null {
        if (!this.supportedPids.has(pid)) return null;
        const encoder = PID_ENCODERS[pid];
        if (!encoder) return null;
        const value = this.modelValue(pid);
        if (value === null) return null;
        return encoder.encode(value);
    }

    private modelValue(pid: number): number | null {
        const elapsedSeconds = Math.max(0, (this.now() - this.startedAt) / 1000);
        return this.model.value(pid, elapsedSeconds, (amplitude) => this.jitter(amplitude));
    }

    private jitter(amplitude: number): number {
        return (this.random() * 2 - 1) * amplitude;
    }
}
