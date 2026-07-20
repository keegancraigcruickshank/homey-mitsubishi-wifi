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
    // Devices paired before thermostat_mode existed don't get it from the
    // manifest automatically — add it so Homey's HomeKit bridge (and HomeKitty)
    // can expose on/off + mode. HomeKitty only offers "auto" when it's absent.
    if (!this.hasCapability('thermostat_mode')) {
      await this.addCapability('thermostat_mode').catch((err) => this.error('addCapability thermostat_mode:', err.message));
    }

    this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));
    this.registerCapabilityListener('ac_mode', this.onCapabilityMode.bind(this));
    this.registerCapabilityListener('thermostat_mode', this.onCapabilityThermostatMode.bind(this));
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
    await this._syncThermostatMode();
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
    await this._syncThermostatMode({ onoff: value });
  }

  async onCapabilityMode(value) {
    const byte = MODE_TO_BYTE[value];
    if (byte === undefined) throw new Error(`Unsupported mode: ${value}`);
    // A powered-off unit ignores a bare operation-mode write, so power it on
    // first when needed, then set the mode.
    if (!this.getCapabilityValue('onoff')) {
      await EchonetLite.setProperty(this.ip, EPC.OPERATION_STATUS, Buffer.from([POWER.ON]));
      await this.setCapabilityValue('onoff', true).catch(() => {});
    }
    await EchonetLite.setProperty(this.ip, EPC.OPERATION_MODE, Buffer.from([byte]));
    await this._syncThermostatMode({ onoff: true, acMode: value });
  }

  /**
   * `thermostat_mode` is the standard capability Homey's HomeKit bridge maps to
   * the thermostat's Heating/Cooling State. HomeKit models power as part of the
   * mode ("off" is a state, not a separate switch), so this listener drives both
   * onoff and ac_mode. It is the single mode picker shown on the Homey device
   * screen and the capability HomeKit maps. ac_mode is hidden from the device UI
   * (uiComponent: null) but kept as the richer 5-mode capability the dashboard
   * widgets drive, so Dry/Fan stay available there.
   */
  async onCapabilityThermostatMode(value) {
    if (value === 'off') {
      await EchonetLite.setProperty(this.ip, EPC.OPERATION_STATUS, Buffer.from([POWER.OFF]));
      await this.setCapabilityValue('onoff', false).catch(() => {});
      return;
    }
    const byte = MODE_TO_BYTE[value];
    if (byte === undefined) throw new Error(`Unsupported thermostat mode: ${value}`);
    // A powered-off unit ignores a bare operation-mode write, so explicitly
    // power it on first, then set the mode. HomeKit has no separate power
    // switch — choosing heat/cool/auto must start the unit.
    if (!this.getCapabilityValue('onoff')) {
      await EchonetLite.setProperty(this.ip, EPC.OPERATION_STATUS, Buffer.from([POWER.ON]));
      await this.setCapabilityValue('onoff', true).catch(() => {});
    }
    await EchonetLite.setProperty(this.ip, EPC.OPERATION_MODE, Buffer.from([byte]));
    await this.setCapabilityValue('ac_mode', value).catch(() => {});
  }

  /**
   * Reflect the current power + ac_mode state onto `thermostat_mode`. HomeKit's
   * thermostat only models heat/cool/auto/off; `dry` and `fan` have no
   * equivalent, so they surface as `auto`. When called from a capability
   * listener the framework has not yet stored the new value, so callers pass the
   * incoming value explicitly via the overrides.
   */
  async _syncThermostatMode({ onoff, acMode } = {}) {
    const on = onoff !== undefined ? onoff : this.getCapabilityValue('onoff');
    const mode = acMode !== undefined ? acMode : this.getCapabilityValue('ac_mode');
    let value;
    if (!on) value = 'off';
    else if (mode === 'heat' || mode === 'cool' || mode === 'auto') value = mode;
    else value = 'auto';
    await this._set('thermostat_mode', value);
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
