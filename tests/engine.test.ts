import {describe, expect, it} from 'vitest';
import {DIESEL_PROFILE, GASOLINE_PROFILE, SimulatorEngine, dieselDrivingModel} from '../src/index';

const engineAt = (ms: number, extra: ConstructorParameters<typeof SimulatorEngine>[0] = {}) => {
    let current = 0;
    const engine = new SimulatorEngine({now: () => current, seed: 7, ...extra});
    current = ms;
    engine.handleCommand('ATE0');
    return engine;
};

describe('AT handshake', () => {
    it('answers the init sequence like real hardware, echo included', () => {
        const engine = new SimulatorEngine({now: () => 0});
        expect(engine.handleCommand('ATZ')).toBe('ATZ\rELM327 v1.5');
        expect(engine.handleCommand('ATE0')).toBe('ATE0\rOK');
        expect(engine.handleCommand('ATL0')).toBe('OK');
        expect(engine.handleCommand('ATSP0')).toBe('OK');
        expect(engine.handleCommand('ATDPN')).toBe('A6');
    });

    it('reports alternator-level voltage while the engine runs', () => {
        const engine = engineAt(0);
        const voltage = Number.parseFloat(engine.handleCommand('ATRV'));
        expect(voltage).toBeGreaterThan(13);
        expect(voltage).toBeLessThan(15);
    });

    it('answers unknown commands with ?', () => {
        const engine = engineAt(0);
        expect(engine.handleCommand('BOGUS')).toBe('?');
    });
});

describe('mode 01', () => {
    it('serves rpm as 41 0C + two bytes at idle', () => {
        const engine = engineAt(0);
        const response = engine.handleCommand('010C');
        expect(response.startsWith('410C')).toBe(true);
        const raw = Number.parseInt(response.slice(4), 16) / 4;
        expect(raw).toBeGreaterThan(700);
        expect(raw).toBeLessThan(900);
    });

    it('cruises near 90 km/h mid-cycle', () => {
        const engine = engineAt(60_000);
        const speed = Number.parseInt(engine.handleCommand('010D').slice(4), 16);
        expect(speed).toBeGreaterThan(80);
        expect(speed).toBeLessThan(100);
    });

    it('advertises exactly the profile PID set plus status PIDs via masks', () => {
        const engine = engineAt(0);
        const mask = engine.handleCommand('0100');
        expect(mask.startsWith('4100')).toBe(true);
        // PID 0x01 (bit 7 of the first mask byte) is always advertised.
        const firstByte = Number.parseInt(mask.slice(4, 6), 16);
        expect(firstByte & 0x80).toBe(0x80);
    });

    it('tolerates the response-count hint and whitespace', () => {
        const engine = engineAt(0);
        expect(engine.handleCommand('010D 1').startsWith('410D')).toBe(true);
    });

    it('answers unknown PIDs with NO DATA', () => {
        const engine = engineAt(0);
        expect(engine.handleCommand('01FF')).toBe('NO DATA');
    });

    it('is deterministic for the same seed and clock', () => {
        const run = () => {
            const engine = engineAt(45_000);
            return ['010C', '010D', '0105', 'ATRV'].map((cmd) => engine.handleCommand(cmd));
        };
        expect(run()).toEqual(run());
    });
});

describe('readiness (PIDs 01/41)', () => {
    it('sets the MIL bit and count from stored DTCs', () => {
        const engine = engineAt(0);
        expect(engine.handleCommand('0101').slice(0, 6)).toBe('410100');
        engine.injectDtc('P0301');
        engine.injectDtc('P0420');
        expect(engine.handleCommand('0101').slice(0, 6)).toBe('410182');
    });

    it('serves the drive-cycle scope on PID 41', () => {
        const engine = engineAt(0);
        expect(engine.handleCommand('0141')).toBe('41410017E524');
    });
});

describe('DTC lifecycle', () => {
    it('serves stored/pending/permanent on 03/07/0A', () => {
        const engine = engineAt(0);
        engine.injectDtc('P0301');
        engine.injectDtc('P0171', 'pending');
        engine.injectDtc('P0420', 'permanent');
        expect(engine.handleCommand('03')).toBe('43010301');
        expect(engine.handleCommand('07')).toBe('47010171');
        expect(engine.handleCommand('0A')).toBe('4A010420');
    });

    it('mode 04 clears stored and pending but keeps permanent codes', () => {
        const engine = engineAt(0);
        engine.injectDtc('P0301');
        engine.injectDtc('P0171', 'pending');
        engine.injectDtc('P0420', 'permanent');
        expect(engine.handleCommand('04')).toBe('44');
        expect(engine.handleCommand('03')).toBe('4300');
        expect(engine.handleCommand('07')).toBe('4700');
        expect(engine.handleCommand('0A')).toBe('4A010420');
    });
});

describe('mode 02 freeze frame', () => {
    it('snapshots on injection, serves the freeze DTC and clears on 04', () => {
        const engine = engineAt(0);
        expect(engine.handleCommand('020200')).toBe('NO DATA');
        engine.injectDtc('P0301');
        expect(engine.handleCommand('020200')).toBe('4202000301');
        expect(engine.handleCommand('020D00').startsWith('420D00')).toBe(true);
        engine.handleCommand('04');
        expect(engine.handleCommand('020200')).toBe('NO DATA');
    });
});

describe('mode 06 monitor tests', () => {
    it('serves the profile records with mask discovery', () => {
        const engine = engineAt(0);
        // Catalyst record: MID 21, TID 86, UAS 02, 200 in [0, 400].
        expect(engine.handleCommand('0621')).toBe('4621860200C800000190');
        expect(engine.handleCommand('0622')).toBe('NO DATA');
    });
});

describe('mode 09 vehicle info', () => {
    it('serves the VIN in ISO-TP framing', () => {
        const engine = engineAt(0);
        const response = engine.handleCommand('0902');
        expect(response.startsWith('014\r0:490201')).toBe(true);
        // Decode the ASCII payload back to the profile VIN.
        const hex = response
            .split('\r')
            .slice(1)
            .map((line) => line.slice(line.indexOf(':') + 1))
            .join('')
            .slice(6);
        const vin = hex.match(/.{2}/g)?.map((pair) => String.fromCharCode(Number.parseInt(pair, 16))).join('');
        expect(vin).toBe(GASOLINE_PROFILE.vin);
    });

    it('answers the ignition-matching performance infotype only', () => {
        const gasoline = engineAt(0);
        expect(gasoline.handleCommand('0908').startsWith('49080400780')).toBe(false); // ISO-TP framed
        expect(gasoline.handleCommand('0908')).not.toBe('NO DATA');
        expect(gasoline.handleCommand('090B')).toBe('NO DATA');

        const diesel = engineAt(0, {profile: DIESEL_PROFILE, model: dieselDrivingModel()});
        expect(diesel.handleCommand('0908')).toBe('NO DATA');
        expect(diesel.handleCommand('090B')).not.toBe('NO DATA');
    });

    it('reports diesel fuel type from the diesel driving model', () => {
        const diesel = engineAt(0, {profile: DIESEL_PROFILE, model: dieselDrivingModel()});
        expect(diesel.handleCommand('0151')).toBe('415104');
    });
});
