import type {EcuProfile, ReadinessBytes, VehicleProfile} from './types';
import {ADDITIONAL_ECU_ID, ENGINE_ECU_ID, sourceAddressOf, type SourceAddresses} from './ecus';
import type {VehicleInfoSource} from './mode09';

// A VehicleProfile → the ECUs the engine serves, validated. Pure: the
// engine keeps the DTC lists and the driving model, these are the static
// facts about each module.

// Mode 04 answer of a module that does not declare one.
const CLEAR_REPLY_FOR = {empty: 'positive', reject: 'reject', none: 'none'} as const;
const ZERO_READINESS: ReadinessBytes = [0, 0, 0];

// One ECU as the engine serves it. The engine ECU carries the DTC lists and
// the whole profile; the others answer their declared subset.
export interface Ecu {
    id: string;
    isEngine: boolean;
    pids: ReadonlySet<number>;
    readinessSinceClear: ReadinessBytes;
    readinessThisDriveCycle: ReadinessBytes;
    dtcReply: 'list' | 'empty' | 'reject' | 'none';
    clearReply: NonNullable<EcuProfile['clearReply']>;
    info: VehicleInfoSource;
}

function validateEcuProfile(ecu: EcuProfile): EcuProfile {
    if (!ADDITIONAL_ECU_ID.test(ecu.id)) {
        throw new Error(`additional ECU id "${ecu.id}" must be 7E9..7EF (7E8 is the engine ECU)`);
    }
    return ecu;
}

// Declared 29-bit source addresses by ECU id; every ECU's effective address
// (declared or by the 0x10 + 8·n rule) must be a byte of its own.
export function sourceAddressesOf(profile: VehicleProfile): SourceAddresses {
    const declared = [
        [ENGINE_ECU_ID, profile.sourceAddress] as const,
        ...(profile.additionalEcus ?? []).map((ecu) => [ecu.id, ecu.sourceAddress] as const),
    ];
    const sources = Object.fromEntries(declared.filter((pair): pair is readonly [string, number] => pair[1] !== undefined));
    const effective = declared.map(([id]) => sourceAddressOf(id, sources));
    for (const address of effective) {
        if (!Number.isInteger(address) || address < 0 || address > 0xff)
            throw new Error(`sourceAddress must be a byte (0..255), got ${address}`);
    }
    if (new Set(effective).size !== effective.length) throw new Error('sourceAddress: two ECUs share a 29-bit source address');
    return sources;
}

export function validateFramePadding(padding: number | undefined): void {
    if (padding !== undefined && !(Number.isInteger(padding) && padding >= 0 && padding <= 0xff)) {
        throw new Error(`framePadding must be a byte (0..255), got ${padding}`);
    }
}

function engineEcu(profile: VehicleProfile): Ecu {
    const performance = {infotype: profile.ignition === 'spark' ? 0x08 : 0x0b, counters: profile.performanceCounters};
    return {
        id: ENGINE_ECU_ID,
        isEngine: true,
        /**
         * Status/readiness PIDs are always served in addition to the signal set.
         */
        pids: new Set([0x01, 0x41, ...profile.pids]),
        readinessSinceClear: profile.readinessSinceClear,
        readinessThisDriveCycle: profile.readinessThisDriveCycle,
        dtcReply: 'list',
        clearReply: 'positive',
        info: {
            id: ENGINE_ECU_ID,
            vin: profile.vin,
            calibrationId: profile.calibrationId,
            cvn: profile.cvn,
            performance,
            name: profile.ecuName,
        },
    };
}

function additionalEcu(ecu: EcuProfile): Ecu {
    const readiness = ecu.readiness ?? ZERO_READINESS;
    return {
        id: ecu.id,
        isEngine: false,
        /**
         * Status PIDs come with mode 01; an ECU without any signal PID
         * (a module that only rejects DTC requests) stays silent on 01.
         */
        pids: new Set(ecu.pids.length > 0 ? [0x01, 0x41, ...ecu.pids] : []),
        readinessSinceClear: readiness,
        readinessThisDriveCycle: readiness,
        dtcReply: ecu.dtcReply ?? 'empty',
        clearReply: ecu.clearReply ?? CLEAR_REPLY_FOR[ecu.dtcReply ?? 'empty'],
        info: {id: ecu.id, calibrationId: ecu.calibrationId, cvn: ecu.cvn, name: ecu.name},
    };
}

/**
 * The engine ECU first, then the profile's other modules.
 *
 * @throws if an additional ECU id is not 7E9..7EF.
 */
export function vehicleEcus(profile: VehicleProfile): Ecu[] {
    return [engineEcu(profile), ...(profile.additionalEcus ?? []).map((ecu) => additionalEcu(validateEcuProfile(ecu)))];
}
