import type {AdapterPersona, AdaptiveTimingMode, CanProtocol, LinkState} from './types';
import {ELM_DEFAULT_TIMEOUT_HEX} from './timing';

// AT / ST command table. Anything not listed answers '?' exactly like real
// hardware, so an adapter probe gets honest negatives (ATIGN on a clone,
// STI on a non-STN chip, typos). Handlers return output LINES; the engine
// joins them with the link's line ending.

export interface AtContext {
    persona: AdapterPersona;
    state: LinkState;
    // Protocol the vehicle speaks — what auto mode detects.
    vehicleProtocol: CanProtocol;
    voltage: () => string;
    ignitionOn: () => boolean;
}

export interface AtOutcome {
    lines: string[];
    state: LinkState;
}

export const FUNCTIONAL_REQUEST_HEADER = '7DF';
export const AUTO_PROTOCOL = '0';

const PROTOCOL_NAMES: Readonly<Record<string, string>> = {
    '1': 'SAE J1850 PWM',
    '2': 'SAE J1850 VPW',
    '3': 'ISO 9141-2',
    '4': 'ISO 14230-4 (KWP 5BAUD)',
    '5': 'ISO 14230-4 (KWP FAST)',
    '6': 'ISO 15765-4 (CAN 11/500)',
    '7': 'ISO 15765-4 (CAN 29/500)',
    '8': 'ISO 15765-4 (CAN 11/250)',
    '9': 'ISO 15765-4 (CAN 29/250)',
    A: 'SAE J1939 (CAN 29/250)',
    B: 'USER1 CAN',
    C: 'USER2 CAN',
};

// Accepted and acknowledged without any simulated effect (memory, CAN
// formatting/flow-control, ...).
const ACKNOWLEDGED_ONLY =
    /^AT(M[01]|R[01]|V[01]|AL|NL|CAF[01]|CFC[01]|FCSH[0-9A-F]{3,8}|FCSD([0-9A-F]{2}){1,5}|FCSM[0-2]|TP[0-9A-C])$/;

export function resetLinkState(persona: AdapterPersona): LinkState {
    return {
        echo: true,
        headers: false,
        spaces: persona.defaultSpaces,
        linefeeds: false,
        searched: false,
        timeoutHex: persona.defaultTimeoutHex ?? ELM_DEFAULT_TIMEOUT_HEX,
        adaptiveTiming: 1,
        receiveFilter: null,
        requestHeader: FUNCTIONAL_REQUEST_HEADER,
        protocol: AUTO_PROTOCOL,
    };
}

const ok = (state: LinkState): AtOutcome => ({lines: ['OK'], state});
const unknown = (state: LinkState): AtOutcome => ({lines: ['?'], state});
const say = (text: string, state: LinkState): AtOutcome => ({lines: [text], state});

// Reset banner: genuine parts print a blank line first; some clones glue
// junk ('OK') in front of the version string instead.
export function bannerLines(persona: AdapterPersona): string[] {
    const banner = `${persona.bannerPrefix ?? ''}${persona.banner}`;
    return (persona.bannerBlankLine ?? true) ? ['', banner] : [banner];
}

function describeProtocol(state: LinkState, vehicleProtocol: CanProtocol): string {
    if (state.protocol === AUTO_PROTOCOL) return `AUTO, ${PROTOCOL_NAMES[vehicleProtocol]}`;
    return PROTOCOL_NAMES[state.protocol] ?? 'AUTO';
}

export function handleAtCommand(command: string, context: AtContext): AtOutcome {
    const {persona, state} = context;
    switch (command) {
        case 'ATZ':
        case 'ATWS':
            return {lines: bannerLines(persona), state: resetLinkState(persona)};
        case 'ATD':
            return ok(resetLinkState(persona));
        case 'ATI':
            return say(persona.banner, state);
        case 'AT@1':
            return say(persona.description, state);
        case 'AT@2':
            return say(persona.identifier ?? '?', state);
        case 'ATE0':
            return ok({...state, echo: false});
        case 'ATE1':
            return ok({...state, echo: true});
        case 'ATH0':
            return ok({...state, headers: false});
        case 'ATH1':
            return ok({...state, headers: true});
        case 'ATS0':
            return ok({...state, spaces: false});
        case 'ATS1':
            return ok({...state, spaces: true});
        case 'ATL0':
            return ok({...state, linefeeds: false});
        case 'ATL1':
            return ok({...state, linefeeds: true});
        case 'ATCRA':
            return ok({...state, receiveFilter: null});
        case 'ATPC':
            return ok({...state, searched: false});
        case 'ATRV':
            return say(context.voltage(), state);
        case 'ATDP':
            return say(describeProtocol(state, context.vehicleProtocol), state);
        case 'ATDPN':
            return say(state.protocol === AUTO_PROTOCOL ? `A${context.vehicleProtocol}` : state.protocol, state);
        case 'ATIGN':
            if (!persona.ignitionMonitor) return unknown(state);
            return say(context.ignitionOn() ? 'ON' : 'OFF', state);
        case 'ATCS':
            return say('T:00 R:00 F:00', state);
        default:
            return handleParameterized(command, context);
    }
}

function handleParameterized(command: string, context: AtContext): AtOutcome {
    const {persona, state} = context;
    const timeout = /^ATST([0-9A-F]{2})$/.exec(command);
    if (timeout) {
        const digits = timeout[1] ?? '00';
        const hex = digits === '00' ? (persona.defaultTimeoutHex ?? ELM_DEFAULT_TIMEOUT_HEX) : digits;
        return ok({...state, timeoutHex: hex});
    }
    const adaptive = /^ATAT([012])$/.exec(command);
    if (adaptive) return ok({...state, adaptiveTiming: Number.parseInt(adaptive[1] ?? '1', 10) as AdaptiveTimingMode});
    const protocol = /^ATSP([0-9A-C])$/.exec(command);
    if (protocol) return ok({...state, protocol: protocol[1] ?? AUTO_PROTOCOL, searched: false});
    const header = /^ATSH([0-9A-F]{3}|[0-9A-F]{6}|[0-9A-F]{8})$/.exec(command);
    if (header) return ok({...state, requestHeader: header[1] ?? state.requestHeader});
    const filter = /^ATCRA([0-9A-F]{3}|[0-9A-F]{8})$/.exec(command);
    if (filter) return ok({...state, receiveFilter: filter[1] ?? null});
    if (ACKNOWLEDGED_ONLY.test(command)) return ok(state);
    return unknown(state);
}

// STN-only commands (OBDLink). Non-STN personas answer '?'.
export function handleStCommand(command: string, persona: AdapterPersona): string | null {
    if (command === 'STI') return persona.stn?.firmware ?? '?';
    if (command === 'STDI') return persona.stn?.deviceId ?? '?';
    return null;
}
