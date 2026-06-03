'use strict';

const dgram = require('dgram');

const ECHONET_PORT = 3610;
const MULTICAST_ADDR = '224.0.23.0';

// ECHONET Lite frame header
const EHD1 = 0x10;
const EHD2 = 0x81; // Format 1 (specified message format)

// ECHONET Lite service codes (ESV)
const ESV = {
  SETI: 0x60, // write, no response
  SETC: 0x61, // write, response required
  GET: 0x62, // read
  INF_REQ: 0x63,
  SET_RES: 0x71,
  GET_RES: 0x72,
  INF: 0x73,
  SETI_SNA: 0x50,
  SETC_SNA: 0x51,
  GET_SNA: 0x52,
};

// ECHONET Lite objects (EOJ)
const CONTROLLER_EOJ = Buffer.from([0x05, 0xFF, 0x01]); // Controller, instance 1
const AC_EOJ = Buffer.from([0x01, 0x30, 0x01]); // Home air conditioner, instance 1
const NODE_PROFILE_EOJ = Buffer.from([0x0E, 0xF0, 0x01]); // Node profile object

let tidCounter = 0; // sequential, wraps at 16 bits
function nextTid() {
  tidCounter = (tidCounter + 1) & 0xFFFF;
  return tidCounter;
}

/**
 * Build a Format-1 ECHONET Lite frame.
 * @param {{tid:number, seoj:Buffer, deoj:Buffer, esv:number, properties:Array<{epc:number, edt?:Buffer}>}} opts
 * @returns {Buffer}
 */
function buildFrame({ tid, seoj, deoj, esv, properties }) {
  const head = Buffer.alloc(12);
  head[0] = EHD1;
  head[1] = EHD2;
  head.writeUInt16BE(tid & 0xFFFF, 2);
  seoj.copy(head, 4);
  deoj.copy(head, 7);
  head[10] = esv;
  head[11] = properties.length; // OPC

  const parts = [head];
  for (const p of properties) {
    const edt = p.edt || Buffer.alloc(0);
    parts.push(Buffer.from([p.epc, edt.length]), edt);
  }
  return Buffer.concat(parts);
}

/**
 * Parse a Format-1 ECHONET Lite frame.
 * @param {Buffer} buf
 * @returns {null|{tid:number, seoj:Buffer, deoj:Buffer, esv:number, opc:number, properties:Array<{epc:number, pdc:number, edt:Buffer}>}}
 */
function parseFrame(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] !== EHD1 || buf[1] !== EHD2) return null;

  const tid = buf.readUInt16BE(2);
  const seoj = buf.slice(4, 7);
  const deoj = buf.slice(7, 10);
  const esv = buf[10];
  const opc = buf[11];

  let offset = 12;
  const properties = [];
  for (let i = 0; i < opc; i += 1) {
    if (offset + 2 > buf.length) break;
    const epc = buf[offset];
    const pdc = buf[offset + 1];
    offset += 2;
    const edt = buf.slice(offset, offset + pdc);
    offset += pdc;
    properties.push({ epc, pdc, edt });
  }
  return { tid, seoj, deoj, esv, opc, properties };
}

/**
 * ECHONET Lite transport.
 *
 * A single UDP socket is bound to port 3610 (the standard ECHONET port) and
 * shared for the lifetime of the app. This is required because Mitsubishi
 * adapters send their replies *to* port 3610, not back to the request's source
 * port — listening on an ephemeral port means responses are never received.
 *
 * Replies are dispatched to in-flight requests by transaction id; multicast
 * discovery responses are fanned out to registered discovery listeners.
 */
class EchonetLite {

  constructor() {
    this.ESV = ESV;
    this.AC_EOJ = AC_EOJ;
    this.NODE_PROFILE_EOJ = NODE_PROFILE_EOJ;
    this.buildFrame = buildFrame;
    this.parseFrame = parseFrame;

    this._socket = null;
    this._binding = null;
    this._pending = new Map(); // tid -> { ip, resolve, reject, timer }
    this._discoveryListeners = new Set();
  }

  /** Lazily bind the shared socket on first use. */
  _ensureSocket() {
    if (this._socket) return Promise.resolve(this._socket);
    if (this._binding) return this._binding;

    this._binding = new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
      sock.on('error', (err) => {
        // Surface bind errors to the caller waiting on _binding; otherwise log.
        if (!this._socket) {
          this._binding = null;
          reject(err);
        }
      });

      sock.bind(ECHONET_PORT, () => {
        try { sock.setBroadcast(true); } catch (e) { /* not permitted */ }
        try { sock.addMembership(MULTICAST_ADDR); } catch (e) { /* no multicast iface */ }
        this._socket = sock;
        resolve(sock);
      });
    });
    return this._binding;
  }

  _onMessage(msg, rinfo) {
    const frame = parseFrame(msg);
    if (!frame) return;

    // Fan out to discovery listeners (multicast can yield many responders).
    for (const listener of this._discoveryListeners) {
      try { listener(frame, rinfo); } catch (e) { /* listener errors are non-fatal */ }
    }

    // Resolve a matching in-flight unicast request.
    const pending = this._pending.get(frame.tid);
    if (pending && rinfo.address === pending.ip) {
      this._pending.delete(frame.tid);
      clearTimeout(pending.timer);
      pending.resolve(frame);
    }
  }

  /**
   * Send a single ECHONET request to a unicast address and await the matching
   * response (matched by transaction id). Retries on timeout.
   *
   * @param {string} ip
   * @param {number} esv
   * @param {Array<{epc:number, edt?:Buffer}>} properties
   * @param {{timeout?:number, retries?:number, deoj?:Buffer}} [opts]
   * @returns {Promise<object>} parsed response frame
   */
  async request(ip, esv, properties, opts = {}) {
    const timeout = opts.timeout || 3000;
    const retries = opts.retries != null ? opts.retries : 2;
    const deoj = opts.deoj || AC_EOJ;
    const sock = await this._ensureSocket();

    const attempt = () => new Promise((resolve, reject) => {
      const tid = nextTid();
      const frame = buildFrame({ tid, seoj: CONTROLLER_EOJ, deoj, esv, properties });

      const timer = setTimeout(() => {
        this._pending.delete(tid);
        reject(new Error(`ECHONET request to ${ip} timed out`));
      }, timeout);

      this._pending.set(tid, { ip, resolve, reject, timer });

      sock.send(frame, ECHONET_PORT, ip, (err) => {
        if (err) {
          this._pending.delete(tid);
          clearTimeout(timer);
          reject(err);
        }
      });
    });

    let chain = attempt();
    for (let i = 0; i < retries; i += 1) {
      chain = chain.catch(() => attempt());
    }
    return chain;
  }

  /**
   * Read one or more properties from a device.
   * @param {string} ip
   * @param {number[]} epcs
   * @param {object} [opts]
   */
  get(ip, epcs, opts) {
    const properties = epcs.map((epc) => ({ epc, edt: Buffer.alloc(0) }));
    return this.request(ip, ESV.GET, properties, opts);
  }

  /**
   * Write a single property and await confirmation.
   * @param {string} ip
   * @param {number} epc
   * @param {Buffer} edt
   * @param {object} [opts]
   */
  async setProperty(ip, epc, edt, opts) {
    const res = await this.request(ip, ESV.SETC, [{ epc, edt }], opts);
    if (res.esv === ESV.SETC_SNA || res.esv === ESV.SETI_SNA) {
      throw new Error(`Device rejected write for EPC 0x${epc.toString(16)}`);
    }
    return res;
  }

  /**
   * Discover Mitsubishi home air conditioners on the LAN by querying the
   * node-profile self-node instance list (EPC 0xD6) via multicast and the
   * subnet broadcast address.
   *
   * @param {{timeout?:number, localAddress?:string}} [opts]
   * @returns {Promise<Array<{ip:string, identifier:(string|null)}>>}
   */
  async discover(opts = {}) {
    const timeout = opts.timeout || 5000;
    const localAddress = opts.localAddress;
    const sock = await this._ensureSocket();

    const found = new Map();
    const listener = (frame, rinfo) => {
      if (typeof opts.onResponse === 'function') {
        try { opts.onResponse(frame, rinfo); } catch (e) { /* diagnostic only */ }
      }
      let isAirConditioner = false;
      let identifier = null;
      for (const p of frame.properties) {
        if (p.epc === 0xD6 && p.edt.length >= 1) {
          const count = p.edt[0];
          for (let i = 0; i < count; i += 1) {
            const o = 1 + i * 3;
            if (p.edt[o] === 0x01 && p.edt[o + 1] === 0x30) isAirConditioner = true;
          }
        }
        if (p.epc === 0x83 && p.edt.length > 1) identifier = p.edt.toString('hex');
      }
      if (isAirConditioner) {
        const existing = found.get(rinfo.address) || {};
        found.set(rinfo.address, { ip: rinfo.address, identifier: identifier || existing.identifier || null });
      }
    };
    this._discoveryListeners.add(listener);

    const tid = nextTid();
    const frame = buildFrame({
      tid,
      seoj: CONTROLLER_EOJ,
      deoj: NODE_PROFILE_EOJ,
      esv: ESV.GET,
      properties: [
        { epc: 0xD6, edt: Buffer.alloc(0) }, // self-node instance list
        { epc: 0x83, edt: Buffer.alloc(0) }, // identification number
      ],
    });

    if (localAddress) {
      try { sock.setMulticastInterface(localAddress); } catch (e) { /* ignore */ }
    }
    sock.send(frame, ECHONET_PORT, MULTICAST_ADDR, () => {});
    if (localAddress) {
      const broadcast = localAddress.replace(/\.\d+$/, '.255');
      sock.send(frame, ECHONET_PORT, broadcast, () => {});
    }

    await new Promise((resolve) => setTimeout(resolve, timeout));
    this._discoveryListeners.delete(listener);
    return [...found.values()];
  }

}

// Export a single shared instance: one socket bound to 3610 for the whole app.
module.exports = new EchonetLite();
