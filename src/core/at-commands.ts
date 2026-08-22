import type {AdapterPersona, AdaptiveTimingMode, LinkState} from './types';
import {ELM_DEFAULT_TIMEOUT_HEX} from './timing';

// AT / ST command table. Anything not listed answers '?' exactly like real
// hardware, so an adapter probe gets honest negatives (ATIGN on a clone,
// STI on a non-STN chip, typos).

export interface AtContext {
    persona: AdapterPersona;
    state: LinkState;
    voltage: () => string;
    ignitionOn: () => boolean;
}

export interface AtOutcome {
    response: string;
    state: LinkState;
}

export const FUNCTIONAL_REQUEST_HEADER = '7DF';
const AUTO_PROTOCOL = '0';
const AUTO_DETECTED_PROTOCOL = '6';

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

// Accepted and acknowledged without any simulated effect (line feeds,
// spaces, memory, CAN formatting/flow-control, ...).
const ACKNOWLEDGED_ONLY = /^AT(L[01]|S[01]|M[01]|R[01]|V[01]|AL|NL|PC|CAF[01]|CFC[01]|FCSH[0-9A-F]{3,8}|FCSD([0-9A-F]{2}){1,5}|FCSM[0-2]|TP[0-9A-C])$/;

export function resetLinkState(persona: AdapterPersona): LinkState {
    return {
        echo: true,
        headers: false,
        timeoutHex: persona.defaultTimeoutHex ?? ELM_DEFAULT_TIMEOUT_HEX,
        adaptiveTiming: 1,
        receiveFilter: null,
        requestHeader: FUNCTIONAL_REQUEST_HEADER,
        protocol: AUTO_PROTOCOL,
    };
}

const ok = (state: LinkState): AtOutcome => ({response: 'OK', state});
const unknown = (state: LinkState): AtOutcome => ({response: '?', state});

function describeProtocol(state: LinkState): string {
    if (state.protocol === AUTO_PROTOCOL) return `AUTO, ${PROTOCOL_NAMES[AUTO_DETECTED_PROTOCOL]}`;
    return PROTOCOL_NAMES[state.protocol] ?? 'AUTO';
}

export function handleAtCommand(command: string, context: AtContext): AtOutcome {
    const {persona, state} = context;
    switch (command) {
        case 'ATZ':
        case 'ATWS':
            return {response: persona.banner, state: resetLinkState(persona)};
        case 'ATD':
            return ok(resetLinkState(persona));
        case 'ATI':
            return {response: persona.banner, state};
        case 'AT@1':
            return {response: persona.description, state};
        case 'AT@2':
            return {response: persona.identifier ?? '?', state};
        case 'ATE0':
            return ok({...state, echo: false});
        case 'ATE1':
            return ok({...state, echo: true});
        case 'ATH0':
            return ok({...state, headers: false});
        case 'ATH1':
            return ok({...state, headers: true});
        case 'ATCRA':
            return ok({...state, receiveFilter: null});
        case 'ATRV':
            return {response: context.voltage(), state};
        case 'ATDP':
            return {response: describeProtocol(state), state};
        case 'ATDPN':
            return {response: state.protocol === AUTO_PROTOCOL ? `A${AUTO_DETECTED_PROTOCOL}` : state.protocol, state};
        case 'ATIGN':
            if (!persona.ignitionMonitor) return unknown(state);
            return {response: context.ignitionOn() ? 'ON' : 'OFF', state};
        case 'ATCS':
            return {response: 'T:00 R:00 F:00', state};
        default:
            return handleParameterized(command, context);
    }
}

function handleParameterized(command: string, context: AtContext): AtOutcome {
    const {persona, state} = context;
    const timeout = /^ATST([0-9A-F]{2})$/.exec(command);
    if (timeout) {
        const hex = timeout[1] === '00' ? (persona.defaultTimeoutHex ?? ELM_DEFAULT_TIMEOUT_HEX) : timeout[1];
        return ok({...state, timeoutHex: hex});
    }
    const adaptive = /^ATAT([012])$/.exec(command);
    if (adaptive) return ok({...state, adaptiveTiming: Number.parseInt(adaptive[1], 10) as AdaptiveTimingMode});
    const protocol = /^ATSP([0-9A-C])$/.exec(command);
    if (protocol) return ok({...state, protocol: protocol[1]});
    const header = /^ATSH([0-9A-F]{3}|[0-9A-F]{6}|[0-9A-F]{8})$/.exec(command);
    if (header) return ok({...state, requestHeader: header[1]});
    const filter = /^ATCRA([0-9A-F]{3}|[0-9A-F]{8})$/.exec(command);
    if (filter) return ok({...state, receiveFilter: filter[1]});
    if (ACKNOWLEDGED_ONLY.test(command)) return ok(state);
    return unknown(state);
}

// STN-only commands (OBDLink). Non-STN personas answer '?'.
export function handleStCommand(command: string, persona: AdapterPersona): string | null {
    if (command === 'STI') return persona.stn?.firmware ?? '?';
    if (command === 'STDI') return persona.stn?.deviceId ?? '?';
    return null;
}
