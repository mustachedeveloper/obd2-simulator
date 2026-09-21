// Recordings carry the real VIN, device ids and install ids. Generated
// files keep what describes the vehicle TYPE (manufacturer, model, year,
// plant — VIN positions 1-11) and nothing that identifies the vehicle.

const VIN_LENGTH = 17;
const SERIAL_LENGTH = 6;
const SERIAL = /^[0-9]{6}$/;

/**
 * @throws if the VIN is malformed or the synthetic serial equals the real one.
 */
export function syntheticVin(recordedVin: string, serial: string): string {
    if (recordedVin.length !== VIN_LENGTH)
        throw new Error(`recorded VIN must have ${VIN_LENGTH} characters, got ${recordedVin.length}`);
    if (!SERIAL.test(serial)) throw new Error(`VIN serial must be ${SERIAL_LENGTH} digits, got "${serial}"`);
    if (recordedVin.endsWith(serial)) throw new Error('synthetic VIN serial equals the recorded serial');
    return recordedVin.slice(0, VIN_LENGTH - SERIAL_LENGTH) + serial;
}

/**
 * Last line of defence before anything is written.
 *
 * @throws if the output contains any recorded secret (case-insensitive).
 */
export function assertNoLeak(output: string, secrets: readonly string[]): void {
    const haystack = output.toUpperCase();
    const leaked = secrets.filter((secret) => secret.length > 0 && haystack.includes(secret.toUpperCase()));
    // The message deliberately does not repeat the secret.
    if (leaked.length > 0) throw new Error(`privacy leak: generated output contains ${leaked.length} recorded identifier(s)`);
}
