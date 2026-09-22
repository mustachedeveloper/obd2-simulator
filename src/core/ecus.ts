import {toHex} from './j1979';
import {FUNCTIONAL_REQUEST_HEADER} from './at-commands';

// CAN addressing of the simulated ECUs. Internally every ECU is known by
// its 11-bit response id (7E8 = engine, 7E9.. = the others); on 29-bit
// vehicles (ISO 15765-4 CAN 29/500, ELM protocol 7/9) the same ECU prints
// as 18DAF1xx and is addressed as 18DAxxF1.

export const ENGINE_ECU_ID = '7E8';
const FUNCTIONAL_HEADER_29 = '18DB33F1';
const RESPONSE_BASE_11 = 0x7e8;
// 7E8 ↔ source address 10, 7E9 ↔ 18, ... (engine 0x10, transmission 0x18).
const SOURCE_BASE_29 = 0x10;
const SOURCE_STEP_29 = 8;

export const ADDITIONAL_ECU_ID = /^7E[9-F]$/;

export const isExtended = (protocol: string): boolean => protocol === '7' || protocol === '9';

const ecuIndex = (id11: string): number => Number.parseInt(id11, 16) - RESPONSE_BASE_11;

// 29-bit source addresses a vehicle declares, by 11-bit ECU id; the others
// follow the 0x10 + 8·n rule.
export type SourceAddresses = Readonly<Record<string, number>>;

export const sourceAddressOf = (id11: string, sources: SourceAddresses = {}): number =>
    sources[id11] ?? SOURCE_BASE_29 + ecuIndex(id11) * SOURCE_STEP_29;

// The header an ECU's responses carry on the wire under the given addressing.
export function ecuHeader(id11: string, extended: boolean, sources: SourceAddresses = {}): string {
    if (!extended) return id11;
    return `18DAF1${toHex(sourceAddressOf(id11, sources))}`;
}

// Header bytes as printed with spaces on ('18 DA F1 10'; 11-bit ids stay '7E8').
export function headerText(id11: string, extended: boolean, spaces: boolean, sources: SourceAddresses = {}): string {
    const header = ecuHeader(id11, extended, sources);
    return extended && spaces ? header.match(/.{2}/g)!.join(' ') : header;
}

// Which 11-bit ECU id a physical request header addresses; null when the
// header is functional (everyone) or addresses nobody.
function physicalTarget(
    requestHeader: string,
    ids: readonly string[],
    sources: SourceAddresses,
): {ecu: string | null; functional: boolean} {
    if (requestHeader === FUNCTIONAL_REQUEST_HEADER || requestHeader === FUNCTIONAL_HEADER_29)
        return {ecu: null, functional: true};
    const physical11 = /^7E([0-7])$/.exec(requestHeader);
    if (physical11)
        return {ecu: `7E${(Number.parseInt(physical11[1] ?? '0', 16) + 8).toString(16).toUpperCase()}`, functional: false};
    const physical29 = /^18DA([0-9A-F]{2})F1$/.exec(requestHeader);
    if (physical29) {
        const target = Number.parseInt(physical29[1] ?? '00', 16);
        return {ecu: ids.find((id) => sourceAddressOf(id, sources) === target) ?? null, functional: false};
    }
    return {ecu: null, functional: false};
}

export interface AddressingState {
    requestHeader: string;
    receiveFilter: string | null;
    extended: boolean;
    sources?: SourceAddresses;
}

// Applies the request header (ATSH) and receive filter (ATCRA) to a list of
// responding ECU ids: functional → everyone, physical → that ECU only, an
// unknown header → nobody; the filter compares against the printed header.
export function addressedEcus(ids: readonly string[], state: AddressingState): string[] {
    const target = physicalTarget(state.requestHeader, ids, state.sources ?? {});
    if (!target.functional && target.ecu === null) return [];
    return ids.filter(
        (id) =>
            (target.functional || id === target.ecu) &&
            (state.receiveFilter === null || ecuHeader(id, state.extended, state.sources) === state.receiveFilter),
    );
}
