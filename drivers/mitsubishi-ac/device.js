'use strict';

const Homey = require('homey');
const EchonetLite = require('../../lib/EchonetLite');
const {
  EPC,
  POWER,
  MODE_TO_BYTE,
  MODE_FROM_BYTE,
  FAN_TO_BYTE,
  FAN_FROM_BYTE,
  vaneToCommands,
  vaneFromBytes,
  signed8,
} = require('../../lib/constants');

const TEMP_MIN = 16;
const TEMP_MAX = 31;
const OUTDOOR_UNDEFINED = 126; // EPC 0xBE, 0x7E means "no value"

module.exports = class MitsubishiDevice extends Homey.Device {

  async onInit() {
    this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));
    this.registerCapabilityListener('ac_mode', this.onCapabilityMode.bind(this));
    this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
    this.registerCapabilityListener('fan_speed', this.onCapabilityFanSpeed.bind(this));
    this.registerCapabilityListener('vane_vertical', this.onCapabilityVane.bind(this));

    await this.poll().catch((err) => this.error('Initial poll failed:', err.message));
    this._startPolling();

    this.log('Mitsubishi AC device initialised at', this.getSetting('ip'));
  }

  get ip() {
    return this.getSetting('ip');
  }

  _startPolling() {
    this._stopPolling();
    const seconds = Number(this.getSetting('poll_interval')) || 60;
    this._pollTimer = this.homey.setInterval(() => {
      this.poll().catch((err) => this.error('Poll failed:', err.message));
    }, seconds * 1000);
  }

  _stopPolling() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Read the full state of the air conditioner in a single ECHONET Get and
   * reflect it onto Homey capabilities.
   */
  async poll() {
    const ip = this.ip;
    if (!ip) return;

    let response;
    try {
      response = await EchonetLite.get(ip, [
        EPC.OPERATION_STATUS,
        EPC.OPERATION_MODE,
        EPC.TARGET_TEMPERATURE,
        EPC.ROOM_TEMPERATURE,
        EPC.OUTDOOR_TEMPERATURE,
        EPC.FAN_SPEED,
        EPC.AUTO_DIRECTION,
        EPC.SWING_MODE,
        EPC.VANE_VERTICAL,
      ]);
    } catch (err) {
      await this.setUnavailable('Air conditioner is unreachable').catch(() => {});
      throw err;
    }

    // Index properties that actually returned data (pdc > 0).
    const edt = {};
    for (const p of response.properties) {
      if (p.pdc > 0) edt[p.epc] = p.edt;
    }

    await this._set('onoff', edt[EPC.OPERATION_STATUS] && edt[EPC.OPERATION_STATUS][0] === POWER.ON);
    await this._set('ac_mode', edt[EPC.OPERATION_MODE] && MODE_FROM_BYTE[edt[EPC.OPERATION_MODE][0]]);
    await this._set('target_temperature', edt[EPC.TARGET_TEMPERATURE] && edt[EPC.TARGET_TEMPERATURE][0]);
    await this._set('measure_temperature', edt[EPC.ROOM_TEMPERATURE] && signed8(edt[EPC.ROOM_TEMPERATURE][0]));
    await this._set('fan_speed', edt[EPC.FAN_SPEED] && FAN_FROM_BYTE[edt[EPC.FAN_SPEED][0]]);

    if (edt[EPC.OUTDOOR_TEMPERATURE]) {
      const outdoor = signed8(edt[EPC.OUTDOOR_TEMPERATURE][0]);
      await this._set('measure_temperature.outdoor', outdoor === OUTDOOR_UNDEFINED ? null : outdoor);
    }

    const vane = vaneFromBytes(edt[EPC.AUTO_DIRECTION], edt[EPC.SWING_MODE], edt[EPC.VANE_VERTICAL]);
    await this._set('vane_vertical', vane);

    if (!this.getAvailable()) await this.setAvailable().catch(() => {});
  }

  /**
   * Set a capability only when we have a usable value. Callers pass `undefined`
   * (never `false`) when the device returned no data for a property, so a real
   * `false` from the onoff property is still applied.
   */
  async _set(capability, value) {
    if (value === undefined || value === null) return;
    if (this.getCapabilityValue(capability) === value) return;
    await this.setCapabilityValue(capability, value).catch((err) => {
      this.error(`Failed to set ${capability}:`, err.message);
    });
  }

  // --- Capability listeners (Homey -> air conditioner) ---------------------

  async onCapabilityOnoff(value) {
    await EchonetLite.setProperty(this.ip, EPC.OPERATION_STATUS, Buffer.from([value ? POWER.ON : POWER.OFF]));
  }

  async onCapabilityMode(value) {
    const byte = MODE_TO_BYTE[value];
    if (byte === undefined) throw new Error(`Unsupported mode: ${value}`);
    await EchonetLite.setProperty(this.ip, EPC.OPERATION_MODE, Buffer.from([byte]));
    // Selecting a mode implicitly powers the unit on.
    if (!this.getCapabilityValue('onoff')) {
      await this.setCapabilityValue('onoff', true).catch(() => {});
    }
  }

  async onCapabilityTargetTemperature(value) {
    const temp = Math.max(TEMP_MIN, Math.min(TEMP_MAX, Math.round(value)));
    await EchonetLite.setProperty(this.ip, EPC.TARGET_TEMPERATURE, Buffer.from([temp]));
    // The protocol only carries whole degrees; reflect the rounded value back.
    if (temp !== value) await this.setCapabilityValue('target_temperature', temp).catch(() => {});
  }

  async onCapabilityFanSpeed(value) {
    const byte = FAN_TO_BYTE[value];
    if (byte === undefined) throw new Error(`Unsupported fan speed: ${value}`);
    await EchonetLite.setProperty(this.ip, EPC.FAN_SPEED, Buffer.from([byte]));
  }

  async onCapabilityVane(value) {
    const commands = vaneToCommands(value);
    if (!commands.length) throw new Error(`Unsupported vane position: ${value}`);
    for (const cmd of commands) {
      // eslint-disable-next-line no-await-in-loop
      await EchonetLite.setProperty(this.ip, cmd.epc, cmd.edt);
    }
  }

  // --- Lifecycle -----------------------------------------------------------

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('poll_interval')) {
      this._startPolling();
    }
    if (changedKeys.includes('ip')) {
      // Re-poll against the new address on the next tick (after settings save).
      this.homey.setTimeout(() => this.poll().catch((err) => this.error(err.message)), 500);
    }
  }

  async onDeleted() {
    this._stopPolling();
  }

  async onUninit() {
    this._stopPolling();
  }

};
