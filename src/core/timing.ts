import type {AdapterPersona, AdaptiveTimingMode, LinkState} from './types';

// Response latency model: every command costs the persona's base (+ jitter);
// OBD requests additionally sit through the ATST wait window unless the
// adapter honors the response-count hint and the hint was satisfied.

export const ELM_DEFAULT_TIMEOUT_HEX = '32';
const TIMEOUT_UNIT_MS = 4;

// How much of the ATST window an adapter with adaptive timing still waits.
// AT1 is modelled as the plain window so measurements stay predictable;
// AT2 is the aggressive mode.
export const ADAPTIVE_TIMING_FACTORS: Readonly<Record<AdaptiveTimingMode, number>> = {0: 1, 1: 1, 2: 0.5};

export function timeoutWindowMs(state: LinkState, persona: AdapterPersona): number {
    const units = Number.parseInt(state.timeoutHex, 16);
    if (!Number.isFinite(units)) return 0;
    const factor = persona.adaptiveTiming ? ADAPTIVE_TIMING_FACTORS[state.adaptiveTiming] : 1;
    return Math.round(units * TIMEOUT_UNIT_MS * factor);
}

export type CommandKind = 'at' | 'obd' | 'unknown';

export interface WaitInput {
    kind: CommandKind;
    // Trailing response-count digit of the request, null when absent.
    hint: number | null;
    // Number of ECU responses the vehicle produced (0 → NO DATA).
    responders: number;
}

export function waitMsFor(input: WaitInput, state: LinkState, persona: AdapterPersona): number {
    if (input.kind !== 'obd') return 0;
    const satisfied =
        persona.honorsResponseHint && input.hint !== null && input.responders > 0 && input.hint <= input.responders;
    return satisfied ? 0 : timeoutWindowMs(state, persona);
}
