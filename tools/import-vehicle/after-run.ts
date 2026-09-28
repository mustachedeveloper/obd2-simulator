import {ecuPayloads, requestOf} from './responses';
import type {Session} from './session';

// How long the engine ECU kept rejecting requests (7F xx 22) after the
// engine stopped, per recording: from the last answered mode 01 request to
// the last rejection. The phase's real end is seen only when the app kept
// polling until NO DATA came back; the longest of those is the vehicle's
// value, the longest phase seen at all when none ended on record.

const REJECTION = /^7F[0-9A-F]{2}22/;
const NO_DATA = 'NO DATA';

interface Phase {
    ms: number;
    ended: boolean;
}

function phaseOf(session: Session): Phase | null {
    let lastAnswered: number | null = null;
    let from = 0;
    let to = 0;
    let seen = false;
    let ended = false;
    for (const exchange of session.exchanges) {
        if (!requestOf(exchange.c).startsWith('01')) continue;
        const [payload] = ecuPayloads(exchange.c, exchange.r);
        if (payload?.startsWith('41')) {
            lastAnswered = exchange.t;
            continue;
        }
        if (payload && REJECTION.test(payload) && lastAnswered !== null) {
            if (!seen || ended) {
                from = lastAnswered;
                ended = false;
                seen = true;
            }
            to = exchange.t;
        } else if (seen && !ended && exchange.r.includes(NO_DATA)) {
            ended = true;
        }
    }
    return seen ? {ms: to - from, ended} : null;
}

/**
 * The vehicle's `afterRunMs`, or undefined when no recording holds an
 * after-run phase.
 */
export function afterRunMs(sessions: readonly Session[]): number | undefined {
    const phases = sessions.map(phaseOf).filter((phase): phase is Phase => phase !== null);
    if (phases.length === 0) return undefined;
    const ended = phases.filter((phase) => phase.ended);
    const pool = ended.length > 0 ? ended : phases;
    return Math.round(Math.max(...pool.map((phase) => phase.ms)) / 1000) * 1000;
}
