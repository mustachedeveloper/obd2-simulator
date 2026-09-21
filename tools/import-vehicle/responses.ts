// Turns the text an ELM327 printed (headers off) back into the payload each
// ECU sent: echo and SEARCHING... removed, ISO-TP segments reassembled in
// sequence and cut to the announced length. Single frames come back as
// printed — a padding adapter appends AA bytes that only a caller who knows
// the expected length can tell from data.

const HEX_LINE = /^[0-9A-F]+$/;
const LENGTH_LINE = /^[0-9A-F]{3}$/;
const SEGMENT_LINE = /^([0-9A-F]):([0-9A-F]+)$/;
const SEQUENCE_MODULO = 16;

export const normalizeCommand = (command: string): string => command.replace(/\s+/g, '').toUpperCase();

/**
 * Command without the trailing response-count hint ('010C 1' → '010C').
 */
export function requestOf(command: string): string {
    const [request = ''] = command.trim().toUpperCase().split(/\s+/);
    return request;
}

function dataLines(command: string, response: string): string[] {
    const echo = normalizeCommand(command);
    return response
        .split(/\r\n?|\n/)
        .map((line) => line.trim().toUpperCase())
        .filter((line) => line.length > 0 && line !== '>' && normalizeCommand(line) !== echo && !line.startsWith('SEARCHING'));
}

/**
 * The byte a multi-frame response's last segment is filled with beyond the
 * announced length ('AA'), or null when this response shows none.
 */
export function framePaddingOf(command: string, response: string): string | null {
    const lines = dataLines(command, response);
    const announced = LENGTH_LINE.test(lines[0] ?? '') ? Number.parseInt(lines[0] ?? '', 16) * 2 : 0;
    const segments = lines.slice(1).map((line) => SEGMENT_LINE.exec(line)?.[2] ?? null);
    // One responder only, so the segments are unambiguous.
    if (announced === 0 || segments.includes(null)) return null;
    const tail = segments.join('').slice(announced);
    const [first = ''] = tail.match(/^../) ?? [];
    return tail.length > 0 && tail === first.repeat(tail.length / 2) ? first : null;
}

/**
 * Hex payload per responding ECU, in the order printed. Empty when the
 * adapter reported an error or the response is incomplete.
 */
export function ecuPayloads(command: string, response: string): string[] {
    const lines = dataLines(command, response);
    const payloads: string[] = [];
    let index = 0;
    while (index < lines.length) {
        const line = lines[index] ?? '';
        if (LENGTH_LINE.test(line)) {
            const wanted = Number.parseInt(line, 16) * 2;
            let body = '';
            let sequence = 0;
            index++;
            // Segments must count 0, 1, 2 … (F wraps to 0): clones interleave
            // the segments of two ECUs, which would splice their bytes.
            while (body.length < wanted) {
                const segment = SEGMENT_LINE.exec(lines[index] ?? '');
                if (!segment || Number.parseInt(segment[1] ?? '', 16) !== sequence % SEQUENCE_MODULO) return [];
                body += segment[2] ?? '';
                sequence++;
                index++;
            }
            // Anything still numbered belongs to no response we can trust.
            if (SEGMENT_LINE.test(lines[index] ?? '')) return [];
            payloads.push(body.slice(0, wanted));
            continue;
        }
        if (!HEX_LINE.test(line) || line.length % 2 !== 0) return [];
        payloads.push(line);
        index++;
    }
    return payloads;
}
