import type {EcuResponse} from './framing';
import {asciiBytes, maskBytesFor} from './j1979';
import {hexToBytes} from './framing';

// Mode 09 vehicle information, per ECU: the engine ECU serves VIN, calibration
// id, CVN, in-use performance counters and its name; other ECUs only what
// their profile declares. Infotype 00 advertises exactly that set.

export interface VehicleInfoSource {
    id: string;
    vin?: string;
    calibrationId?: string;
    cvn?: string;
    // Infotype 08 (spark) or 0B (compression) counters.
    performance?: {infotype: number; counters: readonly number[]};
    name?: string;
}

const SERVICE = 0x49;
const CALIBRATION_ID_BYTES = 16;
const ECU_NAME_BYTES = 20;
const INFOTYPE = {vin: 0x02, calibrationId: 0x04, cvn: 0x06, name: 0x0a} as const;

const padded = (text: string, length: number): number[] => asciiBytes(text.padEnd(length, '\0'));

function servedInfotypes(source: VehicleInfoSource): Set<number> {
    const served = new Set<number>();
    if (source.vin) served.add(INFOTYPE.vin);
    if (source.calibrationId) served.add(INFOTYPE.calibrationId);
    if (source.cvn) served.add(INFOTYPE.cvn);
    if (source.performance) served.add(source.performance.infotype);
    if (source.name) served.add(INFOTYPE.name);
    return served;
}

function payloadFor(source: VehicleInfoSource, infotype: number): number[] | null {
    const served = servedInfotypes(source);
    if (served.size === 0) return null;
    if (infotype === 0x00) return [SERVICE, 0x00, ...hexToBytes(maskBytesFor(served, 0x00))];
    if (!served.has(infotype)) return null;
    switch (infotype) {
        case INFOTYPE.vin:
            return [SERVICE, infotype, 0x01, ...asciiBytes(source.vin!)];
        case INFOTYPE.calibrationId:
            return [SERVICE, infotype, 0x01, ...padded(source.calibrationId!, CALIBRATION_ID_BYTES)];
        case INFOTYPE.cvn:
            return [SERVICE, infotype, 0x01, ...hexToBytes(source.cvn!)];
        case INFOTYPE.name:
            return [SERVICE, infotype, 0x01, ...padded(source.name!, ECU_NAME_BYTES)];
        default: {
            const {counters} = source.performance!;
            const words = counters.flatMap((value) => [Math.floor(value / 256) & 0xff, value & 0xff]);
            return [SERVICE, infotype, counters.length, ...words];
        }
    }
}

export function mode09Responses(sources: readonly VehicleInfoSource[], infotypeHex: string): EcuResponse[] {
    const infotype = Number.parseInt(infotypeHex, 16);
    if (infotypeHex.length !== 2 || Number.isNaN(infotype)) return [];
    return sources.flatMap((source) => {
        const payload = payloadFor(source, infotype);
        return payload ? [{ecu: source.id, payload}] : [];
    });
}
