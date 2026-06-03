'use strict';

const Homey = require('homey');
const EchonetLite = require('../../lib/EchonetLite');

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

module.exports = class MitsubishiDriver extends Homey.Driver {

  async onInit() {
    this.log('Mitsubishi AC driver initialised');
  }

  /**
   * Resolve Homey's own LAN IPv4 address, stripping any port or CIDR suffix.
   * Used to scope the ECHONET discovery to the correct interface/subnet.
   */
  async _getLocalAddress() {
    try {
      const address = await this.homey.cloud.getLocalAddress();
      // getLocalAddress can return "192.168.1.10", "192.168.1.10:443" or "192.168.1.10/24"
      return String(address).split(/[:/]/)[0];
    } catch (err) {
      this.error('Could not determine local address:', err.message);
      return undefined;
    }
  }

  /** Probe an IP, returning a pairable device object or throwing a helpful error. */
  async _buildDeviceForIp(rawIp) {
    const ip = String(rawIp || '').trim();
    const m = ip.match(IPV4_RE);
    if (!m || m.slice(1).some((o) => Number(o) > 255)) {
      throw new Error(`"${ip}" is not a valid IPv4 address.`);
    }

    // Confirm something at this IP answers ECHONET (read operation status).
    try {
      await EchonetLite.get(ip, [0x80], { retries: 2, timeout: 2500 });
    } catch (err) {
      throw new Error(`No air conditioner answered at ${ip}. Check the IP and that ECHONET Lite is enabled on the adapter.`);
    }

    // Try to read a stable identification number from the node profile object.
    let id = `mitsubishi-${ip}`;
    try {
      const res = await EchonetLite.get(ip, [0x83], { deoj: EchonetLite.NODE_PROFILE_EOJ, retries: 1, timeout: 2000 });
      const prop = res.properties.find((p) => p.epc === 0x83 && p.pdc > 1);
      if (prop) id = prop.edt.toString('hex');
    } catch (err) {
      // identification is best-effort; fall back to the IP-based id
    }

    return {
      name: `Mitsubishi AC (${ip})`,
      data: { id },
      settings: { ip, poll_interval: 60 },
    };
  }

  async onPair(session) {
    // Automatic discovery via ECHONET multicast/broadcast.
    session.setHandler('list_devices', async () => {
      const localAddress = await this._getLocalAddress();
      this.log('Discovering Mitsubishi air conditioners (local address:', localAddress, ')');

      const seen = new Set();
      const nodes = await EchonetLite.discover({
        timeout: 5000,
        localAddress,
        onResponse: (frame, rinfo) => {
          // Diagnostic: log every ECHONET responder, AC or not.
          if (!seen.has(rinfo.address)) {
            seen.add(rinfo.address);
            this.log(`ECHONET response from ${rinfo.address} (SEOJ ${frame.seoj.toString('hex')})`);
          }
        },
      });

      this.log(`Discovery found ${nodes.length} air conditioner(s); ${seen.size} ECHONET responder(s) total`);

      return nodes.map((node) => ({
        name: `Mitsubishi AC (${node.ip})`,
        data: { id: node.identifier || `mitsubishi-${node.ip}` },
        settings: { ip: node.ip, poll_interval: 60 },
      }));
    });

    // Manual entry by IP address (unicast — works when multicast does not).
    session.setHandler('manual_add', async (ip) => {
      this.log('Manual add requested for', ip);
      return this._buildDeviceForIp(ip);
    });
  }

};
